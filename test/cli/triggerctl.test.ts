import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
  }
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(separator) };
}

function runTrigger(args: readonly string[], stdinText?: string): Promise<DistResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "dist", "cli", "triggerctl.js"), ...args], {
      cwd: repositoryRoot,
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolvePromise({ exitCode: code, stdout, stderr }));
    if (stdinText !== undefined) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

async function classify(prompt: string): Promise<Record<string, unknown>> {
  const result = await runTrigger(["classify", "--prompt", prompt]);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("triggerctl exact routes map to persistent and readiness decisions", async () => {
  assert.deepEqual(await classify("$loop-engineering implement multi-module robot runtime changes"), {
    match: "exact",
    skill: "loop-engineering",
    decision: "PERSISTENT_LOOP",
    persistence: "persistent",
    authority: "repository-write",
    physical_action: "forbidden",
  });
  assert.equal((await classify("$status")).decision, "READ_ONLY_STATUS");
  assert.equal((await classify("$release loop-abc")).decision, "READINESS_OR_AUTHORIZED_RELEASE");
  assert.equal((await classify("$knowledge-evolution")).decision, "PROPOSAL_ONLY_EVOLUTION");
});

test("triggerctl implicit routes stay session-only or readiness-only", async () => {
  const implementation = await classify(
    "Implement an end-to-end multi-module locomotion sim2real migration with rollback and independent review",
  );
  assert.deepEqual(implementation, {
    match: "implicit",
    skill: "loop-engineering",
    decision: "SESSION_ONLY_LOOP",
    persistence: "session-only",
    authority: "repository-write",
    physical_action: "forbidden",
  });

  const status = await classify("Inspect the active loop status and next gate read-only");
  assert.equal(status.decision, "READ_ONLY_STATUS");
  assert.equal(status.persistence, "session-only");

  const release = await classify("Assess release readiness and the release gate for this robotics change");
  assert.equal(release.decision, "READINESS_ONLY");
  assert.equal(release.skill, "release");
  assert.equal(release.physical_action, "forbidden");

  const knowledge = await classify("Distill lessons learned into an improvement proposal");
  assert.equal(knowledge.decision, "RESPONSE_ONLY");
  assert.equal(knowledge.skill, "knowledge-evolution");

  const review = await classify("Perform an independent adversarial review of the safety plan read-only");
  assert.equal(review.decision, "SESSION_ONLY_READ_ONLY_REVIEW");
  assert.equal(review.skill, "loop-engineering");
  assert.equal(review.authority, "read-only");
});

test("triggerctl physical authorization boundaries never grant hardware authority", async () => {
  const blocked = await classify("git push this robotics fix and deploy to the real robot");
  assert.equal(blocked.decision, "READINESS_ONLY");
  assert.equal(blocked.skill, "release");
  assert.equal(blocked.physical_action, "requires_authorization");
  assert.equal(blocked.authority, "blocked");

  const exactRelease = await classify("$release deploy-robot target=robot-1");
  assert.equal(exactRelease.decision, "READINESS_OR_AUTHORIZED_RELEASE");
  assert.equal(exactRelease.physical_action, "requires_authorization");
});

test("triggerctl rejects unknown legacy exact commands", async () => {
  for (const prompt of ["$init prepare graph", "$run start work", "$review the plan", "$learn distill"]) {
    const result = await runTrigger(["classify", "--prompt", prompt]);
    assert.equal(result.exitCode, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.match, "none");
    assert.equal(body.decision, "UNKNOWN");
    assert.equal(body.skill, null);
  }
});

test("triggerctl classify accepts prompt on stdin without side effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-triggerctl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runTrigger(["classify"], "$status show candidates");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "READ_ONLY_STATUS");
  assert.equal(JSON.parse(result.stdout).match, "exact");
});
