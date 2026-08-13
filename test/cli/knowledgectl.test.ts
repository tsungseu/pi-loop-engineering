import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Digest } from "../../src/contracts/domain.js";
import type { FinalHandoff } from "../../src/contracts/release.js";
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

function runKnowledge(args: readonly string[]): Promise<DistResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "dist", "cli", "knowledgectl.js"), ...args], {
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
  const root = await mkdtemp(join(tmpdir(), "pi-knowledgectl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function seedGitWorkspace(root: string): Promise<void> {
  await execFileAsync("git", ["init", root], { env: childEnvironment() });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "target.ts"), "export const target = 1;\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "."], { env: childEnvironment() });
  await execFileAsync("git", [
    "-C", root, "-c", "user.name=PI Tests", "-c", "user.email=pi@example.invalid",
    "commit", "-m", "seed",
  ], { env: childEnvironment() });
}

async function prepareFinalizedLoop(root: string, task: string): Promise<{ loopId: string; handoff: FinalHandoff }> {
  const started = JSON.parse((await runLoop(["start", "--workspace", root, "--task", task])).stdout);
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

test("knowledgectl propose defaults to en-US and localizes Markdown only for zh-CN", async (t) => {
  const root = await workspace(t);
  await seedGitWorkspace(root);
  const { loopId } = await prepareFinalizedLoop(root, "Knowledge propose");
  const en = await runKnowledge([
    "propose",
    "--workspace", root,
    "--loop-id", loopId,
  ]);
  assert.equal(en.exitCode, 0, en.stderr);
  const enProposal = JSON.parse(en.stdout);
  assert.equal(enProposal.status, "PROVISIONAL");
  assert.equal(enProposal.markdown_language, "en-US");
  assert.doesNotMatch(JSON.stringify(enProposal), /[\u4e00-\u9fff]/u);

  const enMarkdown = await readFile(
    join(resolveLayout(root).knowledgeProposalsRoot, `${enProposal.proposal_id}.md`),
    "utf8",
  );
  assert.match(enMarkdown, /Privacy/i);
  assert.match(enMarkdown, /Canary/i);
  assert.match(enMarkdown, /Rollback/i);

  const zh = await runKnowledge([
    "propose",
    "--workspace", root,
    "--loop-id", loopId,
    "--markdown-language", "zh-CN",
  ]);
  assert.equal(zh.exitCode, 0, zh.stderr);
  const zhProposal = JSON.parse(zh.stdout);
  assert.equal(zhProposal.markdown_language, "zh-CN");
  assert.doesNotMatch(JSON.stringify(zhProposal), /[\u4e00-\u9fff]/u);
  const zhMarkdown = await readFile(
    join(resolveLayout(root).knowledgeProposalsRoot, `${zhProposal.proposal_id}.md`),
    "utf8",
  );
  assert.match(zhMarkdown, /[\u4e00-\u9fff]/u);
  assert.match(zhMarkdown, /^status: PROVISIONAL$/mu);
  assert.match(zhMarkdown, /^markdown_language: zh-CN$/mu);
});

test("knowledgectl rejects active sources and direct application", async (t) => {
  const root = await workspace(t);
  await seedGitWorkspace(root);
  const started = JSON.parse((await runLoop(["start", "--workspace", root, "--task", "Still active"])).stdout);
  const active = await runKnowledge([
    "propose",
    "--workspace", root,
    "--loop-id", started.loop_id,
  ]);
  assert.notEqual(active.exitCode, 0);
  assert.match(`${active.stdout}${active.stderr}`, /completed Loop/i);

  const { loopId } = await prepareFinalizedLoop(root, "Knowledge apply reject");
  const proposed = await runKnowledge([
    "propose",
    "--workspace", root,
    "--loop-id", loopId,
  ]);
  assert.equal(proposed.exitCode, 0, proposed.stderr);
  const proposal = JSON.parse(proposed.stdout);
  const reviewPath = join(root, "review.json");
  await writeFile(reviewPath, JSON.stringify({
    privacy_review: proposal.privacy_review,
    expected_benefit: proposal.expected_benefit,
    safety_impact: proposal.safety_impact,
    offline_evaluation: proposal.offline_evaluation,
    canary: proposal.canary,
    rollback: proposal.rollback,
    review_date: proposal.review_date,
    counterexamples: proposal.counterexamples,
  }));
  const transition = await runKnowledge([
    "transition",
    "--workspace", root,
    "--proposal-id", proposal.proposal_id,
    "--to", "APPROVED",
    "--review", reviewPath,
  ]);
  // Single observation stays PROVISIONAL; move via REVISE/REVIEW path or reject direct APPLIED.
  // Approve may be invalid from PROVISIONAL without REVIEW_PENDING — either way mark-applied must fail.
  void transition;
  const mark = await runKnowledge([
    "mark-applied",
    "--workspace", root,
    "--proposal-id", proposal.proposal_id,
    "--implementation-loop-id", started.loop_id,
  ]);
  assert.notEqual(mark.exitCode, 0);
  assert.match(`${mark.stdout}${mark.stderr}`, /completed implementation Loop/i);
});
