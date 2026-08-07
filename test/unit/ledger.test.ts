import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { sha256Hex, type Digest } from "../../src/contracts/domain.js";
import { atomicWriteJson, canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { openLedger, type LedgerCursor, type TransactionKind } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;
const timestamp = "2026-08-06T00:00:00.000Z";

async function createLedger(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pai-ledger-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId("loop-ledger-001"));
  return { layout, ledger: await openLedger(layout) };
}

async function advanceToFinalizing(ledger: Awaited<ReturnType<typeof openLedger>>): Promise<void> {
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING", "IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
}

function checkpointFor(loopId: string, status: "PAUSED" | "NON_CONVERGENT" = "PAUSED") {
  return {
    schema_version: 1,
    loop_id: loopId,
    sequence: 1,
    phase: "ORIENTING",
    status,
    source_head_sha: "a".repeat(40),
    completed_work_item_ids: [],
    evidence_ids: [],
    blocker: status === "NON_CONVERGENT" ? "Transition budget exhausted." : "Waiting for input.",
    resume_entry: "Resume loop-ledger-001.",
    digest: digest("b"),
  };
}

function handoffFor(loopId: string) {
  return {
    schema_version: 1,
    loop_id: loopId,
    markdown_language: "en-US",
    source_head_sha: "a".repeat(40),
    reviewed_tree_digest: digest("a"),
    workspace_digest: digest("a"),
    source_manifest_digest: digest("a"),
    runtime_manifest_digest: digest("a"),
    project_policy_digest: digest("a"),
    h0_digest: digest("a"),
    h1_revision: 1,
    h1_digest: digest("a"),
    loop_markdown_digest: digest("a"),
    agent_bundle_digests: [],
    evidence_manifest_digest: digest("a"),
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
    digest: digest("e"),
  };
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
  await ledger.transact("CHECKPOINT", await ledger.cursor(), async () => ({
    ...checkpointFor("loop-ledger-001", "NON_CONVERGENT"),
    phase: "CONTRACTED",
  }));
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
  await ledger.transact("HANDOFF", await ledger.cursor(), async () => handoffFor("loop-ledger-001"));
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

test("transaction admission rejects every Schema family that carries another loop_id", async (t) => {
  const otherLoop = "loop-other-001";
  const common = digest("a");
  const fixtures: readonly [TransactionKind, unknown][] = [
    ["BOOTSTRAP", {
      schema_version: 1, kind: "H0", loop_id: otherLoop, revision: 0,
      repository_id: "repository-001", repository_root: "C:/workspace", readable_paths: ["src/**"],
      repository_rules_digest: common, explore_capabilities: ["native-search"], network_class: "DISABLED",
      denied_actions: ["push"], digest: common,
    }],
    ["HARNESS", {
      schema_version: 1, kind: "H0", loop_id: otherLoop, revision: 0,
      repository_id: "repository-001", repository_root: "C:/workspace", readable_paths: ["src/**"],
      repository_rules_digest: common, explore_capabilities: ["native-search"], network_class: "DISABLED",
      denied_actions: ["push"], digest: common,
    }],
    ["WAVE_INPUT", {
      schema_version: 1, loop_id: otherLoop, wave_id: "wave-001", base_sha: "a".repeat(40),
      source_manifest_digest: common, tree_manifest_digest: common, workspace_manifest_digest: common,
      artifact_manifest_digest: common, h1_policy_digest: common, digest: common,
    }],
    ["EVIDENCE", {
      schema_version: 1, evidence_id: "evidence-001", loop_id: otherLoop, work_item_id: "work-001",
      attempt: 1, actor_role: "worker", h1_digest: common, wave_input_digest: common,
      output_tree_digest: common, argv: ["npm", "test"], cwd: "C:/workspace", started_at: timestamp,
      ended_at: timestamp, exit_code: 0, environment_digest: common, tool_versions: { node: "24" },
      stdout_path: "stdout.bin", stdout_digest: common, stderr_path: "stderr.bin", stderr_digest: common,
      artifact_manifest_digest: common, result: "PASS",
    }],
    ["CHECKPOINT", checkpointFor(otherLoop)],
    ["HANDOFF", handoffFor(otherLoop)],
    ["DISPATCH", {
      schema_version: 1, request_id: "request-001", loop_id: otherLoop, work_item_id: "work-001",
      attempt: 1, actor_role: "worker", objective: "Implement the bounded task.", acceptance: ["Tests pass."],
      dependencies: [], read_set: ["src/input.ts"], write_set: ["src/output.ts"], worktree: "C:/workspace",
      wave_input_digest: common, h1_digest: common, fencing_token: 1, required_evidence_ids: ["evidence-001"],
      allowed_tools: ["typescript"], stop_conditions: ["Stop on drift."], digest: common,
    }],
    ["AGENT_RESULT", {
      schema_version: 1, request_id: "request-001", loop_id: otherLoop, work_item_id: "work-001",
      attempt: 1, actor_role: "worker", wave_input_digest: common, h1_digest: common, fencing_token: 1,
      status: "COMPLETED", output_tree_digest: common, actual_read_set: ["src/input.ts"],
      actual_write_set: ["src/output.ts"], evidence_ids: ["evidence-001"], artifact_manifest_digest: common,
      summary: "The bounded task completed.", digest: common,
    }],
    ["RELEASE", {
      schema_version: 1, release_id: "release-001", loop_id: otherLoop, handoff_digest: common, phase: "READY",
      action_envelope_digests: [], operation_ids: [], created_at: timestamp, updated_at: timestamp,
      release_commit_sha: null, digest: common,
    }],
  ];

  for (const [index, [kind, artifact]] of fixtures.entries()) {
    await t.test(`${kind} cross-Loop artifact`, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), `pai-ledger-cross-loop-${index}-`));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const ledger = await openLedger(resolveLayout(root, parseLoopId(`loop-cross-${index}`)));
      await assert.rejects(
        ledger.transact(kind, await ledger.cursor(), async () => artifact),
        (error: unknown) => String(error).includes("SCHEMA_INVALID"),
      );
    });
  }
});

