import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import { runEvidenceCommand } from "../../src/core/manifests.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("process timeout terminates the detached process group and descendants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, "descendant.pid");
  const descendantProgram = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const parentProgram = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['--eval', ${JSON.stringify(descendantProgram)}], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");

  const record = await runEvidenceCommand({
    loopId: "loop-001" as LoopId,
    workItemId: "timeout-work",
    attempt: 1,
    actorRole: "worker",
    h1Digest: digest("1"),
    waveInputDigest: digest("2"),
    outputTreeDigest: digest("3"),
    executable: process.execPath,
    versionArgs: ["--version"],
    args: ["--eval", parentProgram],
    cwd: root,
    envAllowlist: ["PATH", "SystemRoot"],
    timeoutMs: 2_000,
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
    evidenceDirectory: join(root, "evidence"),
    declaredArtifacts: [],
  });

  const descendantPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
  assert.equal(record.result, "FAIL");
  assert.equal(record.exit_code, null);
  assert.equal(record.exit_signal === null || /^SIG/u.test(record.exit_signal), true);
  assert.equal(isAlive(descendantPid), false, `descendant ${descendantPid} survived timeout cleanup on ${process.platform}`);
  assert.match(record.termination_path, process.platform === "win32" ? /WINDOWS_TASKKILL/u : /POSIX_PROCESS_GROUP/u);
  assert.equal("termination_path" in record.tool_versions, false);
});
