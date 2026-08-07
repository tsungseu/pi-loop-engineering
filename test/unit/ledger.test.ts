import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { sha256Hex, type Digest } from "../../src/contracts/domain.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { openLedger, type LedgerCursor } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

async function createLedger(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pai-ledger-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId("loop-ledger-001"));
  return { layout, ledger: await openLedger(layout) };
}

test("ledger transactions validate artifacts, advance CAS, and hash canonical events", async (t) => {
  const { layout, ledger } = await createLedger(t);
  const expected = await ledger.cursor();
  const checkpoint = {
    schema_version: 1,
    loop_id: "loop-ledger-001",
    sequence: 1,
    phase: "NEW",
    status: "PAUSED",
    source_head_sha: "a".repeat(40),
    completed_work_item_ids: [],
    evidence_ids: [],
    blocker: "Waiting for input.",
    resume_entry: "Resume loop-ledger-001.",
    digest: digest("b"),
  };

  const committed = await ledger.transact("CHECKPOINT", expected, async (transactionId) => {
    assert.match(transactionId, /^[0-9a-f-]{36}$/u);
    return checkpoint;
  });
  assert.deepEqual(committed.artifact, checkpoint);
  assert.equal(committed.cursor.sequence, 2);
  await assert.rejects(
    ledger.transact("CHECKPOINT", expected, async () => checkpoint),
    (error: unknown) => String(error).includes("CAS_MISMATCH"),
  );

  const lines = (await readFile(layout.eventsJsonl, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((event) => event.type), ["CHECKPOINT_INTENT", "CHECKPOINT_COMMIT"]);
  let previousHash = digest("0");
  for (const event of lines) {
    const { hash, ...withoutHash } = event;
    const computed = sha256Hex(Buffer.concat([
      Buffer.from(previousHash, "utf8"),
      Buffer.from(canonicalJsonBytes(withoutHash)),
    ]));
    assert.equal(hash, computed);
    assert.equal(event.previous_hash, previousHash);
    previousHash = hash;
  }
});

test("schema-invalid pending artifacts never receive a COMMIT event", async (t) => {
  const { layout, ledger } = await createLedger(t);
  await assert.rejects(
    ledger.transact("CHECKPOINT", await ledger.cursor(), async () => ({ schema_version: 1, loop_id: "loop-ledger-001" })),
    (error: unknown) => String(error).includes("SCHEMA_INVALID"),
  );
  const events = (await readFile(layout.eventsJsonl, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["CHECKPOINT_INTENT"]);
  const report = await ledger.recover();
  assert.equal(report.abandonedTransactions.length, 1);
});

test("replay permits a committed transaction after an abandoned Intent", async (t) => {
  const { ledger } = await createLedger(t);
  const checkpoint = {
    schema_version: 1,
    loop_id: "loop-ledger-001",
    sequence: 2,
    phase: "NEW",
    status: "PAUSED",
    source_head_sha: "a".repeat(40),
    completed_work_item_ids: [],
    evidence_ids: [],
    blocker: "Waiting for input.",
    resume_entry: "Resume loop-ledger-001.",
    digest: digest("c"),
  };

  await assert.rejects(
    ledger.transact("CHECKPOINT", await ledger.cursor(), async () => ({ schema_version: 1 })),
    (error: unknown) => String(error).includes("SCHEMA_INVALID"),
  );
  await ledger.recover();
  await ledger.transact("CHECKPOINT", await ledger.cursor(), async () => checkpoint);
  const before = await ledger.snapshot();
  const report = await ledger.recover();
  assert.equal(report.committedTransactions.length, 1);
  assert.deepEqual(await ledger.snapshot(), before);
});

test("Schema-valid pending artifacts still enforce English machine narrative", async (t) => {
  const { ledger } = await createLedger(t);
  await assert.rejects(
    ledger.transact("CHECKPOINT", await ledger.cursor(), async () => ({
      schema_version: 1,
      loop_id: "loop-ledger-001",
      sequence: 1,
      phase: "NEW",
      status: "PAUSED",
      source_head_sha: "a".repeat(40),
      completed_work_item_ids: [],
      evidence_ids: [],
      blocker: "等待输入",
      resume_entry: "Resume loop-ledger-001.",
      digest: digest("d"),
    })),
    /blocker/,
  );
});

test("workflow transitions enforce overlays, cancellation, non-convergence, and closed terminals", async (t) => {
  const { ledger } = await createLedger(t);
  let snapshot = await ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor());
  assert.equal(snapshot.phase, "ORIENTING");

  snapshot = await ledger.transition("ORIENTING", "PAUSED", await ledger.cursor());
  assert.deepEqual([snapshot.phase, snapshot.status], ["ORIENTING", "PAUSED"]);
  await assert.rejects(
    ledger.transition("CONTRACTED", "PAUSED", await ledger.cursor()),
    (error: unknown) => String(error).includes("INVALID_TRANSITION"),
  );
  snapshot = await ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor());
  snapshot = await ledger.transition("CONTRACTED", "ACTIVE", await ledger.cursor());
  snapshot = await ledger.transition("CONTRACTED", "NON_CONVERGENT", await ledger.cursor());
  assert.deepEqual([snapshot.phase, snapshot.status], ["CONTRACTED", "NON_CONVERGENT"]);
  await assert.rejects(
    ledger.transition("PLANNED", "ACTIVE", await ledger.cursor()),
    (error: unknown) => String(error).includes("NON_CONVERGENT"),
  );

  const cancelledRoot = await mkdtemp(join(tmpdir(), "pai-ledger-cancel-"));
  t.after(() => rm(cancelledRoot, { recursive: true, force: true }));
  const cancelled = await openLedger(resolveLayout(cancelledRoot, parseLoopId("loop-cancel-001")));
  const terminal = await cancelled.transition("CANCELLED", "CANCELLED", await cancelled.cursor());
  assert.deepEqual([terminal.phase, terminal.status], ["CANCELLED", "CANCELLED"]);
  await assert.rejects(
    cancelled.transition("CANCELLED", "ACTIVE", await cancelled.cursor()),
    (error: unknown) => String(error).includes("INVALID_TRANSITION"),
  );
});

test("HANDOFF_READY plus COMPLETE is closed and requires the workflow edge", async (t) => {
  const { ledger } = await createLedger(t);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING", "IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  await assert.rejects(
    ledger.transition("HANDOFF_READY", "ACTIVE", await ledger.cursor()),
    (error: unknown) => String(error).includes("INVALID_TRANSITION"),
  );
  const complete = await ledger.transition("HANDOFF_READY", "COMPLETE", await ledger.cursor());
  assert.deepEqual([complete.phase, complete.status], ["HANDOFF_READY", "COMPLETE"]);
  await assert.rejects(
    ledger.transition("HANDOFF_READY", "COMPLETE", await ledger.cursor()),
    (error: unknown) => String(error).includes("INVALID_TRANSITION"),
  );
});

test("cursor rejects an independently forged snapshot digest", async (t) => {
  const { ledger } = await createLedger(t);
  const cursor = await ledger.cursor();
  const forged: LedgerCursor = { ...cursor, snapshotDigest: digest("f") };
  await assert.rejects(
    ledger.transition("ORIENTING", "ACTIVE", forged),
    (error: unknown) => String(error).includes("CAS_MISMATCH"),
  );
});
