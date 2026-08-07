import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { sha256Hex, type Digest, type LoopId } from "../../src/contracts/domain.js";
import type { EvidenceRecord, H1Harness } from "../../src/contracts/harness.js";
import type { ScopedAuthorization } from "../../src/contracts/release.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { forgeH0, sealH1, type H1Input } from "../../src/core/harness.js";
import { finalizeHandoff, observeHandoffFreshnessFacts } from "../../src/core/handoff.js";
import { openLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";
import {
  createActionEnvelope,
  createRelease,
  executeCommit,
  markOperationUnknown,
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
  }
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(separator), GIT_OPTIONAL_LOCKS: "0" };
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { env: childEnvironment() });
  return String(result.stdout).trim();
}

async function seedGitWorkspace(root: string): Promise<void> {
  await execFileAsync("git", ["init", root], { env: childEnvironment() });
  await git(root, ["config", "user.name", "PAI Tests"]);
  await git(root, ["config", "user.email", "pai@example.invalid"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "target.ts"), "export const target = 1;\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "seed"]);
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

function authorization(): ScopedAuthorization {
  const content = {
    authorization_id: "auth-commit",
    action: "commit" as const,
    target: "main",
    environment_node: null,
    authorized_by: "owner",
    authorized_at: "2026-08-06T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  return { ...content, digest: sha256Hex(canonicalJsonBytes(content)) };
}

async function prepareReady(t: TestContext): Promise<{ root: string; loopId: LoopId }> {
  const root = await mkdtemp(join(tmpdir(), "pai-release-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedGitWorkspace(root);
  await writeFile(join(root, "src", "target.ts"), "export const target = 2;\n", "utf8");
  await git(root, ["add", "src/target.ts"]);
  const policyDigest = await writeProjectPolicy(root);
  const loopId = parseLoopId("loop-release-reconcile");
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
  assert.equal(observation.kind, "OBSERVED");
  const facts = observation.facts;
  const evidenceRecord = evidence(loopId, h1);
  await finalizeHandoff({
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
    residualRisks: ["None."],
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
      evidence: [evidenceRecord],
    },
    dispatchConsistent: true,
  });
  return { root, loopId };
}

test("Release reconcile recovers Intent response loss to idempotent completion", async (t) => {
  const { root, loopId } = await prepareReady(t);
  const release = await createRelease({
    workspace: root,
    loopId,
    allowedTargets: ["main"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const envelope = await createActionEnvelope({
    workspace: root,
    loopId,
    releaseId: release.release_id,
    action: "commit",
    target: "main",
    authorization: authorization(),
    branch: "main",
  });
  assert.equal(envelope.action, "commit");

  const intent = await recordOperationIntent({ workspace: root, envelope });
  assert.equal(intent.status, "PENDING");

  // Blind retry of a pre-existing PENDING Intent is forbidden without reconcile.
  await assert.rejects(
    () => executeCommit({ workspace: root, envelope }),
    (error: unknown) => error instanceof Error
      && /reconcile|UNKNOWN|PENDING/i.test(error.message),
  );

  // Simulate lost response after Intent was recorded: mark UNKNOWN without completing.
  const unknown = await markOperationUnknown({
    workspace: root,
    releaseId: release.release_id,
    operationId: envelope.operation_id,
  });
  assert.equal(unknown.status, "UNKNOWN");

  // Blind retry of PENDING/UNKNOWN is forbidden — reconcile first.
  await assert.rejects(
    () => executeCommit({ workspace: root, envelope }),
    /reconcile|UNKNOWN|PENDING/i,
  );

  const reconciled = await reconcileOperation({
    workspace: root,
    releaseId: release.release_id,
    operationId: envelope.operation_id,
  });
  // Commit has not landed yet — reconcile authorizes a single retry.
  assert.equal(reconciled.status, "READY_TO_RETRY");

  // After reconcile stamps READY_TO_RETRY, complete the commit once.
  const result = await executeCommit({ workspace: root, envelope });
  assert.equal(typeof result.commitSha, "string");

  const completed = await reconcileOperation({
    workspace: root,
    releaseId: release.release_id,
    operationId: envelope.operation_id,
  });
  assert.equal(completed.status, "SUCCESS");
  assert.equal(completed.result_ref, result.commitSha);

  // Idempotent completion: reconcile again stays SUCCESS.
  const again = await reconcileOperation({
    workspace: root,
    releaseId: release.release_id,
    operationId: envelope.operation_id,
  });
  assert.equal(again.status, "SUCCESS");
  assert.equal(again.result_ref, result.commitSha);

  const onDisk = JSON.parse(
    await readFile(join(root, ".ai-loop", "releases", release.release_id, "operations", `${envelope.operation_id}.json`), "utf8"),
  );
  assert.equal(onDisk.status, "SUCCESS");
});

test("Release reconcile heals SUCCESS Intent when Release still EXECUTING", async (t) => {
  const { root, loopId } = await prepareReady(t);
  const release = await createRelease({
    workspace: root,
    loopId,
    allowedTargets: ["main"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const envelope = await createActionEnvelope({
    workspace: root,
    loopId,
    releaseId: release.release_id,
    action: "commit",
    target: "main",
    authorization: authorization(),
    branch: "main",
  });
  assert.equal(envelope.action, "commit");
  const result = await executeCommit({ workspace: root, envelope });

  const releasePath = join(root, ".ai-loop", "releases", release.release_id, "release.json");
  const operationPath = join(
    root,
    ".ai-loop",
    "releases",
    release.release_id,
    "operations",
    `${envelope.operation_id}.json`,
  );
  const operation = JSON.parse(await readFile(operationPath, "utf8"));
  assert.equal(operation.status, "SUCCESS");
  assert.equal(operation.result_ref, result.commitSha);

  // Inject crash window: SUCCESS Op persisted, Release phase/SHA not yet bound.
  const current = JSON.parse(await readFile(releasePath, "utf8"));
  const content = {
    schema_version: 1 as const,
    release_id: current.release_id,
    loop_id: current.loop_id,
    handoff_digest: current.handoff_digest,
    phase: "EXECUTING" as const,
    action_envelope_digests: current.action_envelope_digests,
    operation_ids: current.operation_ids,
    created_at: current.created_at,
    updated_at: current.updated_at,
    release_commit_sha: null,
  };
  await writeFile(releasePath, JSON.stringify({
    ...content,
    digest: sha256Hex(canonicalJsonBytes(content)),
  }));

  const reconciled = await reconcileOperation({
    workspace: root,
    releaseId: release.release_id,
    operationId: envelope.operation_id,
  });
  assert.equal(reconciled.status, "SUCCESS");
  assert.equal(reconciled.result_ref, result.commitSha);

  const healed = JSON.parse(await readFile(releasePath, "utf8"));
  assert.equal(healed.phase, "RELEASED");
  assert.equal(healed.release_commit_sha, result.commitSha);
});
