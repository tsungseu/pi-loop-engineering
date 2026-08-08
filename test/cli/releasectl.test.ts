import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256Hex, type Digest } from "../../src/contracts/domain.js";
import type { FinalHandoff, ScopedAuthorization } from "../../src/contracts/release.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { forgeH0, sealH1 } from "../../src/core/harness.js";
import { observeHandoffFreshnessFacts } from "../../src/core/handoff.js";
import { openLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";
import { recordVerdict } from "../../src/core/review.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const digest = (character: string): Digest => character.repeat(64) as Digest;

interface DistResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

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

function runRelease(args: readonly string[]): Promise<DistResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "dist", "cli", "releasectl.js"), ...args], {
      cwd: repositoryRoot,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolvePromise({ exitCode: code, stdout, stderr }));
  });
}

function runLoop(args: readonly string[]): Promise<DistResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "dist", "cli", "loopctl.js"), ...args], {
      cwd: repositoryRoot,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolvePromise({ exitCode: code, stdout, stderr }));
  });
}

async function workspace(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pai-releasectl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
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

async function seedGitWorkspace(root: string): Promise<void> {
  await execFileAsync("git", ["init", root], { env: childEnvironment() });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "target.ts"), "export const target = 1;\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "."], { env: childEnvironment() });
  await execFileAsync("git", [
    "-C", root, "-c", "user.name=PAI Tests", "-c", "user.email=pai@example.invalid",
    "commit", "-m", "seed",
  ], { env: childEnvironment() });
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

function authorization(expiresAt: string): ScopedAuthorization {
  const content = {
    authorization_id: "auth-commit",
    action: "commit" as const,
    target: "main",
    environment_node: null,
    authorized_by: "owner",
    authorized_at: "2026-08-06T00:00:00.000Z",
    expires_at: expiresAt,
  };
  return { ...content, digest: sha256Hex(canonicalJsonBytes(content)) };
}

async function prepareFinalizedLoop(root: string): Promise<{ loopId: string; handoff: FinalHandoff }> {
  await seedGitWorkspace(root);
  const policyDigest = await writeProjectPolicy(root);
  const started = JSON.parse((await runLoop(["start", "--workspace", root, "--task", "Release readiness"])).stdout);
  const loopId = started.loop_id as string;
  const layout = resolveLayout(root, parseLoopId(loopId));
  const ledger = await openLedger(layout);
  for (const phase of ["CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const h0 = await forgeH0({
    loopId: parseLoopId(loopId),
    repositoryId: "repository-001",
    repositoryRoot: root,
    readablePaths: ["**"],
    repositoryRulesDigest: digest("a"),
    exploreCapabilities: ["native-search"],
    networkClass: "DISABLED",
  });
  await mkdir(layout.harnessRoot, { recursive: true });
  await writeFile(join(layout.harnessRoot, "h0-discovery.json"), JSON.stringify(h0));
  const evidenceRecord = {
    schema_version: 1,
    evidence_id: "E-STATIC-1",
    loop_id: loopId,
    work_item_id: "work-1",
    attempt: 1,
    actor_role: "worker",
    h1_digest: digest("0"),
    wave_input_digest: digest("b"),
    output_tree_digest: digest("3"),
    argv: ["node", "--version"],
    executable_path: process.execPath,
    executable_digest: digest("4"),
    version_argv: [process.execPath, "--version"],
    cwd: root,
    timeout_ms: 5_000,
    stdout_limit_bytes: 1_024,
    stderr_limit_bytes: 1_024,
    started_at: "2026-08-06T00:00:00.000Z",
    ended_at: "2026-08-06T00:00:01.000Z",
    exit_code: 0,
    exit_signal: null,
    termination_path: "exit",
    environment_digest: digest("5"),
    tool_versions: { node: process.version },
    stdout_path: "stdout.bin",
    stdout_digest: digest("6"),
    stderr_path: "stderr.bin",
    stderr_digest: digest("7"),
    artifact_manifest_digest: digest("8"),
    result: "PASS",
  };
  const h1 = await sealH1({
    loopId: parseLoopId(loopId),
    objective: "Ship a bounded change.",
    acceptance: ["Tests pass."],
    outOfScope: ["Unrelated modules."],
    readablePaths: ["src/**"],
    writablePaths: ["src/output.ts"],
    waveInputDigest: digest("b"),
    projectPolicyDigest: policyDigest,
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
  }, ledger);
  evidenceRecord.h1_digest = h1.digest;
  for (const phase of ["IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  await recordVerdict(root, parseLoopId(loopId), { kind: "PASS" });
  const observation = await observeHandoffFreshnessFacts(root, parseLoopId(loopId));
  assert.equal(observation.kind, "OBSERVED", observation.kind === "UNKNOWN" ? observation.reason : "");
  const facts = observation.facts;
  const request = {
    loop_id: loopId,
    actor_role: "worker",
    source_head_sha: facts.sourceHeadSha,
    reviewed_tree_digest: facts.reviewedTreeDigest,
    workspace_digest: facts.workspaceDigest,
    source_manifest_digest: facts.sourceManifestDigest,
    runtime_manifest_digest: facts.runtimeManifestDigest,
    project_policy_digest: facts.projectPolicyDigest,
    h0,
    h1,
    loop_markdown_digest: facts.loopMarkdownDigest,
    agent_bundle_digests: [digest("4")],
    evidence_manifest_digest: facts.evidenceManifestDigest,
    evidence: [evidenceRecord],
    residual_risks: ["No residual Critical Findings."],
    rollback: {
      target: "source-head",
      procedure: ["Restore the reviewed source head."],
      triggers: ["Verification regression."],
      estimated_recovery_minutes: 10,
    },
    recommended_release_actions: ["commit"],
    harness_facts: {
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
    dispatch_consistent: true,
  };
  const requestPath = join(layout.loopRoot, "finalize-request.json");
  await writeFile(requestPath, JSON.stringify(request));
  const finalized = await runLoop(["finalize", "--workspace", root, "--request", requestPath]);
  assert.equal(finalized.exitCode, 0, finalized.stderr);
  return { loopId, handoff: JSON.parse(finalized.stdout) as FinalHandoff };
}

test("releasectl readiness does not mutate state", async (t) => {
  const root = await workspace(t);
  const { loopId } = await prepareFinalizedLoop(root);
  const before = await snapshotDirectory(join(root, ".ai-loop"));
  const result = await runRelease(["readiness", "--workspace", root, "--loop-id", loopId]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.deepEqual(await snapshotDirectory(join(root, ".ai-loop")), before);
});

test("releasectl readiness rejects stage Handoffs", async (t) => {
  const root = await workspace(t);
  await seedGitWorkspace(root);
  const started = JSON.parse((await runLoop(["start", "--workspace", root, "--task", "Still implementing"])).stdout);
  const result = await runRelease(["readiness", "--workspace", root, "--loop-id", started.loop_id]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.ok(report.blockers.length > 0);
});

test("releasectl action creates Release and executes commit", async (t) => {
  const root = await workspace(t);
  const { loopId } = await prepareFinalizedLoop(root);
  const authPath = join(root, ".ai-loop", "authorization-commit.json");
  await writeFile(authPath, JSON.stringify(authorization("2099-01-01T00:00:00.000Z")));
  const result = await runRelease([
    "action",
    "--workspace", root,
    "--loop-id", loopId,
    "--action", "commit",
    "--target", "main",
    "--authorization", authPath,
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(typeof output.release?.release_id, "string");
  assert.equal(output.envelope?.action, "commit");
  assert.equal(typeof output.commit?.commitSha, "string");
  const releases = await readdir(join(root, ".ai-loop", "releases"));
  assert.equal(releases.length, 1);
});
