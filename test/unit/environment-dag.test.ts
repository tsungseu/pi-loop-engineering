import assert from "node:assert/strict";
import test from "node:test";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import type { EvidenceRecord, GateRequirement } from "../../src/contracts/harness.js";
import {
  assertFinalizeGates,
  summarizeEnvironmentGates,
  validateEnvironmentDag,
} from "../../src/core/harness.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

function gate(overrides: Partial<GateRequirement> & Pick<GateRequirement, "gate_id" | "node" | "owner">): GateRequirement {
  return {
    depends_on: [],
    evidence_ids: [],
    requires_new_action: false,
    ...overrides,
  };
}

function evidenceFor(evidenceId: string, result: EvidenceRecord["result"]): EvidenceRecord {
  const common = digest("a");
  return {
    schema_version: 1,
    evidence_id: evidenceId,
    loop_id: "loop-dag-001" as LoopId,
    work_item_id: "work-001",
    attempt: 1,
    actor_role: "worker",
    h1_digest: common,
    wave_input_digest: common,
    output_tree_digest: common,
    argv: ["C:/tools/npm.exe", "test"],
    executable_path: "C:/tools/npm.exe",
    executable_digest: common,
    version_argv: ["C:/tools/npm.exe", "--version"],
    cwd: "C:/workspace",
    timeout_ms: 1000,
    stdout_limit_bytes: 1_048_576,
    stderr_limit_bytes: 1_048_576,
    started_at: "2026-08-06T00:00:00.000Z",
    ended_at: "2026-08-06T00:00:00.000Z",
    exit_code: 0,
    exit_signal: null,
    termination_path: "NATURAL_EXIT",
    environment_digest: common,
    tool_versions: { "C:/tools/npm.exe": "10.0.0" },
    stdout_path: "stdout.bin",
    stdout_digest: common,
    stderr_path: "stderr.bin",
    stderr_digest: common,
    artifact_manifest_digest: common,
    result,
  };
}

test("new physical actions cannot be owned by the Loop", () => {
  assert.throws(
    () => validateEnvironmentDag([gate({ gate_id: "hil", node: "HIL", owner: "LOOP_REQUIRED", requires_new_action: true })]),
    /new physical action/iu,
  );
});

test("existing immutable physical evidence may remain LOOP_REQUIRED", () => {
  assert.doesNotThrow(() => validateEnvironmentDag([
    gate({ gate_id: "hil-existing", node: "HIL", owner: "LOOP_REQUIRED", evidence_ids: ["E-HIL-1"], requires_new_action: false }),
  ]));
});

test("a Loop-owned physical gate without existing evidence is rejected", () => {
  assert.throws(
    () => validateEnvironmentDag([gate({ gate_id: "hil-empty", node: "HIL", owner: "LOOP_REQUIRED", requires_new_action: false })]),
    /existing immutable evidence/iu,
  );
});

test("new physical actions are permitted when owned by Release", () => {
  assert.doesNotThrow(() => validateEnvironmentDag([
    gate({ gate_id: "hil-release", node: "HIL", owner: "RELEASE_REQUIRED", requires_new_action: true }),
  ]));
});

test("the environment DAG rejects missing dependencies", () => {
  assert.throws(
    () => validateEnvironmentDag([gate({ gate_id: "unit", node: "UNIT_COMPONENT", owner: "LOOP_REQUIRED", depends_on: ["static"] })]),
    /missing/iu,
  );
});

test("the environment DAG rejects cycles", () => {
  assert.throws(
    () => validateEnvironmentDag([
      gate({ gate_id: "a", node: "SOURCE_STATIC", owner: "LOOP_REQUIRED", depends_on: ["b"] }),
      gate({ gate_id: "b", node: "UNIT_COMPONENT", owner: "LOOP_REQUIRED", depends_on: ["a"] }),
    ]),
    /cycle/iu,
  );
});

test("NOT_APPLICABLE gates require a documented reason", () => {
  assert.throws(
    () => validateEnvironmentDag([gate({ gate_id: "sim", node: "SIMULATION", owner: "NOT_APPLICABLE" })]),
    /reason/iu,
  );
  assert.doesNotThrow(() => validateEnvironmentDag([
    gate({ gate_id: "sim", node: "SIMULATION", owner: "NOT_APPLICABLE", not_applicable_reason: "No simulation surface exists." }),
  ]));
});

test("duplicate gate identifiers are rejected", () => {
  assert.throws(
    () => validateEnvironmentDag([
      gate({ gate_id: "dup", node: "SOURCE_STATIC", owner: "LOOP_REQUIRED" }),
      gate({ gate_id: "dup", node: "UNIT_COMPONENT", owner: "LOOP_REQUIRED" }),
    ]),
    /unique/iu,
  );
});

test("assertFinalizeGates requires current passing evidence for LOOP_REQUIRED gates", () => {
  const gates = [
    gate({ gate_id: "static", node: "SOURCE_STATIC", owner: "LOOP_REQUIRED", evidence_ids: ["E-STATIC-1"] }),
    gate({ gate_id: "release", node: "SIL", owner: "RELEASE_REQUIRED", requires_new_action: true }),
  ];
  assert.throws(() => assertFinalizeGates(gates, []), /Finalize/iu);
  assert.throws(() => assertFinalizeGates(gates, [evidenceFor("E-STATIC-1", "FAIL")]), /Finalize/iu);
  assert.doesNotThrow(() => assertFinalizeGates(gates, [evidenceFor("E-STATIC-1", "PASS")]));
});

test("summarizeEnvironmentGates buckets gates by ownership", () => {
  const gates = [
    gate({ gate_id: "static", node: "SOURCE_STATIC", owner: "LOOP_REQUIRED", evidence_ids: ["E-STATIC-1"] }),
    gate({ gate_id: "release", node: "SIL", owner: "RELEASE_REQUIRED", requires_new_action: true }),
    gate({ gate_id: "sim", node: "SIMULATION", owner: "NOT_APPLICABLE", not_applicable_reason: "No simulation surface exists." }),
  ];
  const summary = summarizeEnvironmentGates(gates, [evidenceFor("E-STATIC-1", "PRE_EXISTING")]);
  assert.deepEqual(summary.loopSatisfied, ["static"]);
  assert.deepEqual(summary.releasePending, ["release"]);
  assert.deepEqual(summary.notApplicable, ["sim"]);
});
