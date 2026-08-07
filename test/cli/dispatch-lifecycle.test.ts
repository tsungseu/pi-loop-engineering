import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256Hex, type Digest, type LoopId } from "../../src/contracts/domain.js";
import type { WaveInput } from "../../src/contracts/dispatch.js";
import { atomicWriteJson, canonicalJsonBytes } from "../../src/core/atomic-json.js";
import { sealH1 } from "../../src/core/harness.js";
import { openLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";

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
  return {
    ...process.env,
    PATH: [...extra, process.env.PATH ?? ""].join(separator),
    GIT_OPTIONAL_LOCKS: "0",
  };
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

async function prepareLoopWorkspace(): Promise<{
  root: string;
  loopId: LoopId;
  h1Digest: Digest;
  waveDigest: Digest;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pai-dispatch-cli-"));
  await execFileAsync("git", ["init", root], { env: childEnvironment() });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "target.ts"), "export const target = 1;\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "."], { env: childEnvironment() });
  await execFileAsync("git", [
    "-C", root, "-c", "user.name=PAI Tests", "-c", "user.email=pai@example.invalid",
    "commit", "-m", "seed",
  ], { env: childEnvironment() });
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { env: childEnvironment() });
  const baseSha = stdout.trim();

  const loopId = parseLoopId("loop-cli-dispatch");
  const layout = resolveLayout(root, loopId);
  const ledger = await openLedger(layout);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const waveContent = {
    schema_version: 1 as const,
    loop_id: loopId,
    wave_id: "wave-cli",
    base_sha: baseSha,
    repository_identity_digest: digest("2"),
    source_manifest_digest: digest("3"),
    tree_manifest_digest: digest("4"),
    workspace_manifest_digest: digest("5"),
    artifact_manifest_digest: digest("6"),
    h1_policy_digest: digest("7"),
  };
  const wave: WaveInput = { ...waveContent, digest: sha256Hex(canonicalJsonBytes(waveContent)) };
  await atomicWriteJson(join(layout.harnessRoot, "wave-inputs", "wave-cli.json"), wave);
  const h1 = await sealH1({
    loopId,
    objective: "Edit the target module.",
    acceptance: ["Target compiles."],
    outOfScope: ["Release."],
    readablePaths: ["src/**"],
    writablePaths: ["src/**"],
    waveInputDigest: wave.digest,
    projectPolicyDigest: digest("8"),
    planDigest: digest("9"),
    environmentGates: [{
      gate_id: "static",
      node: "SOURCE_STATIC",
      owner: "LOOP_REQUIRED",
      depends_on: [],
      evidence_ids: ["E-1"],
      requires_new_action: false,
    }],
    actors: [{ actor_role: "worker", model_class: "coding", capabilities: ["source-write", "dispatch"] }],
    capabilities: [
      { capability: "source-write", enforcement: "ORCHESTRATION_ONLY" },
      { capability: "dispatch", enforcement: "RUNTIME_ENFORCED" },
    ],
    budgets: { attempts: 3, reviews: 2, transitions: 20 },
    stopRules: ["Stop on drift."],
    resultSchemas: ["agent-result"],
    planReview: "PASSED",
  }, ledger);
  await atomicWriteJson(join(layout.harnessRoot, `h1-execution-r${String(h1.revision).padStart(3, "0")}.json`), h1);
  await ledger.transition("IMPLEMENTING", "ACTIVE", await ledger.cursor());
  return {
    root,
    loopId,
    h1Digest: h1.digest,
    waveDigest: wave.digest,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("dispatch lifecycle reserves, accepts, integrates, and reconciles through loopctl", async (t) => {
  const prepared = await prepareLoopWorkspace();
  t.after(prepared.cleanup);
  const { root, loopId, h1Digest, waveDigest } = prepared;

  const reservePath = join(root, "reserve.json");
  await writeFile(reservePath, JSON.stringify({
    loop_id: loopId,
    work_item_id: "work-cli",
    actor_role: "worker",
    objective: "Edit the target module.",
    acceptance: ["Target compiles."],
    dependencies: [],
    read_set: ["src/target.ts"],
    write_set: ["src/target.ts"],
    worktree: root,
    wave_input_digest: waveDigest,
    h1_digest: h1Digest,
    completed_work_item_ids: [],
    mode: "persistent",
  }), "utf8");

  const reserved = await runDist(["dispatch-reserve", "--workspace", root, "--request", reservePath]);
  assert.equal(reserved.exitCode, 0, reserved.stderr);
  const request = JSON.parse(reserved.stdout) as {
    request_id: string;
    attempt: number;
    fencing_token: number;
  };
  assert.equal(request.attempt, 1);
  assert.ok(request.fencing_token >= 1);

  await writeFile(join(root, "src", "target.ts"), "export const target = 2;\n", "utf8");
  const acceptPath = join(root, "accept.json");
  const acceptBody = {
    schema_version: 1,
    request_id: request.request_id,
    loop_id: loopId,
    work_item_id: "work-cli",
    attempt: request.attempt,
    actor_role: "worker",
    wave_input_digest: waveDigest,
    h1_digest: h1Digest,
    fencing_token: request.fencing_token,
    status: "COMPLETED",
    output_tree_digest: "a".repeat(64),
    actual_read_set: ["src/target.ts"],
    actual_write_set: ["src/target.ts"],
    evidence_ids: [],
    artifact_manifest_digest: "b".repeat(64),
    summary: "Updated the target module.",
  };
  await writeFile(acceptPath, JSON.stringify({
    ...acceptBody,
    digest: sha256Hex(canonicalJsonBytes(acceptBody)),
    observed_write_set: ["src/target.ts"],
  }), "utf8");

  const accepted = await runDist(["dispatch-accept", "--workspace", root, "--request", acceptPath]);
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  const bundle = JSON.parse(accepted.stdout) as { bundle: { digest: string } };
  assert.match(bundle.bundle.digest, /^[0-9a-f]{64}$/u);

  const integratePath = join(root, "integrate.json");
  await writeFile(integratePath, JSON.stringify({
    loop_id: loopId,
    bundle_digest: bundle.bundle.digest,
  }), "utf8");
  const integrated = await runDist(["integrate", "--workspace", root, "--request", integratePath]);
  assert.equal(integrated.exitCode, 0, integrated.stderr);
  assert.equal(JSON.parse(integrated.stdout).admitted, true);

  const reconciled = await runDist(["dispatch-reconcile", "--workspace", root, "--loop-id", loopId]);
  assert.equal(reconciled.exitCode, 0, reconciled.stderr);
  const recovery = JSON.parse(reconciled.stdout) as { integratedBundleDigests: readonly string[] };
  assert.ok(recovery.integratedBundleDigests.includes(bundle.bundle.digest));
});
