import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { LoopError, sha256Hex, type Digest, type LoopId } from "../../src/contracts/domain.js";
import type { EvidenceRecord, H0Harness, H1Harness } from "../../src/contracts/harness.js";
import type {
  CommitActionEnvelope,
  FinalHandoff,
  PhysicalActionEnvelope,
  ScopedAuthorization,
} from "../../src/contracts/release.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { forgeH0, sealH1, type H1Input } from "../../src/core/harness.js";
import {
  finalizeHandoff,
  observeHandoffFreshnessFacts,
  writeCheckpoint,
  type FinalizeInput,
} from "../../src/core/handoff.js";
import { openLedger } from "../../src/core/ledger.js";
import { CONTROL_EXCLUSIONS, buildTreeManifest } from "../../src/core/manifests.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../../src/core/paths.js";
import {
  assertPhysicalAuthorization,
  checkReadiness,
  createActionEnvelope,
  createRelease,
  executeCommit,
  recordOperationIntent,
  reconcileOperation,
} from "../../src/core/release.js";
import { recordVerdict } from "../../src/core/review.js";

const execFileAsync = promisify(execFile);
const digest = (character: string): Digest => character.repeat(64) as Digest;

function childEnvironment(): NodeJS.ProcessEnv {
  const separator = process.platform === "win32" ? ";" : ":";
  const extra = [dirname(process.execPath)];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    extra.push(join(systemRoot, "System32"), systemRoot);
    for (const gitDirectory of [
      process.env.LOCALAPPDATA === undefined ? "" : join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd"),
      process.env.ProgramFiles === undefined ? "" : join(process.env.ProgramFiles, "Git", "cmd"),
    ]) {
      if (gitDirectory !== "") extra.push(gitDirectory);
    }
  }
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(separator), GIT_OPTIONAL_LOCKS: "0" };
}

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

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { env: childEnvironment() });
  return String(result.stdout).trim();
}

async function seedGitWorkspace(root: string): Promise<string> {
  await execFileAsync("git", ["init", root], { env: childEnvironment() });
  await git(root, ["config", "user.name", "PAI Tests"]);
  await git(root, ["config", "user.email", "pai@example.invalid"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "target.ts"), "export const target = 1;\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "seed"]);
  return git(root, ["rev-parse", "HEAD"]);
}

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

function executionInput(loopId: LoopId, projectPolicyDigest: Digest): H1Input {
  return {
    loopId,
    objective: "Ship a bounded change.",
    acceptance: ["Tests pass."],
    outOfScope: ["Unrelated modules."],
    readablePaths: ["src/**"],
    writablePaths: ["src/output.ts"],
    waveInputDigest: digest("b"),
    projectPolicyDigest,
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
      { capability: "finalize", enforcement: "ORCHESTRATION_ONLY" },
    ],
    budgets: { attempts: 3, reviews: 2, transitions: 20 },
    stopRules: ["Stop on drift."],
    resultSchemas: ["agent-result"],
    planReview: "PASSED",
  };
}

async function writeProjectPolicy(root: string): Promise<Digest> {
  const layout = resolveLayout(root);
  await mkdir(layout.stateRoot, { recursive: true });
  const content = {
    schema_version: 1 as const,
    risk_class: "LOW" as const,
    included_paths: ["src/**"],
    excluded_paths: [] as string[],
    environment_gates: [] as [],
    allowed_tools: [] as string[],
    denied_actions: [] as [],
  };
  const policy = { ...content, digest: sha256Hex(canonicalJsonBytes(content)) };
  await writeFile(layout.projectPolicyJson, JSON.stringify(policy));
  return policy.digest;
}

