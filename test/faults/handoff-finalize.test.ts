import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import type { EvidenceRecord, H0Harness, H1Harness } from "../../src/contracts/harness.js";
import { forgeH0, sealH1, type H1Input } from "../../src/core/harness.js";
import {
  createChildLoop,
  finalizeHandoff,
  type FinalizeFaultPoint,
  type FinalizeInput,
} from "../../src/core/handoff.js";
import { openLedger, type LoopLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../../src/core/paths.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

function evidence(loopId: LoopId, h1: H1Harness): EvidenceRecord {
  return {
    schema_version: 1,
    evidence_id: "E-STATIC-1",
    loop_id: loopId,
    work_item_id: "work-1",
    attempt: 1,
    actor_role: "worker",
    h1_digest: h1.digest,
    wave_input_digest: h1.wave_input_digest,
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
    ],
    actors: [
      {
        actor_role: "worker",
        model_class: "premium",
        capabilities: ["source-write", "evidence-execution", "dispatch", "transition", "finalize"],
      },
    ],
    capabilities: [
      { capability: "finalize", enforcement: "ORCHESTRATION_ONLY" },
    ],
    budgets: { attempts: 3, reviews: 2, transitions: 20 },
    stopRules: ["Stop on drift."],
    resultSchemas: ["agent-result"],
    planReview: "PASSED",
  };
}

async function finalizingSetup(t: TestContext, suffix: string): Promise<{
  layout: LoopLayout;
  ledger: LoopLedger;
  h0: H0Harness;
  h1: H1Harness;
}> {
  const root = await mkdtemp(join(tmpdir(), `pai-handoff-fault-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId(`loop-fault-${suffix}`));
  const ledger = await openLedger(layout);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const h0 = await forgeH0({
    loopId: layout.loopId,
    repositoryId: "repository-001",
    repositoryRoot: root,
    readablePaths: ["src/**"],
    repositoryRulesDigest: digest("a"),
    exploreCapabilities: ["native-search"],
    networkClass: "DISABLED",
  });
  const h1 = await sealH1(executionInput(layout.loopId), ledger);
  for (const phase of ["IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  return { layout, ledger, h0, h1 };
}

function finalizeInput(
  layout: LoopLayout,
  h0: H0Harness,
  h1: H1Harness,
  fault?: FinalizeFaultPoint,
): FinalizeInput {
  const record = evidence(layout.loopId, h1);
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
    evidence: [record],
    reviewVerdict: "PASS",
    residualRisks: ["No residual Critical Findings."],
    rollback: {
      target: "source-head",
      procedure: ["Restore the reviewed source head."],
      triggers: ["Verification regression."],
      estimated_recovery_minutes: 10,
    },
    recommendedReleaseActions: ["commit"],
    harnessFacts: {
      harnessDigest: h1.digest,
      waveInputDigest: h1.wave_input_digest,
      projectPolicyDigest: h1.project_policy_digest,
      planDigest: h1.plan_digest,
      attemptsUsed: 1,
      reviewsUsed: 1,
      transitionsUsed: 8,
      activeWriteWave: false,
      evidence: [record],
    },
    dispatchConsistent: true,
    findingStates: [
      { findingId: "F-1", status: "VERIFIED", severity: "HIGH", area: "src/a.ts", sourceDigest: digest("9") },
    ],
    ...(fault === undefined ? {} : { fault }),
  };
}

const boundaries: readonly {
  point: FinalizeFaultPoint;
  consumableHandoff: boolean;
}[] = [
  { point: "after-pending-write", consumableHandoff: false },
  { point: "after-pending-rename", consumableHandoff: false },
  { point: "after-handoff-commit", consumableHandoff: false },
  { point: "before-phase-transition", consumableHandoff: false },
  { point: "after-phase-transition", consumableHandoff: true },
];

for (const boundary of boundaries) {
  test(`handoff finalize recovery at ${boundary.point} never exposes an incomplete Handoff`, async (t) => {
    const { layout, h0, h1, ledger } = await finalizingSetup(t, boundary.point);
    await assert.rejects(
      finalizeHandoff(finalizeInput(layout, h0, h1, boundary.point)),
      new RegExp(boundary.point),
    );

    let handoffPresent = true;
    try {
      await access(layout.handoffJson);
    } catch {
      handoffPresent = false;
    }
    const snapshot = await ledger.snapshot();
    const consumable = snapshot.phase === "HANDOFF_READY"
      && snapshot.status === "COMPLETE"
      && snapshot.handoff_digest !== null
      && handoffPresent;
    if (boundary.consumableHandoff) {
      assert.equal(consumable, true);
    } else {
      assert.equal(consumable, false);
      assert.equal(snapshot.phase, "FINALIZING");
      if (handoffPresent && snapshot.handoff_digest === null) {
        const before = await readFile(layout.handoffJson);
        await createChildLoop({
          workspace: layout.workspaceRoot,
          parentLoopId: layout.loopId,
          reason: "FINALIZE_RECOVERY",
          task: "Recover from incomplete Finalize.",
        });
        assert.deepEqual(await readFile(layout.handoffJson), before);
      }
    }
  });
}

test("handoff finalize Child Loop creation never overwrites an immutable Handoff", async (t) => {
  const { layout, h0, h1 } = await finalizingSetup(t, "child-loop");
  await finalizeHandoff(finalizeInput(layout, h0, h1));
  const before = await readFile(layout.handoffJson);
  const child = await createChildLoop({
    workspace: layout.workspaceRoot,
    parentLoopId: layout.loopId,
    reason: "STALE_HANDOFF",
    task: "Continue from immutable Handoff.",
  });
  assert.equal(child.parent_loop_id, layout.loopId);
  assert.deepEqual(await readFile(layout.handoffJson), before);
  await assert.rejects(finalizeHandoff(finalizeInput(layout, h0, h1)), /immutable/i);
});
