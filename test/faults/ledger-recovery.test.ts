import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  openLedger,
  type LedgerFaultPoint,
  type LoopLedger,
} from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../../src/core/paths.js";

async function advanceToFinalizing(ledger: LoopLedger): Promise<void> {
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING", "IMPLEMENTING", "VERIFYING", "REVIEWING", "FINALIZING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
}

async function finalizingLedger(
  t: TestContext,
  point: LedgerFaultPoint,
): Promise<{ ledger: LoopLedger; layout: LoopLayout }> {
  const root = await mkdtemp(join(tmpdir(), `pai-ledger-${point}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, parseLoopId(`loop-${point}`));
  const setup = await openLedger(layout);
  await advanceToFinalizing(setup);
  const ledger = await openLedger(layout, {
    fault: (current) => {
      if (current === point) throw new Error(`injected ${point}`);
    },
  });
  return { ledger, layout };
}

test("recovery consumes only artifacts with matching COMMIT events", async (t) => {
  const { ledger } = await finalizingLedger(t, "after-artifact-rename");
  await assert.rejects(
    ledger.transition("HANDOFF_READY", "COMPLETE", await ledger.cursor()),
    /injected after-artifact-rename/,
  );
  const report = await ledger.recover();
  assert.equal(report.quarantinedArtifacts.length, 1);
  assert.equal((await ledger.snapshot()).phase, "FINALIZING");
});

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
  test(`ledger recovery at ${boundary.point} follows committed events as truth`, async (t) => {
    const { ledger } = await finalizingLedger(t, boundary.point);
    await assert.rejects(
      ledger.transition("HANDOFF_READY", "COMPLETE", await ledger.cursor()),
      new RegExp(boundary.point),
    );

    const report = await ledger.recover();
    const snapshot = await ledger.snapshot();
    assert.equal(report.quarantinedArtifacts.length, boundary.quarantined);
    assert.deepEqual(
      [snapshot.phase, snapshot.status],
      boundary.committed ? ["HANDOFF_READY", "COMPLETE"] : ["FINALIZING", "ACTIVE"],
    );

    const second = await ledger.recover();
    assert.equal(second.quarantinedArtifacts.length, 0);
    assert.deepEqual(await ledger.snapshot(), snapshot);
  });
}
