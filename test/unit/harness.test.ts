import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import type { H1Harness } from "../../src/contracts/harness.js";
import { openLedger, type LoopLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";
import {
  classifyHarnessDrift,
  forgeH0,
  sealH1,
  type H0Input,
  type H1Input,
  type HarnessFacts,
} from "../../src/core/harness.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

function discoveryInput(root: string, loopId: LoopId): H0Input {
  return {
    loopId,
    repositoryId: "repository-001",
    repositoryRoot: root,
    readablePaths: ["src/**", "schemas/**"],
    repositoryRulesDigest: digest("a"),
    exploreCapabilities: ["codegraph", "native-search"],
    networkClass: "DISABLED",
    deniedActions: ["push"],
  };
}

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

async function harnessingLedger(t: TestContext, loopId: LoopId): Promise<LoopLedger> {
  const root = await mkdtemp(join(tmpdir(), "pai-harness-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = await openLedger(resolveLayout(root, loopId));
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  return ledger;
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

test("forgeH0 binds an immutable discovery Harness that denies physical and external actions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-h0-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h0 = await forgeH0(discoveryInput(root, parseLoopId("loop-h0-001")));
  assert.equal(h0.kind, "H0");
  assert.equal(h0.revision, 0);
  assert.ok(h0.denied_actions.includes("PHYSICAL_ACTION"));
  assert.ok(h0.denied_actions.includes("EXTERNAL_ACTION"));
  assert.match(h0.digest, /^[0-9a-f]{64}$/u);
});

test("sealH1 cannot seal before a passed Plan Review", async (t) => {
  const loopId = parseLoopId("loop-h1-review");
  const ledger = await harnessingLedger(t, loopId);
  await assert.rejects(
    sealH1({ ...executionInput(loopId), planReview: "REQUIRED_NOT_PASSED" }, ledger),
    (error: unknown) => String(error).includes("HARNESS_REQUIRED"),
  );
});

test("sealH1 seals from HARNESSING and increments immutable revisions", async (t) => {
  const loopId = parseLoopId("loop-h1-seal");
  const ledger = await harnessingLedger(t, loopId);
  const first = await sealH1(executionInput(loopId), ledger);
  assert.equal(first.kind, "H1");
  assert.equal(first.revision, 1);
  const afterFirst = await ledger.snapshot();
  assert.equal(afterFirst.current_harness_revision, 1);
  assert.equal(afterFirst.current_harness_digest, first.digest);

  const second = await sealH1(executionInput(loopId), ledger);
  assert.equal(second.revision, 2);
  assert.notEqual(second.digest, first.digest);
});

test("sealH1 rejects sealing outside the HARNESSING phase", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-h1-phase-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loopId = parseLoopId("loop-h1-phase");
  const ledger = await openLedger(resolveLayout(root, loopId));
  await assert.rejects(
    sealH1(executionInput(loopId), ledger),
    (error: unknown) => String(error).includes("HARNESS_REQUIRED"),
  );
});

test("classifyHarnessDrift distinguishes refresh, plan change, and authority expansion", async (t) => {
  const loopId = parseLoopId("loop-drift");
  const ledger = await harnessingLedger(t, loopId);
  const h1 = await sealH1(executionInput(loopId), ledger);

  assert.deepEqual(classifyHarnessDrift(h1, factsFor(h1)), { kind: "NONE" });
  assert.equal(classifyHarnessDrift(h1, factsFor(h1, { waveInputDigest: digest("f") })).kind, "FACT_REFRESH");
  assert.equal(classifyHarnessDrift(h1, factsFor(h1, { projectPolicyDigest: digest("f") })).kind, "FACT_REFRESH");
  assert.equal(classifyHarnessDrift(h1, factsFor(h1, { planDigest: digest("f") })).kind, "PLAN_CHANGE");

  const expansion = classifyHarnessDrift(h1, factsFor(h1, { requestedWritablePaths: ["docs/output.md"] }));
  assert.equal(expansion.kind, "AUTHORITY_EXPANSION");
  assert.equal(expansion.kind === "AUTHORITY_EXPANSION" ? expansion.childLoopRequired : false, true);

  assert.equal(
    classifyHarnessDrift(h1, factsFor(h1, { requestedWritablePaths: ["src/output.ts"] })).kind,
    "NONE",
  );
});
