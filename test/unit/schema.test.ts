import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflow from "../../assets/loop-engineering/workflow-spec.json" with { type: "json" };
import { LOOP_PHASES, LOOP_STATUSES } from "../../src/contracts/domain.js";
import { assertWorkflowParity, validateSchema } from "../../src/core/schema.js";

const validLoop = {
  schema_version: 2,
  loop_id: "loop-001",
  parent_loop_id: null,
  phase: "NEW",
  status: "ACTIVE",
  markdown_language: "en-US",
  last_event_sequence: 0,
  last_event_hash: "0".repeat(64),
  current_harness_revision: null,
  current_harness_digest: null,
  handoff_digest: null,
};

test("workflow v2 and TypeScript unions contain the same phases and statuses", () => {
  assert.deepEqual([...workflow.phases].sort(), [...LOOP_PHASES].sort());
  assert.deepEqual([...workflow.statuses].sort(), [...LOOP_STATUSES].sort());
  assert.doesNotThrow(assertWorkflowParity);
});

test("Loop schema rejects unknown properties and old Run vocabulary", () => {
  assert.throws(
    () => validateSchema("loop", { ...validLoop, run_id: "legacy", unexpected: true }),
    /SCHEMA_INVALID/,
  );
});

test("Loop schema accepts the complete v2 machine record", () => {
  assert.equal(validateSchema("loop", validLoop), validLoop);
});

test("built runtime resolves workflow independently of the process working directory", () => {
  const isolatedCwd = mkdtempSync(join(tmpdir(), "pai-schema-runtime-"));
  const runtimeUrl = new URL("../../../dist/core/schema.js", import.meta.url).href;
  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `const module = await import(${JSON.stringify(runtimeUrl)}); module.assertWorkflowParity();`],
      { cwd: isolatedCwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
});

test("Action Envelope schema enforces its discriminated physical contract", () => {
  const digest = "a".repeat(64);
  const authorization = {
    authorization_id: "auth-001",
    action: "run-hil",
    target: "bench-a",
    environment_node: "HIL",
    authorized_by: "release-owner",
    authorized_at: "2026-08-06T00:00:00.000Z",
    expires_at: "2026-08-06T01:00:00.000Z",
    digest,
  };
  const envelope = {
    schema_version: 1,
    operation_id: "operation-001",
    release_id: "release-001",
    handoff_digest: digest,
    target: "bench-a",
    source_head_sha: "b".repeat(40),
    reviewed_tree_digest: digest,
    authorization,
    metadata_digest: digest,
    action: "run-hil",
    release_commit_sha: "c".repeat(40),
    environment_node: "HIL",
  };

  assert.equal(validateSchema("action-envelope", envelope), envelope);
  assert.throws(
    () => validateSchema("action-envelope", { ...envelope, environment_node: "SIL" }),
    /SCHEMA_INVALID/,
  );
});
