import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Digest, EnforcementClass, LoopId } from "../../src/contracts/domain.js";
import type { EvidenceRecord, H0Harness, H1Harness } from "../../src/contracts/harness.js";
import { openLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";
import {
  evaluateGate,
  forgeH0,
  sealH1,
  type GateDecision,
  type H1Input,
  type HarnessFacts,
} from "../../src/core/harness.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

function executionInput(loopId: LoopId): H1Input {
  return {
    loopId,
    objective: "Implement the bounded task.",
    acceptance: ["Tests pass."],
    outOfScope: ["Unrelated modules."],
    readablePaths: ["src/**"],
    writablePaths: ["src/output.ts", "src/generated/**"],
    waveInputDigest: digest("b"),
    projectPolicyDigest: digest("c"),
    planDigest: digest("d"),
    environmentGates: [
      { gate_id: "static", node: "SOURCE_STATIC", owner: "LOOP_REQUIRED", depends_on: [], evidence_ids: ["E-STATIC-1"], requires_new_action: false },
    ],
    actors: [
      { actor_role: "worker", model_class: "premium", capabilities: ["source-write", "evidence-execution", "dispatch", "transition", "finalize"] },
    ],
    capabilities: [
      { capability: "source-write", enforcement: "ORCHESTRATION_ONLY" },
      { capability: "evidence-execution", enforcement: "RUNTIME_ENFORCED" },
    ],
    budgets: { attempts: 3, reviews: 2, transitions: 10 },
    stopRules: ["Stop on drift."],
    resultSchemas: ["agent-result"],
    planReview: "PASSED",
  };
}

async function sealExecutionHarness(t: TestContext, loopId: LoopId): Promise<H1Harness> {
  const root = await mkdtemp(join(tmpdir(), "pi-gate-h1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = await openLedger(resolveLayout(root, loopId));
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  return sealH1(executionInput(loopId), ledger);
}

async function forgeDiscoveryHarness(t: TestContext, loopId: LoopId): Promise<H0Harness> {
  const root = await mkdtemp(join(tmpdir(), "pi-gate-h0-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return forgeH0({
    loopId,
    repositoryId: "repository-001",
    repositoryRoot: root,
    readablePaths: ["src/**"],
    repositoryRulesDigest: digest("a"),
    exploreCapabilities: ["codegraph"],
    networkClass: "DISABLED",
  });
}

function factsFor(h1: H1Harness, overrides: Partial<HarnessFacts> = {}): HarnessFacts {
  return {
    harnessDigest: h1.digest,
    waveInputDigest: h1.wave_input_digest,
    projectPolicyDigest: h1.project_policy_digest,
    planDigest: h1.plan_digest,
    attemptsUsed: 0,
    reviewsUsed: 0,
    transitionsUsed: 0,
    activeWriteWave: false,
    evidence: [],
    ...overrides,
  };
}

function neutralFacts(): HarnessFacts {
  return {
    harnessDigest: digest("0"),
    waveInputDigest: digest("0"),
    projectPolicyDigest: digest("0"),
    planDigest: digest("0"),
    attemptsUsed: 0,
    reviewsUsed: 0,
    transitionsUsed: 0,
    activeWriteWave: false,
    evidence: [],
  };
}

function evidenceFor(loopId: LoopId, evidenceId: string, result: EvidenceRecord["result"]): EvidenceRecord {
  const common = digest("a");
  return {
    schema_version: 1,
    evidence_id: evidenceId,
    loop_id: loopId,
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

function expectDenied(decision: GateDecision, code: string): void {
  assert.equal(decision.allowed, false);
  if (decision.allowed === false) assert.equal(decision.code, code);
}

function expectAllowed(decision: GateDecision, enforcement?: EnforcementClass): void {
  assert.equal(decision.allowed, true);
  if (decision.allowed === true && enforcement !== undefined) assert.equal(decision.enforcement, enforcement);
}

test("evaluateGate requires a Harness for every governed operation", () => {
  expectDenied(evaluateGate({ harness: null, operation: "SOURCE_WRITE", actorRole: "worker", facts: neutralFacts() }), "HARNESS_REQUIRED");
});

test("the discovery Harness denies source writes and defers physical actions", async (t) => {
  const h0 = await forgeDiscoveryHarness(t, parseLoopId("loop-gate-h0"));
  const facts = neutralFacts();
  expectDenied(evaluateGate({ harness: h0, operation: "SOURCE_WRITE", actorRole: "worker", facts }), "HARNESS_REQUIRED");
  expectDenied(evaluateGate({ harness: h0, operation: "EVIDENCE_EXECUTION", actorRole: "worker", facts }), "HARNESS_REQUIRED");
  expectDenied(evaluateGate({ harness: h0, operation: "PHYSICAL_ACTION", actorRole: "worker", facts }), "AUTHORIZATION_REQUIRED");
  expectDenied(evaluateGate({ harness: h0, operation: "EXTERNAL_ACTION", actorRole: "worker", facts }), "AUTHORIZATION_REQUIRED");
  expectAllowed(evaluateGate({ harness: h0, operation: "TRANSITION", actorRole: "worker", facts }), "ORCHESTRATION_ONLY");
});

test("the execution Harness admits a writable-scope source write", async (t) => {
  const h1 = await sealExecutionHarness(t, parseLoopId("loop-gate-write"));
  const decision = evaluateGate({ harness: h1, operation: "SOURCE_WRITE", actorRole: "worker", path: "src/output.ts", facts: factsFor(h1) });
  expectAllowed(decision, "ORCHESTRATION_ONLY");
});

test("the execution Harness rejects writes outside the writable scope", async (t) => {
  const h1 = await sealExecutionHarness(t, parseLoopId("loop-gate-scope"));
  expectDenied(
    evaluateGate({ harness: h1, operation: "SOURCE_WRITE", actorRole: "worker", path: "docs/output.md", facts: factsFor(h1) }),
    "AUTHORIZATION_REQUIRED",
  );
});

test("the execution Harness rejects an ungranted actor role", async (t) => {
  const h1 = await sealExecutionHarness(t, parseLoopId("loop-gate-actor"));
  expectDenied(
    evaluateGate({ harness: h1, operation: "SOURCE_WRITE", actorRole: "intruder", path: "src/output.ts", facts: factsFor(h1) }),
    "AUTHORIZATION_REQUIRED",
  );
});

test("the execution Harness blocks writes when the attempt budget is exhausted", async (t) => {
  const h1 = await sealExecutionHarness(t, parseLoopId("loop-gate-budget"));
  expectDenied(
    evaluateGate({ harness: h1, operation: "SOURCE_WRITE", actorRole: "worker", path: "src/output.ts", facts: factsFor(h1, { attemptsUsed: 3 }) }),
    "AUTHORIZATION_REQUIRED",
  );
});

test("the execution Harness blocks direct writes while a write Wave is active", async (t) => {
  const h1 = await sealExecutionHarness(t, parseLoopId("loop-gate-wave"));
  expectDenied(
    evaluateGate({ harness: h1, operation: "SOURCE_WRITE", actorRole: "worker", path: "src/output.ts", facts: factsFor(h1, { activeWriteWave: true }) }),
    "AUTHORIZATION_REQUIRED",
  );
});

test("the execution Harness rejects drift between sealed facts and the current world", async (t) => {
  const h1 = await sealExecutionHarness(t, parseLoopId("loop-gate-drift"));
  expectDenied(
    evaluateGate({ harness: h1, operation: "SOURCE_WRITE", actorRole: "worker", path: "src/output.ts", facts: factsFor(h1, { waveInputDigest: digest("f") }) }),
    "HARNESS_DRIFT",
  );
});

test("the execution Harness rejects a tampered digest", async (t) => {
  const h1 = await sealExecutionHarness(t, parseLoopId("loop-gate-tamper"));
  const tampered: H1Harness = { ...h1, objective: "Tampered objective." };
  expectDenied(
    evaluateGate({ harness: tampered, operation: "SOURCE_WRITE", actorRole: "worker", path: "src/output.ts", facts: factsFor(h1) }),
    "HARNESS_DRIFT",
  );
});

test("external and physical actions always require scoped authorization", async (t) => {
  const h1 = await sealExecutionHarness(t, parseLoopId("loop-gate-physical"));
  expectDenied(evaluateGate({ harness: h1, operation: "PHYSICAL_ACTION", actorRole: "worker", facts: factsFor(h1) }), "AUTHORIZATION_REQUIRED");
  expectDenied(evaluateGate({ harness: h1, operation: "EXTERNAL_ACTION", actorRole: "worker", facts: factsFor(h1) }), "AUTHORIZATION_REQUIRED");
});

test("finalize is gated on current LOOP_REQUIRED evidence", async (t) => {
  const loopId = parseLoopId("loop-gate-finalize");
  const h1 = await sealExecutionHarness(t, loopId);
  expectDenied(evaluateGate({ harness: h1, operation: "FINALIZE", actorRole: "worker", facts: factsFor(h1) }), "HARNESS_DRIFT");
  const withEvidence = factsFor(h1, { evidence: [evidenceFor(loopId, "E-STATIC-1", "PASS")] });
  expectAllowed(evaluateGate({ harness: h1, operation: "FINALIZE", actorRole: "worker", facts: withEvidence }));
});
