import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  openLedger,
  type LedgerFaultPoint,
  type LoopLedger,
} from "../../src/core/ledger.js";
import { reconcileLock, type LockClock } from "../../src/core/lock.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../../src/core/paths.js";

class ManualClock implements LockClock {
  #milliseconds = Date.parse("2026-08-06T00:00:00.000Z");

  now(): Date {
    return new Date(this.#milliseconds);
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }
}

async function activeNonce(layout: LoopLayout): Promise<string> {
  const owner = JSON.parse(await readFile(`${layout.loopRoot}.lock/owner.json`, "utf8")) as { nonce: string };
  return owner.nonce;
}

async function advanceToFinalizing(ledger: LoopLedger): Promise<void> {
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING", "IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
}

function handoffFor(loopId: string) {
  const digest = "a".repeat(64);
  return {
    schema_version: 1,
    loop_id: loopId,
    markdown_language: "en-US",
    source_head_sha: "a".repeat(40),
    reviewed_tree_digest: digest,
    workspace_digest: digest,
    source_manifest_digest: digest,
    runtime_manifest_digest: digest,
    project_policy_digest: digest,
    h0_digest: digest,
    h1_revision: 1,
    h1_digest: digest,
    loop_markdown_digest: digest,
    agent_bundle_digests: [],
    evidence_manifest_digest: digest,
    review_verdict: "PASS",
    residual_risks: [],
    rollback: {
      target: "source-head",
      procedure: ["Restore the reviewed source head."],
      triggers: ["Verification regression."],
      estimated_recovery_minutes: 10,
    },
    release_required_gates: [],
    recommended_release_actions: ["commit"],
    finalize_event_sequence: 1,
    digest: "e".repeat(64),
  };
}

async function finalizingLedger(
  t: TestContext,
  point: LedgerFaultPoint,
): Promise<{ ledger: LoopLedger; layout: LoopLayout }> {
  const root = await mkdtemp(join(tmpdir(), `pi-ledger-${point}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId(`loop-${point}`));
  const setup = await openLedger(layout);
  await advanceToFinalizing(setup);
  await setup.transact("HANDOFF", await setup.cursor(), async () => handoffFor(layout.loopId));
  const ledger = await openLedger(layout, {
    fault: (current) => {
      if (current === point) throw new Error(`injected ${point}`);
    },
  });
  return { ledger, layout };
}

test("recovery consumes only artifacts with matching COMMIT events", async (t) => {
  const { ledger } = await finalizingLedger(t, "after-artifact-rename");
  await assert.rejects(
    ledger.transition("HANDOFF_READY", "COMPLETE", await ledger.cursor()),
    /injected after-artifact-rename/,
  );
  const report = await ledger.recover();
  assert.equal(report.quarantinedArtifacts.length, 1);
  assert.equal((await ledger.snapshot()).phase, "FINALIZING");
});

test("ledger exposes the deterministic pre-Intent append boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-ledger-pre-intent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId("loop-pre-intent"));
  const ledger = await openLedger(layout, {
    fault: (point) => {
      if ((point as string) === "before-intent-append") throw new Error("injected before-intent-append");
    },
  });

  await assert.rejects(
    ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor()),
    /injected before-intent-append/,
  );
});

test("expired stale writer cannot replace a successor snapshot after its Commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-ledger-stale-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId("loop-stale-snapshot"));
  const clock = new ManualClock();
  let interleaved = false;
  const stale = await openLedger(layout, {
    clock,
    lockTtlMs: 10,
    fault: async (point) => {
      if (point !== "after-commit" || interleaved) return;
      interleaved = true;
      const expectedNonce = await activeNonce(layout);
      clock.advance(11);
      await reconcileLock({ target: layout.loopRoot, expectedNonce, clock });
      const successor = await openLedger(layout, { clock, lockTtlMs: 10 });
      await successor.recover();
      await successor.transition("CONTRACTED", "ACTIVE", await successor.cursor());
    },
  });

  await assert.rejects(
    stale.transition("ORIENTING", "ACTIVE", await stale.cursor()),
    (error: unknown) => String(error).includes("CAS_MISMATCH"),
  );
  const snapshot = await (await openLedger(layout, { clock, lockTtlMs: 10 })).snapshot();
  assert.deepEqual(
    [snapshot.phase, snapshot.last_event_sequence],
    ["CONTRACTED", 4],
    "a stale sequence-2 snapshot must not replace the successor sequence-4 snapshot",
  );
});

test("expiry between owner assertion and Intent append cannot corrupt the WAL chain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-ledger-stale-wal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId("loop-stale-wal"));
  const clock = new ManualClock();
  let interleaved = false;
  let successor: LoopLedger | undefined;
  const stale = await openLedger(layout, {
    clock,
    lockTtlMs: 10,
    fault: async (point) => {
      if (point !== "before-intent-append" || interleaved) return;
      interleaved = true;
      const expectedNonce = await activeNonce(layout);
      clock.advance(11);
      await reconcileLock({ target: layout.loopRoot, expectedNonce, clock });
      successor = await openLedger(layout, { clock, lockTtlMs: 10 });
      await successor.transition("ORIENTING", "ACTIVE", await successor.cursor());
    },
  });

  await assert.rejects(
    stale.transition("ORIENTING", "ACTIVE", await stale.cursor()),
    (error: unknown) => String(error).includes("CAS_MISMATCH"),
  );
  assert.ok(successor !== undefined);
  const recovery = await successor.recover();
  assert.equal(recovery.quarantinedArtifacts.length, 0);
  const events = (await readFile(layout.eventsJsonl, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal((await successor.snapshot()).phase, "ORIENTING");
});

const boundaries: readonly {
  point: LedgerFaultPoint;
  committed: boolean;
  quarantined: number;
}[] = [
  { point: "after-intent", committed: false, quarantined: 0 },
  { point: "after-artifact-temp-write", committed: false, quarantined: 1 },
  { point: "after-artifact-sync", committed: false, quarantined: 1 },
  { point: "after-artifact-rename", committed: false, quarantined: 1 },
  { point: "after-commit", committed: true, quarantined: 0 },
  { point: "before-snapshot-replace", committed: true, quarantined: 0 },
  { point: "after-snapshot-replace", committed: true, quarantined: 0 },
];

for (const boundary of boundaries) {
  test(`ledger recovery at ${boundary.point} follows committed events as truth`, async (t) => {
    const { ledger } = await finalizingLedger(t, boundary.point);
    await assert.rejects(
      ledger.transition("HANDOFF_READY", "COMPLETE", await ledger.cursor()),
      new RegExp(boundary.point),
    );

    const report = await ledger.recover();
    const snapshot = await ledger.snapshot();
    assert.equal(report.quarantinedArtifacts.length, boundary.quarantined);
    assert.deepEqual(
      [snapshot.phase, snapshot.status],
      boundary.committed ? ["HANDOFF_READY", "COMPLETE"] : ["FINALIZING", "ACTIVE"],
    );

    const second = await ledger.recover();
    assert.equal(second.quarantinedArtifacts.length, 0);
    assert.deepEqual(await ledger.snapshot(), snapshot);
  });
}
