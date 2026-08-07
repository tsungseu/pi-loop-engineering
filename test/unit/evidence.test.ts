import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import {
  runEvidenceCommand,
  verifyEvidenceBinding,
  type EvidenceBinding,
} from "../../src/core/manifests.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

test("evidence preserves non-UTF8 stdout and binds every execution input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-evidence-"));
  const evidenceDirectory = join(root, "evidence");
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding: EvidenceBinding = {
    loopId: "loop-001" as LoopId,
    workItemId: "work-001",
    attempt: 1,
    actorRole: "worker",
    h1Digest: digest("a"),
    waveInputDigest: digest("b"),
    outputTreeDigest: digest("c"),
  };
  const bytes = [0xff, 0x00, 0x61];

  const record = await runEvidenceCommand({
    ...binding,
    executable: process.execPath,
    args: ["--input-type=module", "--eval", `process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`],
    cwd: root,
    envAllowlist: ["PATH"],
    timeoutMs: 5_000,
    evidenceDirectory,
  });

  assert.deepEqual(await readFile(record.stdout_path), Buffer.from(bytes));
  assert.deepEqual(await readFile(record.stderr_path), Buffer.alloc(0));
  assert.deepEqual(record.argv.slice(0, 2), [process.execPath, "--input-type=module"]);
  assert.equal(record.wave_input_digest, binding.waveInputDigest);
  assert.equal(record.result, "PASS");
  assert.doesNotThrow(() => verifyEvidenceBinding(record, binding));
  assert.throws(() => verifyEvidenceBinding(record, { ...binding, attempt: 2 }), /SCHEMA_INVALID/u);
  assert.equal((await readdir(evidenceDirectory)).some((name) => name.includes(".tmp-")), false);
});

test("evidence environment binding is allowlisted, redacted, and value-sensitive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-evidence-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const variable = "PAI_LOOP_TEST_CREDENTIAL";
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
    args: ["--eval", ""],
    cwd: root,
    envAllowlist: [variable],
    timeoutMs: 5_000,
  } as const;

  process.env[variable] = "first-secret-value";
  const first = await runEvidenceCommand({ ...base, attempt: 1, evidenceDirectory: join(root, "first") });
  process.env[variable] = "second-secret-value";
  const second = await runEvidenceCommand({ ...base, attempt: 2, evidenceDirectory: join(root, "second") });

  assert.notEqual(first.environment_digest, second.environment_digest);
  assert.doesNotMatch(JSON.stringify(first), /first-secret-value/u);
  assert.doesNotMatch(JSON.stringify(second), /second-secret-value/u);
});
