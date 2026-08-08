import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { sha256Hex, type Digest, type LoopId } from "../../src/contracts/domain.js";
import type { EvidenceRecord, H0Harness, H1Harness } from "../../src/contracts/harness.js";
import type { FinalHandoff, KnowledgeProposal, ReleaseRecord } from "../../src/contracts/release.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { forgeH0, sealH1, type H1Input } from "../../src/core/harness.js";
import {
  finalizeHandoff,
  type FinalizeInput,
} from "../../src/core/handoff.js";
import {
  buildProposal,
  collectKnowledgeSources,
  markProposalApplied,
  transitionProposal,
} from "../../src/core/knowledge.js";
import { openLedger, type LoopLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../../src/core/paths.js";
import { recordVerdict } from "../../src/core/review.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

type DirectorySnapshot = Readonly<Record<string, string>>;

async function snapshotDirectory(root: string): Promise<DirectorySnapshot> {
  const entries: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    let listing;
    try {
      listing = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of listing) {
      const absolute = join(directory, entry.name);
      const key = relative(root, absolute).replace(/\\/gu, "/");
      if (entry.isDirectory()) {
        await walk(absolute);
      } else {
        const [metadata, bytes] = await Promise.all([stat(absolute), readFile(absolute)]);
        entries[key] = `${metadata.size}:${metadata.mtimeMs}:${bytes.toString("base64")}`;
      }
    }
  }
  await walk(root);
  return entries;
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

async function activeContext(t: TestContext, loopId: LoopId): Promise<{ root: string; layout: LoopLayout }> {
  const root = await mkdtemp(join(tmpdir(), "pai-knowledge-active-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, loopId);
  await openLedger(layout);
  return { root, layout };
}

async function completedContext(t: TestContext, loopId: LoopId, residualRisks: readonly string[] = [
  "HIL remains RELEASE_REQUIRED.",
]): Promise<{
  root: string;
  layout: LoopLayout;
  ledger: LoopLedger;
  h0: H0Harness;
  h1: H1Harness;
  handoff: FinalHandoff;
}> {
  const root = await mkdtemp(join(tmpdir(), "pai-knowledge-done-"));
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
  await recordVerdict(root, loopId, { kind: "PASS" });
  const evidenceRecord = {
    ...evidence("E-STATIC-1"),
    loop_id: loopId,
    h1_digest: h1.digest,
    wave_input_digest: h1.wave_input_digest,
  };
  const finalizeInput: FinalizeInput = {
    workspace: root,
    loopId,
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
    residualRisks,
    rollback: {
      target: "source-head",
      procedure: ["Restore the reviewed source head."],
      triggers: ["Verification regression."],
      estimated_recovery_minutes: 15,
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
      evidence: [evidenceRecord],
    },
    dispatchConsistent: true,
  };
  const handoff = await finalizeHandoff(finalizeInput);
  return { root, layout, ledger, h0, h1, handoff };
}

async function writeEndedRelease(root: string, loopId: LoopId, handoff: FinalHandoff, phase: ReleaseRecord["phase"]): Promise<ReleaseRecord> {
  const layout = resolveLayout(root);
  const releaseId = `release-${loopId}`;
  const content = {
    schema_version: 1 as const,
    release_id: releaseId,
    loop_id: loopId,
    handoff_digest: handoff.digest,
    phase,
    action_envelope_digests: [] as Digest[],
    operation_ids: [] as string[],
    created_at: "2026-08-06T00:00:00.000Z",
    updated_at: "2026-08-06T00:01:00.000Z",
    release_commit_sha: phase === "RELEASED" ? "b".repeat(40) : null,
  };
  const release = { ...content, digest: sha256Hex(canonicalJsonBytes(content)) };
  const directory = join(layout.releasesRoot, releaseId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "release.json"), JSON.stringify(release));
  return release;
}

function proposalFields() {
  return {
    proposal_type: "PROJECT_KNOWLEDGE" as const,
    privacy_review: "No sensitive content is included.",
    expected_benefit: "Reduce repeated review work.",
    safety_impact: "No safety boundary changes.",
    offline_evaluation: ["Replay prior cases."],
    canary: ["Use in one child Loop."],
    rollback: ["Supersede the proposal."],
    review_date: "2026-08-06",
    counterexamples: ["One-off project accident."],
  };
}

test("active Loops cannot be generalized", async (t) => {
  const activeLoop = parseLoopId("loop-active-source");
  const { root } = await activeContext(t, activeLoop);
  await assert.rejects(
    collectKnowledgeSources({ workspace: root, loopIds: [activeLoop] }),
    /completed Loop/i,
  );
});

test("one observation is PROVISIONAL and proposal cannot modify production", async (t) => {
  const sourceLoop = parseLoopId("loop-knowledge-source");
  const activeLoop = parseLoopId("loop-active-impl");
  const { root, handoff } = await completedContext(t, sourceLoop);
  const activeLayout = resolveLayout(root, activeLoop);
  await openLedger(activeLayout);

  const observations = await collectKnowledgeSources({ workspace: root, loopIds: [sourceLoop] });
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.handoff_digest, handoff.digest);

  const singleObservationInput = {
    workspace: root,
    observations,
    ...proposalFields(),
  };
  const proposal = await buildProposal(singleObservationInput);
  assert.equal(proposal.status, "PROVISIONAL");
  assert.equal(proposal.observation_count, 1);
  await assert.rejects(
    markProposalApplied({
      workspace: root,
      proposalId: proposal.proposal_id,
      implementationLoopId: activeLoop,
    }),
    /completed implementation Loop/i,
  );
});

test("Knowledge proposal binds privacy Canary rollback and source digests", async (t) => {
  const loopId = parseLoopId("loop-knowledge-fields");
  const { root, handoff } = await completedContext(t, loopId);
  const release = await writeEndedRelease(root, loopId, handoff, "RELEASED");
  const observations = await collectKnowledgeSources({ workspace: root, loopIds: [loopId] });
  assert.equal(observations[0]!.release_id, release.release_id);
  assert.equal(observations[0]!.release_phase, "RELEASED");

  const proposal = await buildProposal({
    workspace: root,
    observations,
    ...proposalFields(),
  });
  assert.equal(proposal.proposal_type, "PROJECT_KNOWLEDGE");
  assert.deepEqual(proposal.source_loop_ids, [loopId]);
  assert.deepEqual(proposal.source_handoff_digests, [handoff.digest]);
  assert.match(proposal.privacy_review, /sensitive|privacy/i);
  assert.ok(proposal.canary.length > 0);
  assert.ok(proposal.rollback.length > 0);
  assert.equal(proposal.implementation_loop_id, null);

  const markdown = await readFile(
    join(resolveLayout(root).knowledgeProposalsRoot, `${proposal.proposal_id}.md`),
    "utf8",
  );
  assert.match(markdown, /^---\n/u);
  assert.match(markdown, /^status: PROVISIONAL$/mu);
  assert.match(markdown, /privacy/i);
  assert.match(markdown, /Canary/i);
  assert.match(markdown, /[Rr]ollback/);
  assert.doesNotMatch(markdown.slice(0, markdown.indexOf("\n---", 4)), /[\u4e00-\u9fff]/u);
});

test("multi-loop observations enter REVIEW_PENDING and APPROVED does not edit production", async (t) => {
  const first = parseLoopId("loop-knowledge-a");
  const second = parseLoopId("loop-knowledge-b");
  const { root: rootA, handoff: handoffA } = await completedContext(t, first);
  // Build second completed Loop inside the same workspace.
  const layoutB = resolveLayout(rootA, second);
  const ledgerB = await openLedger(layoutB);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledgerB.transition(phase, "ACTIVE", await ledgerB.cursor());
  }
  const h0 = await forgeH0({
    loopId: second,
    repositoryId: "repository-001",
    repositoryRoot: rootA,
    readablePaths: ["src/**"],
    repositoryRulesDigest: digest("a"),
    exploreCapabilities: ["native-search"],
    networkClass: "DISABLED",
  });
  const h1 = await sealH1(executionInput(second), ledgerB);
  for (const phase of ["IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledgerB.transition(phase, "ACTIVE", await ledgerB.cursor());
  }
  await recordVerdict(rootA, second, { kind: "PASS" });
  const evidenceRecord = {
    ...evidence("E-STATIC-1"),
    loop_id: second,
    h1_digest: h1.digest,
    wave_input_digest: h1.wave_input_digest,
  };
  await finalizeHandoff({
    workspace: rootA,
    loopId: second,
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
      evidence: [evidenceRecord],
    },
    dispatchConsistent: true,
  });

  const observations = await collectKnowledgeSources({ workspace: rootA, loopIds: [first, second] });
  assert.equal(observations.length, 2);
  const proposal = await buildProposal({
    workspace: rootA,
    observations,
    ...proposalFields(),
  });
  assert.equal(proposal.status, "REVIEW_PENDING");
  assert.equal(proposal.observation_count, 2);
  assert.ok(proposal.source_handoff_digests.includes(handoffA.digest));

  const layout = resolveLayout(rootA);
  await mkdir(layout.stateRoot, { recursive: true });
  const policyContent = {
    schema_version: 1 as const,
    risk_class: "LOW" as const,
    included_paths: ["src/**"],
    excluded_paths: [] as string[],
    environment_gates: [] as [],
    allowed_tools: [] as string[],
    denied_actions: [] as [],
  };
  const policy = { ...policyContent, digest: sha256Hex(canonicalJsonBytes(policyContent)) };
  await writeFile(layout.projectPolicyJson, JSON.stringify(policy));
  const before = await snapshotDirectory(join(rootA, "src"));
  const beforePolicy = await readFile(layout.projectPolicyJson, "utf8");

  const approved = await transitionProposal({
    workspace: rootA,
    proposalId: proposal.proposal_id,
    to: "APPROVED",
    review: {
      privacy_review: "No sensitive content is included.",
      expected_benefit: "Reduce repeated review work.",
      safety_impact: "No safety boundary changes.",
      offline_evaluation: ["Replay prior cases."],
      canary: ["Use in one child Loop."],
      rollback: ["Supersede the proposal."],
      review_date: "2026-08-07",
      counterexamples: ["One-off project accident."],
    },
  });
  assert.equal(approved.status, "APPROVED");
  assert.equal(await readFile(layout.projectPolicyJson, "utf8"), beforePolicy);
  assert.deepEqual(await snapshotDirectory(join(rootA, "src")), before);
});

