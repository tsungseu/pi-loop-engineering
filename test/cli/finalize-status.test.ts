import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Hex, type Digest } from "../../src/contracts/domain.js";
import type { FinalHandoff } from "../../src/contracts/release.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { forgeH0, sealH1 } from "../../src/core/harness.js";
import { openLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";

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
  }
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(separator), GIT_OPTIONAL_LOCKS: "0" };
}

function runDist(args: readonly string[]): Promise<DistResult> {
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
  const root = await mkdtemp(join(tmpdir(), "pai-finalize-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

type DirectorySnapshot = Readonly<Record<string, string>>;

async function snapshotDirectory(root: string): Promise<DirectorySnapshot> {
  const entries: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
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

async function prepareFinalizingLoop(root: string): Promise<{
  loopId: string;
  requestPath: string;
}> {
  const started = JSON.parse((await runDist(["start", "--workspace", root, "--task", "Finalize review"])).stdout);
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
  }, ledger);
  evidenceRecord.h1_digest = h1.digest;
  for (const phase of ["IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const request = {
    loop_id: loopId,
    actor_role: "worker",
    source_head_sha: "a".repeat(40),
    reviewed_tree_digest: digest("e"),
    workspace_digest: digest("f"),
    source_manifest_digest: digest("1"),
    runtime_manifest_digest: digest("2"),
    project_policy_digest: h1.project_policy_digest,
    h0,
    h1,
    loop_markdown_digest: digest("3"),
    agent_bundle_digests: [digest("4")],
    evidence_manifest_digest: digest("5"),
    evidence: [evidenceRecord],
    review_verdict: "PASS",
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
    finding_states: [
      { findingId: "F-1", status: "VERIFIED", severity: "HIGH", area: "src/a.ts", sourceDigest: digest("9") },
    ],
  };
  const requestPath = join(root, "finalize-request.json");
  await writeFile(requestPath, JSON.stringify(request));
  return { loopId, requestPath };
}

test("loopctl finalize writes an immutable Handoff and reaches HANDOFF_READY", async (t) => {
  const root = await workspace(t);
  const { loopId, requestPath } = await prepareFinalizingLoop(root);
  const result = await runDist(["finalize", "--workspace", root, "--request", requestPath]);
  assert.equal(result.exitCode, 0, result.stderr);
  const handoff = JSON.parse(result.stdout) as FinalHandoff;
  assert.equal(handoff.review_verdict, "PASS");
  assert.match(handoff.digest, /^[0-9a-f]{64}$/u);
  const layout = resolveLayout(root, parseLoopId(loopId));
  const onDisk = JSON.parse(await readFile(layout.handoffJson, "utf8")) as FinalHandoff;
  assert.equal(onDisk.digest, handoff.digest);
  const snapshot = JSON.parse(await readFile(layout.loopJson, "utf8"));
  assert.equal(snapshot.phase, "HANDOFF_READY");
  assert.equal(snapshot.status, "COMPLETE");
  assert.equal(snapshot.handoff_digest, handoff.digest);
});

test("loopctl final status reports Review gates Finding ownership Handoff and Release recommendations without writes", async (t) => {
  const root = await workspace(t);
  const { loopId, requestPath } = await prepareFinalizingLoop(root);
  assert.equal((await runDist(["finalize", "--workspace", root, "--request", requestPath])).exitCode, 0);
  const before = await snapshotDirectory(join(root, ".ai-loop"));
  const result = await runDist(["status", "--workspace", root, "--loop-id", loopId]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.reviewGates));
  assert.ok(Array.isArray(report.findingOwnership));
  assert.equal(typeof report.handoff?.digest, "string");
  assert.equal(report.handoff?.freshness, "FRESH");
  assert.ok(Array.isArray(report.rollback?.procedure));
  assert.ok(Array.isArray(report.residualRisks));
  assert.ok(Array.isArray(report.recommendedReleaseActions));
  assert.deepEqual(await snapshotDirectory(join(root, ".ai-loop")), before);
});

test("loopctl child-loop creates a child without overwriting parent Handoff", async (t) => {
  const root = await workspace(t);
  const { loopId, requestPath } = await prepareFinalizingLoop(root);
  assert.equal((await runDist(["finalize", "--workspace", root, "--request", requestPath])).exitCode, 0);
  const layout = resolveLayout(root, parseLoopId(loopId));
  const before = await readFile(layout.handoffJson);
  const result = await runDist([
    "child-loop",
    "--workspace", root,
    "--parent-loop-id", loopId,
    "--reason", "STALE_HANDOFF",
    "--task", "Re-finalize after Source drift.",
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.parent_loop_id, loopId);
  assert.notEqual(child.loop_id, loopId);
  assert.deepEqual(await readFile(layout.handoffJson), before);
});

test("loopctl review-admit and finding-update enforce independent Reviewer ownership", async (t) => {
  const root = await workspace(t);
  const started = JSON.parse((await runDist(["start", "--workspace", root, "--task", "Review ownership"])).stdout);
  const loopId = started.loop_id as string;
  const layout = resolveLayout(root, parseLoopId(loopId));
  const ledger = await openLedger(layout);
  for (const phase of [
    "CONTRACTED", "PLANNED", "HARNESSING", "IMPLEMENTING", "VERIFYING", "REVIEWING",
  ] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const admitPath = join(root, "review-admit.json");
  await writeFile(admitPath, JSON.stringify({
    loop_id: loopId,
    gate: "FINAL_DIFF",
    reviewer_actor: "reviewer-a",
    implementer_actors: ["implementer-a"],
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    source_digest: digest("a"),
    diff_coordinates: ["src/a.ts"],
    acceptance: ["Tests pass."],
    verification_evidence_ids: ["E-1"],
    private_output_root: join(layout.loopRoot, "reviewer-private"),
  }));
  assert.equal((await runDist(["review-admit", "--workspace", root, "--request", admitPath])).exitCode, 0);

  const openPath = join(root, "finding-open.json");
  await writeFile(openPath, JSON.stringify({
    loop_id: loopId,
    finding_id: "F-1",
    actor_role: "reviewer",
    status: "OPEN",
    source_digest: digest("a"),
    area: "src/a.ts",
    severity: "HIGH",
  }));
  assert.equal((await runDist(["finding-update", "--workspace", root, "--request", openPath])).exitCode, 0);

  const badVerify = join(root, "finding-bad.json");
  await writeFile(badVerify, JSON.stringify({
    loop_id: loopId,
    finding_id: "F-1",
    actor_role: "implementer",
    status: "VERIFIED",
    source_digest: digest("a"),
    area: "src/a.ts",
    severity: "HIGH",
  }));
  const rejected = await runDist(["finding-update", "--workspace", root, "--request", badVerify]);
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr, /independent reviewer/i);

  const verdictPath = join(root, "verdict.json");
  await writeFile(verdictPath, JSON.stringify({
    loop_id: loopId,
    risk: "LOW",
    completed_gates: ["FINAL_DIFF"],
    findings: [{ findingId: "F-1", status: "OPEN", severity: "HIGH", area: "src/a.ts", sourceDigest: digest("a") }],
    evidence_fresh: true,
    oscillation: false,
    budgets: {
      attemptsUsed: 0, attempts: 3, reviewsUsed: 0, reviews: 2, transitionsUsed: 0, transitions: 10,
    },
  }));
  const verdict = await runDist(["verdict", "--workspace", root, "--request", verdictPath]);
  assert.equal(verdict.exitCode, 0, verdict.stderr);
  assert.equal(JSON.parse(verdict.stdout).kind, "BLOCKED");
});

// Keep the digest helper referenced for local assertion helpers if needed later.
void sha256Hex;
void canonicalJsonBytes;
