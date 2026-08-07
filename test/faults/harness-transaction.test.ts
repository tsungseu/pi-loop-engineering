import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import { openLedger, type LedgerFaultPoint, type LoopLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../../src/core/paths.js";
import { sealH1, type H1Input } from "../../src/core/harness.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;

function executionInput(loopId: LoopId): H1Input {
  return {
    loopId,
    objective: "Implement the bounded task.",
    acceptance: ["Tests pass."],
    outOfScope: ["Unrelated modules."],
    readablePaths: ["src/**"],
    writablePaths: ["src/output.ts"],
    waveInputDigest: digest("b"),
    projectPolicyDigest: digest("c"),
    planDigest: digest("d"),
    environmentGates: [
      { gate_id: "static", node: "SOURCE_STATIC", owner: "LOOP_REQUIRED", depends_on: [], evidence_ids: ["E-STATIC-1"], requires_new_action: false },
    ],
    actors: [
      { actor_role: "worker", model_class: "premium", capabilities: ["source-write"] },
    ],
    capabilities: [
      { capability: "source-write", enforcement: "ORCHESTRATION_ONLY" },
    ],
    budgets: { attempts: 3, reviews: 2, transitions: 10 },
    stopRules: ["Stop on drift."],
    resultSchemas: ["agent-result"],
    planReview: "PASSED",
  };
}

async function harnessingLedger(
  t: TestContext,
  point: LedgerFaultPoint,
): Promise<{ ledger: LoopLedger; layout: LoopLayout }> {
  const root = await mkdtemp(join(tmpdir(), `pai-harness-${point}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId(`loop-${point}`));
  const setup = await openLedger(layout);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await setup.transition(phase, "ACTIVE", await setup.cursor());
  }
  const ledger = await openLedger(layout, {
    fault: (current) => {
      if (current === point) throw new Error(`injected ${point}`);
    },
  });
  return { ledger, layout };
}

const boundaries: readonly {
  point: LedgerFaultPoint;
  committed: boolean;
  quarantined: number;
}[] = [
  { point: "after-intent", committed: false, quarantined: 0 },
  { point: "after-artifact-temp-write", committed: false, quarantined: 1 },
  { point: "after-artifact-sync", committed: false, quarantined: 1 },
  { point: "after-artifact-rename", committed: false, quarantined: 1 },
  { point: "after-commit", committed: true, quarantined: 0 },
  { point: "before-snapshot-replace", committed: true, quarantined: 0 },
  { point: "after-snapshot-replace", committed: true, quarantined: 0 },
];

for (const boundary of boundaries) {
  test(`Harness transaction recovery at ${boundary.point} follows committed events as truth`, async (t) => {
    const { ledger, layout } = await harnessingLedger(t, boundary.point);
    await assert.rejects(
      sealH1(executionInput(layout.loopId), ledger),
      new RegExp(boundary.point),
    );

    const report = await ledger.recover();
    const snapshot = await ledger.snapshot();
    assert.equal(report.quarantinedArtifacts.length, boundary.quarantined);
    assert.equal(snapshot.phase, "HARNESSING");
    if (boundary.committed) {
      assert.equal(snapshot.current_harness_revision, 1);
      assert.match(String(snapshot.current_harness_digest), /^[0-9a-f]{64}$/u);
    } else {
      assert.equal(snapshot.current_harness_revision, null);
      assert.equal(snapshot.current_harness_digest, null);
    }

    const second = await ledger.recover();
    assert.equal(second.quarantinedArtifacts.length, 0);
    assert.deepEqual(await ledger.snapshot(), snapshot);
  });
}
