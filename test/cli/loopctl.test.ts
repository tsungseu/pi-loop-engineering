import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

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
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(separator) };
}

function runDist(bin: string, args: readonly string[]): Promise<DistResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "dist", "cli", `${bin}.js`), ...args], {
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
  const root = await mkdtemp(join(tmpdir(), "pai-loopctl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function loopRoot(root: string, loopId: string): string {
  return join(root, ".ai-loop", "loop", loopId);
}

test("loopctl start bootstraps H0 without Init and writes complete Loop paths", async (t) => {
  const root = await workspace(t);
  const result = await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate controller"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.phase, "ORIENTING");
  assert.equal(report.status, "ACTIVE");
  assert.equal(report.markdown_language, "en-US");
  assert.equal(existsSync(join(loopRoot(root, report.loop_id), "LOOP.json")), true);
  assert.equal(existsSync(join(loopRoot(root, report.loop_id), "LOOP.md")), true);
  assert.equal(existsSync(join(loopRoot(root, report.loop_id), "harness", "h0-discovery.json")), true);
});

test("loopctl start honors the zh-CN markdown language", async (t) => {
  const root = await workspace(t);
  const result = await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate controller", "--markdown-language", "zh-CN"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.markdown_language, "zh-CN");
  const markdown = await readFile(join(loopRoot(root, report.loop_id), "LOOP.md"), "utf8");
  assert.match(markdown, /无。/u);
});

test("loopctl rejects unknown options before writing any state", async (t) => {
  const root = await workspace(t);
  const result = await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate", "--bogus", "value"]);
  assert.equal(result.exitCode, 2);
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.error.code, "USAGE");
  assert.equal(existsSync(join(root, ".ai-loop")), false);
});

test("loopctl transition advances the Loop phase through a legal edge", async (t) => {
  const root = await workspace(t);
  const started = JSON.parse((await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate"])).stdout);
  const result = await runDist("loopctl", ["transition", "--workspace", root, "--loop-id", started.loop_id, "--to", "CONTRACTED"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.phase, "CONTRACTED");
  assert.equal(report.status, "ACTIVE");
});

test("loopctl transition rejects an illegal workflow edge", async (t) => {
  const root = await workspace(t);
  const started = JSON.parse((await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate"])).stdout);
  const result = await runDist("loopctl", ["transition", "--workspace", root, "--loop-id", started.loop_id, "--to", "FINALIZING"]);
  assert.equal(result.exitCode, 9);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_TRANSITION");
});

test("loopctl set-markdown-language switches locale and regenerates LOOP.md", async (t) => {
  const root = await workspace(t);
  const started = JSON.parse((await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate"])).stdout);
  const result = await runDist("loopctl", ["set-markdown-language", "--workspace", root, "--loop-id", started.loop_id, "--language", "zh-CN"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).markdown_language, "zh-CN");
  const markdown = await readFile(join(loopRoot(root, started.loop_id), "LOOP.md"), "utf8");
  assert.match(markdown, /无。/u);
});

test("loopctl resume returns the active snapshot for an exact identifier", async (t) => {
  const root = await workspace(t);
  const started = JSON.parse((await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate"])).stdout);
  const result = await runDist("loopctl", ["resume", "--workspace", root, "--loop-id", started.loop_id]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.loop_id, started.loop_id);
  assert.equal(report.phase, "ORIENTING");
});

test("loopctl resume rejects a cancelled Loop", async (t) => {
  const root = await workspace(t);
  const started = JSON.parse((await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate"])).stdout);
  await runDist("loopctl", ["transition", "--workspace", root, "--loop-id", started.loop_id, "--to", "CANCELLED", "--status", "CANCELLED"]);
  const result = await runDist("loopctl", ["resume", "--workspace", root, "--loop-id", started.loop_id]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_TRANSITION");
});

test("loopctl resume rejects an unknown exact identifier", async (t) => {
  const root = await workspace(t);
  await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate"]);
  const result = await runDist("loopctl", ["resume", "--workspace", root, "--loop-id", "loop-does-not-exist"]);
  assert.equal(result.exitCode, 7);
  assert.equal(JSON.parse(result.stderr).error.code, "RECONCILE_REQUIRED");
});

test("loopctl checkpoint records a committed checkpoint transaction", async (t) => {
  const root = await workspace(t);
  const started = JSON.parse((await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate"])).stdout);
  const before = started.last_event_sequence;
  const result = await runDist("loopctl", ["checkpoint", "--workspace", root, "--loop-id", started.loop_id, "--reason", "Pausing for review."]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).last_event_sequence > before, true);
});