test("recovery rejects a digest-consistent committed artifact for another Loop", async (t) => {
  const { layout, ledger } = await createLedger(t);
  const committed = await ledger.transact("CHECKPOINT", await ledger.cursor(), async () => checkpointFor("loop-ledger-001"));
  const envelope = JSON.parse(await readFile(committed.artifactPath, "utf8")) as Record<string, unknown> & { artifact: Record<string, unknown> };
  envelope.artifact = { ...envelope.artifact, loop_id: "loop-other-001" };
  await atomicWriteJson(committed.artifactPath, envelope);

  const events = (await readFile(layout.eventsJsonl, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const intent = events[0];
  const commit = { ...events[1], payload: { ...events[1].payload, data_digest: sha256Hex(canonicalJsonBytes(envelope)) } };
  const { hash: _oldHash, ...withoutHash } = commit;
  commit.hash = sha256Hex(Buffer.concat([Buffer.from(intent.hash, "utf8"), Buffer.from(canonicalJsonBytes(withoutHash))]));
  await writeFile(layout.eventsJsonl, Buffer.concat([Buffer.from(canonicalJsonBytes(intent)), Buffer.from(canonicalJsonBytes(commit))]));
  const snapshot = await ledger.snapshot();
  await atomicWriteJson(layout.loopJson, { ...snapshot, last_event_hash: commit.hash });

  await assert.rejects(ledger.recover(), (error: unknown) => String(error).includes("SCHEMA_INVALID"));
});

test("NON_CONVERGENT requires a committed matching checkpoint", async (t) => {
  const { ledger } = await createLedger(t);
  await ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor());
  await assert.rejects(
    ledger.transition("ORIENTING", "NON_CONVERGENT", await ledger.cursor()),
    (error: unknown) => String(error).includes("INVALID_TRANSITION"),
  );

  const root = await mkdtemp(join(tmpdir(), "pai-ledger-nonconvergent-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const withCheckpoint = await openLedger(resolveLayout(root, parseLoopId("loop-nonconvergent-checkpoint")));
  await withCheckpoint.transition("ORIENTING", "ACTIVE", await withCheckpoint.cursor());
  await withCheckpoint.transact("CHECKPOINT", await withCheckpoint.cursor(), async () => ({
    ...checkpointFor("loop-nonconvergent-checkpoint", "NON_CONVERGENT"),
  }));
  const terminal = await withCheckpoint.transition("ORIENTING", "NON_CONVERGENT", await withCheckpoint.cursor());
  assert.equal(terminal.status, "NON_CONVERGENT");
});

test("HANDOFF_READY plus COMPLETE requires a committed matching Handoff digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-ledger-handoff-required-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const withoutHandoff = await openLedger(resolveLayout(root, parseLoopId("loop-handoff-required")));
  await advanceToFinalizing(withoutHandoff);
  await assert.rejects(
    withoutHandoff.transition("HANDOFF_READY", "COMPLETE", await withoutHandoff.cursor()),
    (error: unknown) => String(error).includes("INVALID_TRANSITION"),
  );

  const completeRoot = await mkdtemp(join(tmpdir(), "pai-ledger-handoff-committed-"));
  t.after(() => rm(completeRoot, { recursive: true, force: true }));
  const withHandoff = await openLedger(resolveLayout(completeRoot, parseLoopId("loop-handoff-committed")));
  await advanceToFinalizing(withHandoff);
  const handoff = handoffFor("loop-handoff-committed");
  const committed = await withHandoff.transact("HANDOFF", await withHandoff.cursor(), async () => handoff);
  assert.equal(committed.snapshot.handoff_digest, handoff.digest);
  const complete = await withHandoff.transition("HANDOFF_READY", "COMPLETE", await withHandoff.cursor());
  assert.deepEqual([complete.phase, complete.status], ["HANDOFF_READY", "COMPLETE"]);
});

test("new-ledger initialization holds the fenced boundary and cannot race an overwrite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-ledger-init-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId("loop-init-race"));
  let releaseInitialization: (() => void) | undefined;
  const initializationGate = new Promise<void>((resolvePromise) => { releaseInitialization = resolvePromise; });
  let signalEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolvePromise) => { signalEntered = resolvePromise; });
  let paused = false;
  const first = openLedger(layout, {
    fault: async (point) => {
      if (point !== "before-snapshot-replace" || paused) return;
      paused = true;
      signalEntered?.();
      await initializationGate;
    },
  });

  const outcome = await Promise.race([
    entered.then(() => "ENTERED" as const),
    first.then(() => "COMPLETED_WITHOUT_FENCE" as const),
  ]);
  assert.equal(outcome, "ENTERED");
  await assert.rejects(
    openLedger(layout),
    (error: unknown) => String(error).includes("LOCK_BUSY"),
  );
  releaseInitialization?.();
  const ledger = await first;
  await ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor());
  assert.equal((await (await openLedger(layout)).snapshot()).phase, "ORIENTING");
});