async function finalizeReady(
  root: string,
  loopId: LoopId,
  policyDigest: Digest,
): Promise<{ layout: LoopLayout; handoff: FinalHandoff; h0: H0Harness; h1: H1Harness }> {
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
  await mkdir(layout.harnessRoot, { recursive: true });
  await writeFile(join(layout.harnessRoot, "h0-discovery.json"), JSON.stringify(h0));
  await writeFile(layout.loopMarkdown, "# Loop\n\nShip a bounded change.\n", "utf8");
  const h1 = await sealH1(executionInput(loopId, policyDigest), ledger);
  for (const phase of ["IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  await recordVerdict(root, loopId, { kind: "PASS" });
  const observation = await observeHandoffFreshnessFacts(root, loopId);
  assert.equal(observation.kind, "OBSERVED", observation.kind === "UNKNOWN" ? observation.reason : "");
  const facts = observation.facts;
  const evidenceRecord = evidence(loopId, h1);
  const input: FinalizeInput = {
    workspace: root,
    loopId,
    actorRole: "worker",
    sourceHeadSha: facts.sourceHeadSha,
    reviewedTreeDigest: facts.reviewedTreeDigest,
    workspaceDigest: facts.workspaceDigest,
    sourceManifestDigest: facts.sourceManifestDigest,
    runtimeManifestDigest: facts.runtimeManifestDigest,
    projectPolicyDigest: facts.projectPolicyDigest,
    h0,
    h1,
    loopMarkdownDigest: facts.loopMarkdownDigest,
    agentBundleDigests: [digest("4")],
    evidenceManifestDigest: facts.evidenceManifestDigest,
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
  };
  const handoff = await finalizeHandoff(input);
  return { layout, handoff, h0, h1 };
}

async function prepareReadyLoop(t: TestContext, suffix: string): Promise<{
  root: string;
  layout: LoopLayout;
  loopId: LoopId;
  handoff: FinalHandoff;
  headSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pai-release-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const headSha = await seedGitWorkspace(root);
  const policyDigest = await writeProjectPolicy(root);
  const loopId = parseLoopId(`loop-release-${suffix}`);
  const { layout, handoff } = await finalizeReady(root, loopId, policyDigest);
  return { root, layout, loopId, handoff, headSha };
}

function authorization(
  action: ScopedAuthorization["action"],
  target: string,
  environmentNode: ScopedAuthorization["environment_node"],
  expiresAt: string,
): ScopedAuthorization {
  const content = {
    authorization_id: `auth-${action}`,
    action,
    target,
    environment_node: environmentNode,
    authorized_by: "owner",
    authorized_at: "2026-08-06T00:00:00.000Z",
    expires_at: expiresAt,
  };
  return { ...content, digest: sha256Hex(canonicalJsonBytes(content)) };
}

function hilEnvelope(overrides: Partial<PhysicalActionEnvelope> = {}): PhysicalActionEnvelope {
  const auth = authorization("run-hil", "robot-A", "HIL", "2026-08-07T12:00:00.000Z");
  return {
    schema_version: 1,
    operation_id: "operation-hil-001",
    release_id: "release-001",
    handoff_digest: digest("h"),
    target: "robot-A",
    source_head_sha: "a".repeat(40),
    reviewed_tree_digest: digest("t"),
    authorization: auth,
    metadata_digest: digest("m"),
    action: "run-hil",
    release_commit_sha: "b".repeat(40),
    environment_node: "HIL",
    ...overrides,
  };
}

test("readiness-only creates no Release files", async (t) => {
  const { root, loopId } = await prepareReadyLoop(t, "ready");
  const before = await snapshotDirectory(join(root, ".ai-loop"));
  const report = await checkReadiness({ workspace: root, loopId });
  assert.equal(report.ready, true);
  assert.equal(report.loopId, loopId);
  assert.match(report.handoffDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(report.blockers, []);
  assert.ok(report.allowedActions.includes("commit"));
  assert.deepEqual(await snapshotDirectory(join(root, ".ai-loop")), before);
});

test("Release Action Envelope binds Handoff and creates independent Release state", async (t) => {
  const { root, loopId, handoff } = await prepareReadyLoop(t, "create");
  const release = await createRelease({
    workspace: root,
    loopId,
    allowedTargets: ["main", "robot-A"],
    expiresAt: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(release.loop_id, loopId);
  assert.equal(release.handoff_digest, handoff.digest);
  assert.equal(release.phase, "READY");
  const releaseDir = join(root, ".ai-loop", "releases", release.release_id);
  const releaseJson = JSON.parse(await readFile(join(releaseDir, "release.json"), "utf8"));
  assert.equal(releaseJson.release_id, release.release_id);
  const harness = JSON.parse(await readFile(join(releaseDir, "release-harness.json"), "utf8"));
  assert.equal(harness.kind, "RELEASE");
  assert.equal(harness.handoff_digest, handoff.digest);
  assert.equal(harness.allowed_tools.includes("source-write"), false);
  const envelope = await createActionEnvelope({
    workspace: root,
    loopId,
    releaseId: release.release_id,
    action: "commit",
    target: "main",
    authorization: authorization("commit", "main", null, "2026-08-08T00:00:00.000Z"),
    branch: "main",
  });
  assert.equal(envelope.action, "commit");
  assert.equal(envelope.handoff_digest, handoff.digest);
  assert.equal(envelope.reviewed_tree_digest, handoff.reviewed_tree_digest);
});

test("commit packages the reviewed Tree without editing content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-release-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const headSha = await seedGitWorkspace(root);
  await writeFile(join(root, "src", "target.ts"), "export const target = 2;\n", "utf8");
  await git(root, ["add", "src/target.ts"]);
  const beforeBytes = await readFile(join(root, "src", "target.ts"));
  const policyDigest = await writeProjectPolicy(root);
  const loopId = parseLoopId("loop-release-commit-pack");
  const { handoff } = await finalizeReady(root, loopId, policyDigest);
  const release = await createRelease({
    workspace: root,
    loopId,
    allowedTargets: ["main"],
    expiresAt: "2026-08-08T00:00:00.000Z",
  });
  const validCommitEnvelope = await createActionEnvelope({
    workspace: root,
    loopId,
    releaseId: release.release_id,
    action: "commit",
    target: "main",
    authorization: authorization("commit", "main", null, "2026-08-08T00:00:00.000Z"),
    branch: "main",
  });
  assert.equal(validCommitEnvelope.action, "commit");
  const result = await executeCommit({ workspace: root, envelope: validCommitEnvelope });
  assert.equal(result.treeDigest, handoff.reviewed_tree_digest);
  assert.equal(result.parentSha, validCommitEnvelope.expected_parent_sha);
  assert.deepEqual(await readFile(join(root, "src", "target.ts")), beforeBytes);
  const tree = await buildTreeManifest({ root, include: [], exclusions: [...CONTROL_EXCLUSIONS] });
  assert.equal(tree.digest, handoff.reviewed_tree_digest);
  assert.notEqual(result.commitSha, headSha);
});

test("physical action requires unexpired action-target-environment authorization", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const expired = "2026-08-06T00:00:00.000Z";
  const base = hilEnvelope();
  assert.throws(
    () => assertPhysicalAuthorization({
      ...base,
      authorization: authorization("run-hil", "robot-A", "HIL", expired),
    }, now),
    /AUTHORIZATION_REQUIRED/,
  );
  assert.throws(
    () => assertPhysicalAuthorization({
      ...base,
      target: "robot-B",
      authorization: authorization("run-hil", "robot-A", "HIL", "2026-08-07T12:00:00.000Z"),
    }, now),
    /AUTHORIZATION_REQUIRED/,
  );
  assert.throws(
    () => assertPhysicalAuthorization({
      ...base,
      environment_node: "BENCH",
      authorization: authorization("run-hil", "robot-A", "HIL", "2026-08-07T12:00:00.000Z"),
    }, now),
    /AUTHORIZATION_REQUIRED/,
  );
  assert.doesNotThrow(() => assertPhysicalAuthorization(base, now));
});

test("Release rejects stale Handoff before mutable actions", async (t) => {
  const { root, loopId } = await prepareReadyLoop(t, "stale");
  await writeFile(join(root, "src", "target.ts"), "export const target = 99;\n", "utf8");
  await assert.rejects(
    () => createRelease({
      workspace: root,
      loopId,
      allowedTargets: ["main"],
      expiresAt: "2026-08-08T00:00:00.000Z",
    }),
    (error: unknown) => error instanceof LoopError && error.code === "STALE_HANDOFF",
  );
});

test("Checkpoint Loops are not Release-ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-release-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedGitWorkspace(root);
  await writeProjectPolicy(root);
  const loopId = parseLoopId("loop-release-checkpoint");
  const layout = resolveLayout(root, loopId);
  const ledger = await openLedger(layout);
  await ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor());
  await writeCheckpoint({
    workspace: root,
    loopId,
    sourceHeadSha: "a".repeat(40),
    completedWorkItemIds: [],
    evidenceIds: [],
    blocker: "Waiting on Review.",
    resumeEntry: "Resume at REVIEWING.",
    status: "PAUSED",
  });
  const report = await checkReadiness({ workspace: root, loopId });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((blocker: string) => /HANDOFF_READY|COMPLETE|Checkpoint/i.test(blocker)));
});

