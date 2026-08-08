import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const separator = process.platform === "win32" ? ";" : ":";
  const pathExtra = [dirname(process.execPath)];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    pathExtra.push(join(systemRoot, "System32"), systemRoot);
  }
  return {
    ...process.env,
    PATH: [...pathExtra, process.env.PATH ?? ""].join(separator),
    ...extra,
  };
}

function runDist(bin: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<DistResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "dist", "cli", `${bin}.js`), ...args], {
      cwd: repositoryRoot,
      env: env ?? childEnvironment(),
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
  const root = await mkdtemp(join(tmpdir(), "pai-codegraphctl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeHealthyIndex(root: string): Promise<void> {
  const indexRoot = join(root, ".codegraph");
  await mkdir(indexRoot, { recursive: true });
  await writeFile(join(indexRoot, "status.json"), `${JSON.stringify({
    initialized: true,
    healthy: true,
    projectPath: root,
    pendingChanges: { added: 0, modified: 0, removed: 0 },
    worktreeMismatch: null,
    index: { reindexRecommended: false },
  })}\n`, "utf8");
}

async function installFakeCodegraph(
  t: { after(fn: () => unknown): void },
  options: { exploreOk?: boolean; syncOk?: boolean; statusHealthy?: boolean } = {},
): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "pai-fake-codegraph-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const exploreOk = options.exploreOk ?? true;
  const syncOk = options.syncOk ?? true;
  const statusHealthy = options.statusHealthy ?? true;
  const script = `#!/usr/bin/env node
const command = process.argv[2];
if (command === "explore") {
  process.exit(${exploreOk ? 0 : 1});
}
if (command === "sync") {
  process.exit(${syncOk ? 0 : 1});
}
if (command === "status") {
  const payload = {
    initialized: true,
    projectPath: process.cwd(),
    pendingChanges: { added: 0, modified: ${statusHealthy ? 0 : 1}, removed: 0 },
    worktreeMismatch: null,
    index: { reindexRecommended: false },
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
process.stderr.write("unsupported");
process.exit(9);
`;
  const binary = join(bin, process.platform === "win32" ? "codegraph.cmd" : "codegraph");
  if (process.platform === "win32") {
    await writeFile(binary, `@echo off\r\nnode "%~dp0codegraph.js" %*\r\n`, "utf8");
    await writeFile(join(bin, "codegraph.js"), script, "utf8");
  } else {
    await writeFile(binary, script, "utf8");
    await chmod(binary, 0o755);
  }
  return bin;
}

test("missing CodeGraph falls back to native exploration without init", async (t) => {
  const root = await workspace(t);
  const result = await runDist("codegraphctl", ["resolve", "--workspace", root]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "NATIVE_EXPLORE",
    degraded: false,
    initialization_attempted: false,
  });
});

test("codegraphctl prefers MCP when a healthy index exists and MCP is available", async (t) => {
  const root = await workspace(t);
  await writeHealthyIndex(root);
  const bin = await installFakeCodegraph(t);
  const result = await runDist(
    "codegraphctl",
    ["resolve", "--workspace", root, "--mcp-available", "true"],
    childEnvironment({ PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` }),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "MCP",
    degraded: false,
    initialization_attempted: false,
  });
});

test("codegraphctl falls back to CLI explore when MCP is unavailable", async (t) => {
  const root = await workspace(t);
  await writeHealthyIndex(root);
  const bin = await installFakeCodegraph(t, { exploreOk: true });
  const result = await runDist(
    "codegraphctl",
    ["resolve", "--workspace", root, "--mcp-available", "false"],
    childEnvironment({ PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` }),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "CLI",
    degraded: false,
    initialization_attempted: false,
  });
});

test("mandatory repository rules block missing CodeGraph", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "AGENTS.md"), "CodeGraph is mandatory for this repository.\n", "utf8");
  const result = await runDist("codegraphctl", ["resolve", "--workspace", root]);
  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.mode, "BLOCKED");
  assert.equal(body.degraded, false);
  assert.equal(body.initialization_attempted, false);
  assert.match(String(body.reason), /mandatory|required/i);
});

test("sync-existing failure degrades unless CodeGraph is mandatory", async (t) => {
  const root = await workspace(t);
  await writeHealthyIndex(root);
  const bin = await installFakeCodegraph(t, { syncOk: false, exploreOk: true });
  const env = childEnvironment({
    PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  });
  const degraded = await runDist("codegraphctl", ["sync-existing", "--workspace", root], env);
  assert.equal(degraded.exitCode, 0, degraded.stderr);
  const degradedBody = JSON.parse(degraded.stdout);
  assert.equal(degradedBody.mode, "NATIVE_EXPLORE");
  assert.equal(degradedBody.degraded, true);
  assert.equal(degradedBody.initialization_attempted, false);

  await writeFile(join(root, "AGENTS.md"), "This project requires CodeGraph.\n", "utf8");
  const blocked = await runDist("codegraphctl", ["sync-existing", "--workspace", root], env);
  assert.equal(blocked.exitCode, 0, blocked.stderr);
  const blockedBody = JSON.parse(blocked.stdout);
  assert.equal(blockedBody.mode, "BLOCKED");
  assert.equal(blockedBody.initialization_attempted, false);
});

test("codegraphctl exposes only resolve health and sync-existing with STRUCTURAL_HINT evidence", async (t) => {
  const root = await workspace(t);
  await writeHealthyIndex(root);
  const source = await readFile(join(repositoryRoot, "src", "cli", "codegraphctl.ts"), "utf8");
  assert.equal(/\binit\b/u.test(source), false);
  assert.equal(/codegraph\s+init/u.test(source), false);

  const unknown = await runDist("codegraphctl", ["prepare", "--workspace", root]);
  assert.equal(unknown.exitCode, 2);
  assert.equal(JSON.parse(unknown.stderr).error.code, "USAGE");

  const health = await runDist("codegraphctl", ["health", "--workspace", root]);
  assert.equal(health.exitCode, 0, health.stderr);
  const body = JSON.parse(health.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.evidence_class, "STRUCTURAL_HINT");
  assert.equal(body.can_close_findings, false);
  assert.equal(body.proves_behavior, false);
});
