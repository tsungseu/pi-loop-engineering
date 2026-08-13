import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { sha256Hex, type Digest, type LoopId } from "../../src/contracts/domain.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
import {
  runEvidenceCommand,
  verifyEvidenceBinding,
  type EvidenceBinding,
} from "../../src/core/manifests.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

test("evidence preserves non-UTF8 stdout and binds every execution input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-"));
  const evidenceDirectory = join(root, "evidence");
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = {
    loopId: "loop-001" as LoopId,
    workItemId: "work-001",
    attempt: 1,
    actorRole: "worker",
    h1Digest: digest("a"),
    waveInputDigest: digest("b"),
    outputTreeDigest: digest("c"),
  };
  const bytes = [0xff, 0x00, 0x61];
  await writeFile(join(root, "artifact.bin"), Buffer.from([4, 5, 6]));

  const record = await runEvidenceCommand({
    ...identity,
    executable: process.execPath,
    versionArgs: ["--version"],
    args: ["--input-type=module", "--eval", `process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`],
    cwd: root,
    envAllowlist: [],
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    evidenceDirectory,
    declaredArtifacts: [{ kind: "file", path: "artifact.bin", provenance: "test artifact" }],
  });

  const executablePath = await realpath(process.execPath);
  const executableDigest = sha256Hex(await readFile(executablePath));
  const stdoutRelative = relative(root, record.stdout_path).replace(/\\/gu, "/");
  const stderrRelative = relative(root, record.stderr_path).replace(/\\/gu, "/");
  const artifactEntries = [
    { path: "artifact.bin", mode: "100644", digest: sha256Hex(Buffer.from([4, 5, 6])), kind: "file", provenance: "test artifact" },
    { path: stderrRelative, mode: "evidence-stream", digest: sha256Hex(Buffer.alloc(0)), kind: "file", provenance: "verbatim stderr" },
    { path: stdoutRelative, mode: "evidence-stream", digest: sha256Hex(Buffer.from(bytes)), kind: "file", provenance: "verbatim stdout" },
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const artifactContent = { schema_version: 1, kind: "artifact", entries: artifactEntries } as const;
  const artifactManifestDigest = sha256Hex(canonicalJsonBytes(artifactContent));
  const binding: EvidenceBinding = {
    ...identity,
    argv: [executablePath, "--input-type=module", "--eval", `process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`],
    cwd: await realpath(root),
    executablePath,
    executableDigest,
    versionArgv: [executablePath, "--version"],
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    environmentDigest: sha256Hex(canonicalJsonBytes({})),
    toolVersions: { [executablePath]: process.version },
    artifactManifestDigest,
  };
  assert.deepEqual(await readFile(record.stdout_path), Buffer.from(bytes));
  assert.deepEqual(await readFile(record.stderr_path), Buffer.alloc(0));
  assert.deepEqual(record.argv.slice(0, 2), [process.execPath, "--input-type=module"]);
  assert.equal(record.wave_input_digest, identity.waveInputDigest);
  assert.equal(record.executable_path, executablePath);
  assert.equal(record.executable_digest, executableDigest);
  assert.equal(record.artifact_manifest_digest, artifactManifestDigest);
  assert.equal(record.result, "PASS");
  assert.doesNotThrow(() => verifyEvidenceBinding(record, binding));
  const mutations: readonly EvidenceBinding[] = [
    { ...binding, loopId: "loop-002" as LoopId },
    { ...binding, workItemId: "work-002" },
    { ...binding, attempt: 2 },
    { ...binding, actorRole: "reviewer" },
    { ...binding, h1Digest: digest("6") },
    { ...binding, waveInputDigest: digest("5") },
    { ...binding, outputTreeDigest: digest("4") },
    { ...binding, argv: [...binding.argv, "--changed"] },
    { ...binding, cwd: join(binding.cwd, "changed") },
    { ...binding, executablePath: join(binding.cwd, "other-executable") },
    { ...binding, executableDigest: digest("9") },
    { ...binding, versionArgv: [binding.executablePath, "--help"] },
    { ...binding, timeoutMs: 5_001 },
    { ...binding, maxStdoutBytes: 1_025 },
    { ...binding, maxStderrBytes: 1_025 },
    { ...binding, environmentDigest: digest("8") },
    { ...binding, toolVersions: { [executablePath]: "forged" } },
    { ...binding, artifactManifestDigest: digest("7") },
  ];
  for (const mutated of mutations) assert.throws(() => verifyEvidenceBinding(record, mutated), /SCHEMA_INVALID/u);
  assert.equal((await readdir(evidenceDirectory)).some((name) => name.includes(".tmp-")), false);
});

