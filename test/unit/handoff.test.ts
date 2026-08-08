import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { sha256Hex, type Digest, type LoopId } from "../../src/contracts/domain.js";
import type { FinalHandoff } from "../../src/contracts/release.js";
import type { EvidenceRecord, H0Harness, H1Harness } from "../../src/contracts/harness.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { forgeH0, sealH1, type H1Input } from "../../src/core/harness.js";
import {
  createChildLoop,
  finalizeHandoff,
  verifyHandoffFreshness,
  writeCheckpoint,
  type CheckpointInput,
  type FinalizeInput,
  type FreshnessFacts,
} from "../../src/core/handoff.js";
import { openLedger, type LoopLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../../src/core/paths.js";
import { recordVerdict } from "../../src/core/review.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

async function seedPassVerdict(layout: LoopLayout): Promise<void> {
  await recordVerdict(layout.workspaceRoot, layout.loopId, { kind: "PASS" });
}

function evidence(id: string): EvidenceRecord {
  return {
    schema_version: 1,
    evidence_id: id,
    loop_id: parseLoopId("loop-placeholder"),
    work_item_id: "work-1",
    attempt: 1,
    actor_role: "worker",
    h1_digest: digest("1"),
    wave_input_digest: digest("2"),
    output_tree_digest: digest("3"),
    argv: ["node", "--version"],
    executable_path: "/usr/bin/node",
    executable_digest: digest("4"),
    version_argv: ["node", "--version"],
    cwd: "/tmp",
    timeout_ms: 5_000,
    stdout_limit_bytes: 1_024,
    stderr_limit_bytes: 1_024,
    started_at: "2026-08-06T00:00:00.000Z",
    ended_at: "2026-08-06T00:00:01.000Z",
    exit_code: 0,
    exit_signal: null,
    termination_path: "exit",
    environment_digest: digest("5"),
    tool_versions: { node: "22.0.0" },
    stdout_path: "stdout.bin",
    stdout_digest: digest("6"),
    stderr_path: "stderr.bin",
    stderr_digest: digest("7"),
    artifact_manifest_digest: digest("8"),
    result: "PASS",
  };
}

function executionInput(loopId: LoopId): H1Input {
  return {
    loopId,
    objective: "Ship a bounded change.",
    acceptance: ["Tests pass."],
    outOfScope: ["Unrelated modules."],
    readablePaths: ["src/**"],
    writablePaths: ["src/output.ts"],
    waveInputDigest: digest("b"),
    projectPolicyDigest: digest("c"),
    planDigest: digest("d"),
    environmentGates: [
      {
        gate_id: "static",
        node: "SOURCE_STATIC",
        owner: "LOOP_REQUIRED",
        depends_on: [],
        evidence_ids: ["E-STATIC-1"],
        requires_new_action: false,
      },
      {
        gate_id: "hil",
        node: "HIL",
        owner: "RELEASE_REQUIRED",
        depends_on: ["static"],
        evidence_ids: [],
        requires_new_action: true,
      },
    ],
    actors: [
      {
        actor_role: "worker",
        model_class: "premium",
        capabilities: ["source-write", "evidence-execution", "dispatch", "transition", "finalize"],
      },
    ],
    capabilities: [
      { capability: "source-write", enforcement: "ORCHESTRATION_ONLY" },
      { capability: "finalize", enforcement: "ORCHESTRATION_ONLY" },
    ],
    budgets: { attempts: 3, reviews: 2, transitions: 20 },
    stopRules: ["Stop on drift."],
    resultSchemas: ["agent-result"],
    planReview: "PASSED",
  };
}

async function finalizingContext(t: TestContext, loopId: LoopId): Promise<{
  layout: LoopLayout;
  ledger: LoopLedger;
  h0: H0Harness;
  h1: H1Harness;
}> {
  const root = await mkdtemp(join(tmpdir(), "pai-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, loopId);
  const ledger = await openLedger(layout);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const h0 = await forgeH0({
    loopId,
    repositoryId: "repository-001",
    repositoryRoot: root,
    readablePaths: ["src/**"],
    repositoryRulesDigest: digest("a"),
    exploreCapabilities: ["native-search"],
    networkClass: "DISABLED",
  });
  const h1 = await sealH1(executionInput(loopId), ledger);
  for (const phase of ["IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  return { layout, ledger, h0, h1 };
}

function validFinalize(
  layout: LoopLayout,
  h0: H0Harness,
  h1: H1Harness,
  overrides: Partial<FinalizeInput> = {},
): FinalizeInput {
  const evidenceRecord = {
    ...evidence("E-STATIC-1"),
    loop_id: layout.loopId,
    h1_digest: h1.digest,
    wave_input_digest: h1.wave_input_digest,
  };
  return {
    workspace: layout.workspaceRoot,
    loopId: layout.loopId,
    actorRole: "worker",
    sourceHeadSha: "a".repeat(40),
    reviewedTreeDigest: digest("e"),
    workspaceDigest: digest("f"),
    sourceManifestDigest: digest("1"),
    runtimeManifestDigest: digest("2"),
    projectPolicyDigest: h1.project_policy_digest,
    h0,
    h1,
    loopMarkdownDigest: digest("3"),
    agentBundleDigests: [digest("4")],
    evidenceManifestDigest: digest("5"),
    evidence: [evidenceRecord],
    residualRisks: ["HIL remains RELEASE_REQUIRED."],
    rollback: {
      target: "source-head",
      procedure: ["Restore the reviewed source head."],
      triggers: ["Verification regression."],
      estimated_recovery_minutes: 15,
    },
    recommendedReleaseActions: ["commit", "run-hil"],
    harnessFacts: {
      harnessDigest: h1.digest,
      waveInputDigest: h1.wave_input_digest,
      projectPolicyDigest: h1.project_policy_digest,
      planDigest: h1.plan_digest,
      attemptsUsed: 1,
      reviewsUsed: 1,
      transitionsUsed: 8,
      activeWriteWave: false,
      evidence: [evidenceRecord],
    },
    dispatchConsistent: true,
    ...overrides,
  };
}

function freshnessFrom(handoff: FinalHandoff, overrides: Partial<FreshnessFacts> = {}): FreshnessFacts {
  return {
    sourceHeadSha: handoff.source_head_sha,
    reviewedTreeDigest: handoff.reviewed_tree_digest,
    workspaceDigest: handoff.workspace_digest,
    sourceManifestDigest: handoff.source_manifest_digest,
    runtimeManifestDigest: handoff.runtime_manifest_digest,
    projectPolicyDigest: handoff.project_policy_digest,
    h1Digest: handoff.h1_digest,
    loopMarkdownDigest: handoff.loop_markdown_digest,
    evidenceManifestDigest: handoff.evidence_manifest_digest,
    ...overrides,
  };
}

test("writeCheckpoint writes increasing checkpoint files with resume entry", async (t) => {
  const { layout } = await finalizingContext(t, parseLoopId("loop-checkpoint-seq"));
  const firstInput: CheckpointInput = {
    workspace: layout.workspaceRoot,
    loopId: layout.loopId,
    sourceHeadSha: "a".repeat(40),
    completedWorkItemIds: ["work-1"],
    evidenceIds: ["E-STATIC-1"],
    blocker: null,
    resumeEntry: "Resume at VERIFYING after pause.",
    status: "PAUSED",
  };
  const first = await writeCheckpoint(firstInput);
  assert.equal(first.sequence, 1);
  assert.equal(first.resume_entry, firstInput.resumeEntry);
  const listed = await readdir(layout.checkpointsRoot);
  assert.deepEqual(listed.sort(), ["1.json"]);

  const second = await writeCheckpoint({
    ...firstInput,
    completedWorkItemIds: ["work-1", "work-2"],
    blocker: "Waiting on evidence.",
    status: "BLOCKED",
  });
  assert.equal(second.sequence, 2);
  assert.equal((await readdir(layout.checkpointsRoot)).sort().join(","), "1.json,2.json");
});

test("Final Handoff is single-write and Source drift is stale", async (t) => {
  const { layout, h0, h1 } = await finalizingContext(t, parseLoopId("loop-handoff-immutable"));
  await seedPassVerdict(layout);
  const input = validFinalize(layout, h0, h1);
  const handoff = await finalizeHandoff(input);
  assert.equal(handoff.review_verdict, "PASS");
  assert.equal(handoff.h1_digest, h1.digest);
  assert.ok(handoff.release_required_gates.includes("hil"));
  await access(layout.handoffJson);
  const onDisk = validateDigest(JSON.parse(await readFile(layout.handoffJson, "utf8")) as FinalHandoff);
  assert.equal(onDisk.digest, handoff.digest);

  await assert.rejects(finalizeHandoff(input), /immutable/i);
  await assert.rejects(
    verifyHandoffFreshness(handoff, freshnessFrom(handoff, { reviewedTreeDigest: digest("x") })),
    /STALE_HANDOFF/,
  );
});

test("verifyHandoffFreshness accepts matching reviewed Source Policy H1 and evidence", async (t) => {
  const { layout, h0, h1 } = await finalizingContext(t, parseLoopId("loop-handoff-fresh"));
  await seedPassVerdict(layout);
  const handoff = await finalizeHandoff(validFinalize(layout, h0, h1));
  await verifyHandoffFreshness(handoff, freshnessFrom(handoff));
});

test("stale complete Handoff requires a Child Loop and never overwrites", async (t) => {
  const { layout, h0, h1, ledger } = await finalizingContext(t, parseLoopId("loop-child-required"));
  await seedPassVerdict(layout);
  const handoff = await finalizeHandoff(validFinalize(layout, h0, h1));
  const before = await readFile(layout.handoffJson);
  const child = await createChildLoop({
    workspace: layout.workspaceRoot,
    parentLoopId: layout.loopId,
    reason: "STALE_HANDOFF",
    task: "Re-finalize after Source drift.",
  });
  assert.notEqual(child.loop_id, layout.loopId);
  assert.equal(child.parent_loop_id, layout.loopId);
  assert.deepEqual(await readFile(layout.handoffJson), before);
  const parent = await ledger.snapshot();
  assert.equal(parent.phase, "HANDOFF_READY");
  assert.equal(parent.status, "COMPLETE");
  assert.equal(parent.handoff_digest, handoff.digest);
});

function validateDigest(handoff: FinalHandoff): FinalHandoff {
  const { digest: claimed, ...content } = handoff;
  const expected = sha256Hex(canonicalJsonBytes(content));
  assert.equal(claimed, expected);
  return handoff;
}