test("explicit user correction can leave PROVISIONAL with one observation", async (t) => {
  const loopId = parseLoopId("loop-knowledge-correction");
  const { root } = await completedContext(t, loopId);
  const observations = await collectKnowledgeSources({ workspace: root, loopIds: [loopId] });
  const proposal = await buildProposal({
    workspace: root,
    observations,
    ...proposalFields(),
    explicit_user_correction: true,
    correction_provenance: ["User corrected the Reviewer pattern in chat."],
  });
  assert.equal(proposal.observation_count, 1);
  assert.equal(proposal.explicit_user_correction, true);
  assert.equal(proposal.status, "REVIEW_PENDING");
});

test("markProposalApplied requires completed implementation Loop that cites the proposal", async (t) => {
  const sourceLoop = parseLoopId("loop-knowledge-apply-source");
  const { root } = await completedContext(t, sourceLoop);
  const observations = await collectKnowledgeSources({ workspace: root, loopIds: [sourceLoop] });
  const provisional = await buildProposal({
    workspace: root,
    observations,
    ...proposalFields(),
    explicit_user_correction: true,
    correction_provenance: ["User correction."],
  });
  const approved = await transitionProposal({
    workspace: root,
    proposalId: provisional.proposal_id,
    to: "APPROVED",
    review: {
      privacy_review: provisional.privacy_review,
      expected_benefit: provisional.expected_benefit,
      safety_impact: provisional.safety_impact,
      offline_evaluation: [...provisional.offline_evaluation],
      canary: [...provisional.canary],
      rollback: [...provisional.rollback],
      review_date: provisional.review_date,
      counterexamples: [...provisional.counterexamples],
    },
  });

  const implLoop = parseLoopId("loop-knowledge-apply-impl");
  const implLayout = resolveLayout(root, implLoop);
  const ledger = await openLedger(implLayout);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const h0 = await forgeH0({
    loopId: implLoop,
    repositoryId: "repository-001",
    repositoryRoot: root,
    readablePaths: ["src/**"],
    repositoryRulesDigest: digest("a"),
    exploreCapabilities: ["native-search"],
    networkClass: "DISABLED",
  });
  const h1 = await sealH1(executionInput(implLoop), ledger);
  for (const phase of ["IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  await recordVerdict(root, implLoop, { kind: "PASS" });
  const evidenceRecord = {
    ...evidence("E-STATIC-1"),
    loop_id: implLoop,
    h1_digest: h1.digest,
    wave_input_digest: h1.wave_input_digest,
  };
  await finalizeHandoff({
    workspace: root,
    loopId: implLoop,
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
    residualRisks: [`Implements knowledge proposal ${approved.proposal_id}.`],
    rollback: {
      target: "source-head",
      procedure: ["Restore the reviewed source head."],
      triggers: ["Verification regression."],
      estimated_recovery_minutes: 15,
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
      evidence: [evidenceRecord],
    },
    dispatchConsistent: true,
  });

  const applied = await markProposalApplied({
    workspace: root,
    proposalId: approved.proposal_id,
    implementationLoopId: implLoop,
  });
  assert.equal(applied.status, "APPLIED");
  assert.equal(applied.implementation_loop_id, implLoop);

  const typed: KnowledgeProposal = applied;
  assert.equal(typed.schema_version, 1);
});