test("evidence environment binding is allowlisted, redacted, and value-sensitive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const variable = "PI_LOOP_TEST_CREDENTIAL";
  const previous = process.env[variable];
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  const base = {
    loopId: "loop-001" as LoopId,
    workItemId: "work-env",
    actorRole: "worker",
    h1Digest: digest("d"),
    waveInputDigest: digest("e"),
    outputTreeDigest: digest("f"),
    executable: process.execPath,
    versionArgs: ["--version"],
    args: ["--eval", ""],
    cwd: root,
    envAllowlist: [variable],
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    declaredArtifacts: [],
  } as const;

  process.env[variable] = "first-secret-value";
  const first = await runEvidenceCommand({ ...base, attempt: 1, evidenceDirectory: join(root, "first") });
  process.env[variable] = "second-secret-value";
  const second = await runEvidenceCommand({ ...base, attempt: 2, evidenceDirectory: join(root, "second") });

  assert.notEqual(first.environment_digest, second.environment_digest);
  assert.doesNotMatch(JSON.stringify(first), /first-secret-value/u);
  assert.doesNotMatch(JSON.stringify(second), /second-secret-value/u);
});

test("evidence records an exit signal in its contract field", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await runEvidenceCommand({
    loopId: "loop-001" as LoopId,
    workItemId: "work-signal",
    attempt: 1,
    actorRole: "worker",
    h1Digest: digest("1"),
    waveInputDigest: digest("2"),
    outputTreeDigest: digest("3"),
    executable: process.execPath,
    versionArgs: ["--version"],
    args: ["--eval", "process.kill(process.pid, 'SIGTERM')"],
    cwd: root,
    envAllowlist: [],
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    evidenceDirectory: join(root, "evidence"),
    declaredArtifacts: [],
  });
  assert.equal(record.result, "FAIL");
  if (process.platform === "win32") assert.equal(record.exit_signal === null || record.exit_signal === "SIGTERM", true);
  else assert.equal(record.exit_signal, "SIGTERM");
  assert.equal("exit_signal" in record.tool_versions, false);
});

test("evidence rejects and terminates stdout beyond its explicit byte limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-overflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(runEvidenceCommand({
    loopId: "loop-001" as LoopId,
    workItemId: "work-overflow",
    attempt: 1,
    actorRole: "worker",
    h1Digest: digest("4"),
    waveInputDigest: digest("5"),
    outputTreeDigest: digest("6"),
    executable: process.execPath,
    versionArgs: ["--version"],
    args: ["--eval", "process.stdout.write(Buffer.alloc(1024 * 1024)); setInterval(() => {}, 1000)"],
    cwd: root,
    envAllowlist: [],
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    evidenceDirectory: join(root, "evidence"),
    declaredArtifacts: [],
  }), /stdout.*limit|limit.*stdout/iu);
});

test("evidence relative directory resolves against the sandboxed cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-rel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await runEvidenceCommand({
    loopId: "loop-001" as LoopId,
    workItemId: "work-rel",
    attempt: 1,
    actorRole: "worker",
    h1Digest: digest("7"),
    waveInputDigest: digest("8"),
    outputTreeDigest: digest("9"),
    executable: process.execPath,
    versionArgs: ["--version"],
    args: ["--eval", ""],
    cwd: root,
    envAllowlist: [],
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    evidenceDirectory: "evidence",
    declaredArtifacts: [],
  });
  assert.equal(relative(root, record.stdout_path).startsWith(".."), false);
  assert.match(record.stdout_path.replace(/\\/gu, "/"), /\/evidence\//u);
});
