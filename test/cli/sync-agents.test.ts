import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadProfiles,
  synchronizeAgents,
  validateActorContract,
  parseAgentProfile,
} from "../../src/cli/sync-agents.js";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const agentRoot = join(repositoryRoot, "assets", "agents");

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

function runSync(args: readonly string[]): Promise<DistResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "dist", "cli", "sync-agents.js"), ...args], {
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

describe("sync-agents", { concurrency: 1 }, () => {
test("all Agent names use pi-loop and declare bounded actor capabilities", async () => {
  const profiles = await loadProfiles(agentRoot);
  assert.ok(profiles.every((profile) => profile.name.startsWith("pi-loop-")));
  assert.ok(profiles.every((profile) => profile.capabilities.recursive_dispatch === false));
  assert.ok(
    profiles
      .filter((profile) => profile.role.includes("reviewer"))
      .every((profile) => (
        profile.source_access === "read-only"
        && profile.capabilities.external_write === false
        && profile.capabilities.network === false
        && profile.capabilities.release === false
      )),
  );
  assert.ok(profiles.every((profile) => profile.capabilities.physical_action === false));
  assert.ok(profiles.every((profile) => profile.capabilities.ledger_write === false));
  const releaseEngineers = profiles.filter((profile) => profile.role === "release-engineer");
  assert.equal(releaseEngineers.length, 1);
  assert.equal(releaseEngineers[0]!.capabilities.release, true);
  assert.ok(
    profiles
      .filter((profile) => profile.role !== "release-engineer")
      .every((profile) => profile.capabilities.release === false),
  );
});

test("sync is deterministic and rejects duplicate or unknown actors", async () => {
  const first = await synchronizeAgents({ root: repositoryRoot });
  const second = await synchronizeAgents({ root: repositoryRoot });
  assert.equal(first.outputDigest, second.outputDigest);
  assert.equal(second.changedFiles.length, 0);
  assert.deepEqual(first.profiles, [...first.profiles].sort());

  assert.throws(
    () => validateActorContract(parseAgentProfile(`
name = "pi-loop-unknown-role"
role = "unknown-actor"
description = "bad"
source_access = "read-only"
required_bindings = []
evidence_requirements = []
stop_conditions = []
[capabilities]
external_write = false
network = false
recursive_dispatch = false
ledger_write = false
release = false
physical_action = false
`)),
    /unknown actor/i,
  );

  const duplicateRoot = await mkdtemp(join(tmpdir(), "pi-sync-agents-"));
  try {
    await mkdir(join(duplicateRoot, "assets", "agents"), { recursive: true });
    await mkdir(join(duplicateRoot, "skills", "status", "agents"), { recursive: true });
    for (const skill of ["loop-engineering", "release", "knowledge-evolution"] as const) {
      await mkdir(join(duplicateRoot, "skills", skill, "agents"), { recursive: true });
      await writeFile(
        join(duplicateRoot, "skills", skill, "agents", "openai.yaml"),
        "interface:\n  display_name: \"x\"\n  short_description: \"y\"\n  default_prompt: \"z\"\npolicy:\n  allow_implicit_invocation: true\n",
        "utf8",
      );
    }
    await writeFile(
      join(duplicateRoot, "skills", "status", "agents", "openai.yaml"),
      "interface:\n  display_name: \"x\"\n  short_description: \"y\"\n  default_prompt: \"z\"\npolicy:\n  allow_implicit_invocation: true\n",
      "utf8",
    );
    const base = await readFile(join(agentRoot, "pi-loop-explorer.toml"), "utf8");
    await writeFile(join(duplicateRoot, "assets", "agents", "pi-loop-explorer.toml"), base, "utf8");
    await writeFile(
      join(duplicateRoot, "assets", "agents", "pi-loop-worker.toml"),
      base,
      "utf8",
    );
    await assert.rejects(() => synchronizeAgents({ root: duplicateRoot }), /duplicate/i);
  } finally {
    await rm(duplicateRoot, { recursive: true, force: true });
  }
});

test("validateActorContract rejects write-capable reviewers and physical action", () => {
  const reviewerWriteSet = parseAgentProfile(`
name = "pi-loop-reviewer"
role = "reviewer"
description = "independent reviewer"
source_access = "h1-write-set"
required_bindings = ["h1", "work_item", "worktree", "wave_input", "lease", "attempt", "fencing_token"]
evidence_requirements = ["findings"]
stop_conditions = ["ambiguity"]
[capabilities]
external_write = false
network = false
recursive_dispatch = false
ledger_write = false
release = false
physical_action = false
`);
  assert.throws(() => validateActorContract(reviewerWriteSet), /reviewer/i);

  const reviewerExternalWrite = parseAgentProfile(`
name = "pi-loop-reviewer"
role = "reviewer"
description = "independent reviewer"
source_access = "read-only"
required_bindings = ["h1", "work_item", "attempt"]
evidence_requirements = ["findings"]
stop_conditions = ["ambiguity"]
[capabilities]
external_write = true
network = false
recursive_dispatch = false
ledger_write = false
release = false
physical_action = false
`);
  assert.throws(() => validateActorContract(reviewerExternalWrite), /external_write/i);

  const reviewerNetwork = parseAgentProfile(`
name = "pi-loop-safety-reviewer"
role = "safety-reviewer"
description = "independent safety reviewer"
source_access = "read-only"
required_bindings = ["h1", "work_item", "attempt"]
evidence_requirements = ["findings"]
stop_conditions = ["ambiguity"]
[capabilities]
external_write = false
network = true
recursive_dispatch = false
ledger_write = false
release = false
physical_action = false
`);
  assert.throws(() => validateActorContract(reviewerNetwork), /network/i);

  assert.throws(
    () => parseAgentProfile(`
name = "pi-loop-worker"
role = "worker"
description = "writer"
source_access = "h1-write-set"
required_bindings = ["h1", "work_item", "worktree", "wave_input", "lease", "attempt", "fencing_token"]
evidence_requirements = ["tests"]
stop_conditions = ["ambiguity"]
[capabilities]
external_write = false
network = false
recursive_dispatch = false
ledger_write = false
release = false
physical_action = true
`),
    /physical_action|Capability must be false/i,
  );

  const nonReleaseWithRelease = parseAgentProfile(`
name = "pi-loop-explorer"
role = "explorer"
description = "explorer"
source_access = "read-only"
required_bindings = ["h1", "work_item", "attempt"]
evidence_requirements = ["notes"]
stop_conditions = ["ambiguity"]
[capabilities]
external_write = false
network = false
recursive_dispatch = false
ledger_write = false
release = true
physical_action = false
`);
  assert.throws(() => validateActorContract(nonReleaseWithRelease), /release engineer/i);
});

test("TOML parser preserves hash characters inside quoted strings", () => {
  const profile = parseAgentProfile(`
name = "pi-loop-explorer"
role = "explorer"
description = "label # not-a-comment"
source_access = "read-only"
required_bindings = []
evidence_requirements = ["a # b"]
stop_conditions = []
[capabilities]
external_write = false
network = false
recursive_dispatch = false
ledger_write = false
release = false
physical_action = false
`);
  assert.equal(profile.description, "label # not-a-comment");
  assert.deepEqual(profile.evidence_requirements, ["a # b"]);
});

test("dist sync-agents --check reports no drift on the repository", async () => {
  await synchronizeAgents({ root: repositoryRoot });
  const result = await runSync(["--root", repositoryRoot, "--check"]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout) as { changedFiles: string[] };
  assert.deepEqual(report.changedFiles, []);
});

test("sync only rewrites the four Skill openai.yaml agent lists", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-sync-agents-skills-"));
  try {
    await cp(join(repositoryRoot, "assets", "agents"), join(fixture, "assets", "agents"), { recursive: true });
    for (const skill of ["knowledge-evolution", "loop-engineering", "release", "status"] as const) {
      await mkdir(join(fixture, "skills", skill, "agents"), { recursive: true });
      await writeFile(
        join(fixture, "skills", skill, "agents", "openai.yaml"),
        [
          "# header",
          "interface:",
          '  display_name: "Test"',
          '  short_description: "Test skill metadata"',
          '  default_prompt: "Use $status to inspect."',
          "policy:",
          "  allow_implicit_invocation: true",
          "agents:",
          "  - stale-agent",
          "",
        ].join("\n"),
        "utf8",
      );
    }
    const report = await synchronizeAgents({ root: fixture });
    assert.equal(report.changedFiles.length, 4);
    for (const relative of report.changedFiles) {
      const text = await readFile(join(fixture, relative), "utf8");
      assert.match(text, /^# header\n/u);
      assert.doesNotMatch(text, /stale-agent/u);
      assert.match(text, /agents:\n(?:  - pi-loop-[a-z0-9-]+\n)+$/u);
      assert.ok(!text.includes("\r"));
    }
    const check = await synchronizeAgents({ root: fixture, check: true });
    assert.equal(check.changedFiles.length, 0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
});