test("Action Envelope Operation Intent supports idempotent completion", async (t) => {
  const { root, loopId, handoff } = await prepareReadyLoop(t, "intent");
  const release = await createRelease({
    workspace: root,
    loopId,
    allowedTargets: ["main"],
    expiresAt: "2026-08-08T00:00:00.000Z",
  });
  const envelope = await createActionEnvelope({
    workspace: root,
    loopId,
    releaseId: release.release_id,
    action: "commit",
    target: "main",
    authorization: authorization("commit", "main", null, "2026-08-08T00:00:00.000Z"),
    branch: "main",
  });
  const intent = await recordOperationIntent({ workspace: root, envelope });
  assert.equal(intent.status, "PENDING");
  assert.equal(intent.operation_id, envelope.operation_id);
  assert.equal(intent.handoff_digest, handoff.digest);
  const again = await recordOperationIntent({ workspace: root, envelope });
  assert.equal(again.operation_id, intent.operation_id);
  assert.equal(again.status, "PENDING");
});

test("Release create progresses NEW through VALIDATING_HANDOFF to READY", async (t) => {
  const { root, loopId } = await prepareReadyLoop(t, "phases");
  const release = await createRelease({
    workspace: root,
    loopId,
    allowedTargets: ["main"],
    expiresAt: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(release.phase, "READY");
  const envelope = await createActionEnvelope({
    workspace: root,
    loopId,
    releaseId: release.release_id,
    action: "commit",
    target: "main",
    authorization: authorization("commit", "main", null, "2026-08-08T00:00:00.000Z"),
    branch: "main",
  });
  const afterEnvelope = JSON.parse(
    await readFile(join(root, ".ai-loop", "releases", release.release_id, "release.json"), "utf8"),
  );
  assert.equal(afterEnvelope.phase, "AWAITING_AUTHORIZATION");
  assert.equal(envelope.action, "commit");
  await executeCommit({ workspace: root, envelope: envelope as CommitActionEnvelope });
  const afterCommit = JSON.parse(
    await readFile(join(root, ".ai-loop", "releases", release.release_id, "release.json"), "utf8"),
  );
  assert.equal(afterCommit.phase, "RELEASED");
  assert.match(afterCommit.release_commit_sha, /^[0-9a-f]{40,64}$/u);
});

test("PENDING Operation Intent refuses blind executeCommit retry", async (t) => {
  const { root, loopId } = await prepareReadyLoop(t, "pending-retry");
  const release = await createRelease({
    workspace: root,
    loopId,
    allowedTargets: ["main"],
    expiresAt: "2026-08-08T00:00:00.000Z",
  });
  const envelope = await createActionEnvelope({
    workspace: root,
    loopId,
    releaseId: release.release_id,
    action: "commit",
    target: "main",
    authorization: authorization("commit", "main", null, "2026-08-08T00:00:00.000Z"),
    branch: "main",
  });
  assert.equal(envelope.action, "commit");
  const commitEnvelope = envelope as CommitActionEnvelope;
  const intent = await recordOperationIntent({ workspace: root, envelope: commitEnvelope });
  assert.equal(intent.status, "PENDING");

  await assert.rejects(
    () => executeCommit({ workspace: root, envelope: commitEnvelope }),
    (error: unknown) => error instanceof LoopError
      && error.code === "RECONCILE_REQUIRED"
      && /PENDING|UNKNOWN|reconcile/i.test(error.message),
  );

  const reconciled = await reconcileOperation({
    workspace: root,
    releaseId: release.release_id,
    operationId: commitEnvelope.operation_id,
  });
  assert.equal(reconciled.status, "PENDING");

  const result = await executeCommit({ workspace: root, envelope: commitEnvelope, allowAfterReconcile: true });
  assert.equal(typeof result.commitSha, "string");
  const completed = await reconcileOperation({
    workspace: root,
    releaseId: release.release_id,
    operationId: commitEnvelope.operation_id,
  });
  assert.equal(completed.status, "SUCCESS");
  assert.equal(completed.result_ref, result.commitSha);
});

test("recordOperationIntent rejects envelope_digest mismatch", async (t) => {
  const { root, loopId } = await prepareReadyLoop(t, "envelope-mismatch");
  const release = await createRelease({
    workspace: root,
    loopId,
    allowedTargets: ["main"],
    expiresAt: "2026-08-08T00:00:00.000Z",
  });
  const envelope = await createActionEnvelope({
    workspace: root,
    loopId,
    releaseId: release.release_id,
    action: "commit",
    target: "main",
    authorization: authorization("commit", "main", null, "2026-08-08T00:00:00.000Z"),
    branch: "main",
  });
  await recordOperationIntent({ workspace: root, envelope });
  assert.equal(envelope.action, "commit");
  const drifted = {
    ...envelope,
    target: "other-branch",
    branch: "other-branch",
  } as CommitActionEnvelope;
  await assert.rejects(
    () => recordOperationIntent({ workspace: root, envelope: drifted }),
    (error: unknown) => error instanceof LoopError
      && error.code === "SCHEMA_INVALID"
      && /envelope_digest/i.test(error.message),
  );
});
