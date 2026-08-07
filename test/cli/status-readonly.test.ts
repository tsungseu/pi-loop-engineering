import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
  const root = await mkdtemp(join(tmpdir(), "pai-status-"));
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

async function startLoop(root: string): Promise<string> {
  const started = JSON.parse((await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate"])).stdout);
  return started.loop_id;
}

test("loopctl status lists candidates without a selected loop", async (t) => {
  const root = await workspace(t);
  const first = await startLoop(root);
  const second = await startLoop(root);
  const result = await runDist("loopctl", ["status", "--workspace", root]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.selected, null);
  assert.deepEqual([...report.candidates].sort(), [first, second].sort());
});

test("loopctl status reports the selected snapshot and next legal actions", async (t) => {
  const root = await workspace(t);
  const loopId = await startLoop(root);
  const result = await runDist("loopctl", ["status", "--workspace", root, "--loop-id", loopId]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.selected.phase, "ORIENTING");
  assert.equal(report.harness.drift.kind, "NONE");
  assert.equal(report.nextActions.some((action: string) => action.includes("CONTRACTED")), true);
});

test("loopctl status does not change any byte or mtime", async (t) => {
  const root = await workspace(t);
  const loopId = await startLoop(root);
  const before = await snapshotDirectory(join(root, ".ai-loop"));
  const result = await runDist("loopctl", ["status", "--workspace", root, "--loop-id", loopId]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(await snapshotDirectory(join(root, ".ai-loop")), before);
});

test("loopctl status localizes stdout for the display language without touching files", async (t) => {
  const root = await workspace(t);
  const loopId = await startLoop(root);
  const before = await snapshotDirectory(join(root, ".ai-loop"));
  const result = await runDist("loopctl", ["status", "--workspace", root, "--loop-id", loopId, "--display-language", "zh-CN"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.nextActions.some((action: string) => action.startsWith("转换到")), true);
  assert.deepEqual(await snapshotDirectory(join(root, ".ai-loop")), before);
});
