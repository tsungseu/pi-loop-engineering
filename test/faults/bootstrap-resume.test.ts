import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openLedger } from "../../src/core/ledger.js";
import { resolveLayout } from "../../src/core/paths.js";
import { bootstrapLoop, resumeLoop } from "../../src/cli/loopctl.js";

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("bootstrap reaches ORIENTING and an exact resume returns the same snapshot", async (t) => {
  const root = await workspace(t);
  const bootstrapped = await bootstrapLoop({ workspace: root, task: "Calibrate controller" });
  assert.equal(bootstrapped.phase, "ORIENTING");
  const resumed = await resumeLoop({ workspace: root, loopId: bootstrapped.loop_id });
  assert.deepEqual(resumed, bootstrapped);
});

test("a bootstrap crash during a later transition is reconciled and resume continues", async (t) => {
  const root = await workspace(t);
  const bootstrapped = await bootstrapLoop({ workspace: root, task: "Calibrate controller" });
  const layout = resolveLayout(root, bootstrapped.loop_id);

  const faulted = await openLedger(layout, {
    fault: (point) => {
      if (point === "after-artifact-temp-write") throw new Error("injected after-artifact-temp-write");
    },
  });
  await assert.rejects(
    faulted.transition("CONTRACTED", "ACTIVE", await faulted.cursor()),
    /after-artifact-temp-write/u,
  );

  const report = await faulted.recover();
  assert.equal(report.quarantinedArtifacts.length, 1);
  const recovered = await faulted.snapshot();
  assert.equal(recovered.phase, "ORIENTING");
  assert.equal(recovered.status, "ACTIVE");
  assert.equal(recovered.current_harness_revision, null);
  assert.equal(recovered.markdown_language, bootstrapped.markdown_language);
  assert.equal(recovered.last_event_sequence >= bootstrapped.last_event_sequence, true);

  const second = await faulted.recover();
  assert.equal(second.quarantinedArtifacts.length, 0);
  assert.deepEqual(await faulted.snapshot(), recovered);

  const resumed = await resumeLoop({ workspace: root, loopId: bootstrapped.loop_id });
  assert.equal(resumed.phase, "ORIENTING");
});

test("resume refuses a Loop whose repository identity moved", async (t) => {
  const source = await workspace(t);
  const bootstrapped = await bootstrapLoop({ workspace: source, task: "Calibrate controller" });
  const relocated = await workspace(t);
  // Copy the loop tree into a different repository root so the derived identity mismatches.
  await cp(join(source, ".ai-loop"), join(relocated, ".ai-loop"), { recursive: true });
  await assert.rejects(
    resumeLoop({ workspace: relocated, loopId: bootstrapped.loop_id }),
    (error: unknown) => error instanceof Error && /repository identity/u.test(error.message),
  );
});

test("resume refuses legacy v1 run directories", async (t) => {
  const root = await workspace(t);
  const bootstrapped = await bootstrapLoop({ workspace: root, task: "Calibrate controller" });
  await mkdir(join(root, ".ai", "runs"), { recursive: true });
  await assert.rejects(
    resumeLoop({ workspace: root, loopId: bootstrapped.loop_id }),
    (error: unknown) => error instanceof Error && /Legacy v1 run directories cannot be resumed/u.test(error.message),
  );
});
