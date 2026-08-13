import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { WaveInput } from "../../src/contracts/dispatch.js";
import { sha256Hex, type Digest, type LoopId } from "../../src/contracts/domain.js";
import type { H1Harness } from "../../src/contracts/harness.js";
import { atomicWriteJson, canonicalJsonBytes } from "../../src/core/atomic-json.js";
import {
  acceptAgentResult,
  admitIntegration,
  reconcileDispatch,
  reserveDispatch,
  type DispatchFaultPoint,
} from "../../src/core/dispatch.js";
import { sealH1 } from "../../src/core/harness.js";
import { openLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";

const execFileAsync = promisify(execFile);
const digest = (character: string): Digest => character.repeat(64) as Digest;

async function seeded(t: TestContext): Promise<{ root: string; loopId: LoopId; h1: H1Harness; wave: WaveInput }> {
  const root = await mkdtemp(join(tmpdir(), "pi-dispatch-fault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", root]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "m.ts"), "export const m = 1;\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", [
    "-C", root, "-c", "user.name=PI Tests", "-c", "user.email=pi@example.invalid",
    "commit", "-m", "seed",
  ]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  const loopId = parseLoopId("loop-dispatch-fault");
  const layout = resolveLayout(root, loopId);
  const ledger = await openLedger(layout);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const waveContent = {
    schema_version: 1 as const,
    loop_id: loopId,
    wave_id: "wave-fault",
    base_sha: stdout.trim(),
    repository_identity_digest: digest("2"),
    source_manifest_digest: digest("3"),
    tree_manifest_digest: digest("4"),
    workspace_manifest_digest: digest("5"),
    artifact_manifest_digest: digest("6"),
    h1_policy_digest: digest("7"),
  };
  const wave: WaveInput = { ...waveContent, digest: sha256Hex(canonicalJsonBytes(waveContent)) };
  await atomicWriteJson(join(layout.harnessRoot, "wave-inputs", "wave-fault.json"), wave);
  const h1 = await sealH1({
    loopId,
    objective: "Fault inject dispatch.",
    acceptance: ["Recover cleanly."],
    outOfScope: ["Release."],
    readablePaths: ["src/**"],
    writablePaths: ["src/**"],
    waveInputDigest: wave.digest,
    projectPolicyDigest: digest("8"),
    planDigest: digest("9"),
    environmentGates: [{
      gate_id: "static",
      node: "SOURCE_STATIC",
      owner: "LOOP_REQUIRED",
      depends_on: [],
      evidence_ids: ["E-1"],
      requires_new_action: false,
    }],
    actors: [{ actor_role: "worker", model_class: "coding", capabilities: ["source-write", "dispatch"] }],
    capabilities: [
      { capability: "source-write", enforcement: "ORCHESTRATION_ONLY" },
      { capability: "dispatch", enforcement: "RUNTIME_ENFORCED" },
    ],
    budgets: { attempts: 4, reviews: 2, transitions: 20 },
    stopRules: ["Stop on drift."],
    resultSchemas: ["agent-result"],
    planReview: "PASSED",
  }, ledger);
  await atomicWriteJson(join(layout.harnessRoot, `h1-execution-r${String(h1.revision).padStart(3, "0")}.json`), h1);
  await ledger.transition("IMPLEMENTING", "ACTIVE", await ledger.cursor());
  return { root, loopId, h1, wave };
}

function reservation(root: string, loopId: LoopId, h1: H1Harness, wave: WaveInput, workItemId: string) {
  return {
    workspace: root,
    loopId,
    workItemId,
    actorRole: "worker",
    objective: "Edit module.",
    acceptance: ["Done."],
    dependencies: [] as const,
    readSet: ["src/m.ts"] as const,
    writeSet: ["src/m.ts"] as const,
    worktree: root,
    waveInputDigest: wave.digest,
    h1Digest: h1.digest,
    completedWorkItemIds: [] as const,
    mode: "persistent" as const,
  };
}

async function inject(
  root: string,
  loopId: LoopId,
  h1: H1Harness,
  wave: WaveInput,
  point: DispatchFaultPoint,
  workItemId: string,
): Promise<void> {
  await assert.rejects(
    reserveDispatch({
      ...reservation(root, loopId, h1, wave, workItemId),
      fault: (current: DispatchFaultPoint) => {
        if (current === point) throw new Error(`injected ${point}`);
      },
    }),
    new RegExp(`injected ${point}`),
  );
}

test("dispatch recovery handles reservation Intent/Commit boundaries without duplicate dispatch", async (t) => {
  const { root, loopId, h1, wave } = await seeded(t);
  for (const [index, point] of (["after-reservation-intent", "after-reservation-artifact", "before-reservation-commit"] as const).entries()) {
    await inject(root, loopId, h1, wave, point, `work-${point}`);
    const recovery = await reconcileDispatch(root, loopId);
    assert.ok(recovery.abandonedTransactionIds.length >= 1);
    const request = await reserveDispatch({
      ...reservation(root, loopId, h1, wave, `work-${point}-ok`),
      writeSet: [`src/m-${index}.ts`],
      readSet: [`src/m-${index}.ts`],
    });
    assert.equal(request.attempt, 1);
    await reconcileDispatch(root, loopId);
  }
});

test("dispatch recovery handles result and bundle Intent/Commit boundaries", async (t) => {
  const { root, loopId, h1, wave } = await seeded(t);
  const request = await reserveDispatch(reservation(root, loopId, h1, wave, "work-result"));
  await writeFile(join(root, "src", "m.ts"), "export const m = 2;\n", "utf8");
  const body = {
    schema_version: 1 as const,
    request_id: request.request_id,
    loop_id: request.loop_id,
    work_item_id: request.work_item_id,
    attempt: request.attempt,
    actor_role: request.actor_role,
    wave_input_digest: request.wave_input_digest,
    h1_digest: request.h1_digest,
    fencing_token: request.fencing_token,
    status: "COMPLETED" as const,
    output_tree_digest: digest("a"),
    actual_read_set: ["src/m.ts"],
    actual_write_set: ["src/m.ts"],
    evidence_ids: [],
    artifact_manifest_digest: digest("b"),
    summary: "Updated module.",
  };
  const result = { ...body, digest: sha256Hex(canonicalJsonBytes(body)) };

  await assert.rejects(
    acceptAgentResult({
      workspace: root,
      result,
      observedWriteSet: ["src/m.ts"],
      fault: (point: DispatchFaultPoint) => {
        if (point === "after-result-intent") throw new Error("injected after-result-intent");
      },
    }),
    /injected after-result-intent/,
  );
  let recovery = await reconcileDispatch(root, loopId);
  assert.ok(recovery.abandonedTransactionIds.length >= 1);

  await assert.rejects(
    acceptAgentResult({
      workspace: root,
      result,
      observedWriteSet: ["src/m.ts"],
      fault: (point: DispatchFaultPoint) => {
        if (point === "after-bundle-artifact") throw new Error("injected after-bundle-artifact");
      },
    }),
    /injected after-bundle-artifact/,
  );
  recovery = await reconcileDispatch(root, loopId);
  assert.ok(recovery.abandonedTransactionIds.length >= 1);

  const accepted = await acceptAgentResult({
    workspace: root,
    result,
    observedWriteSet: ["src/m.ts"],
  });
  assert.match(accepted.bundle.digest, /^[0-9a-f]{64}$/u);
});

test("dispatch recovery handles integration Intent/Commit without duplicate apply", async (t) => {
  const { root, loopId, h1, wave } = await seeded(t);
  const request = await reserveDispatch(reservation(root, loopId, h1, wave, "work-integrate"));
  await writeFile(join(root, "src", "m.ts"), "export const m = 3;\n", "utf8");
  const body = {
    schema_version: 1 as const,
    request_id: request.request_id,
    loop_id: request.loop_id,
    work_item_id: request.work_item_id,
    attempt: request.attempt,
    actor_role: request.actor_role,
    wave_input_digest: request.wave_input_digest,
    h1_digest: request.h1_digest,
    fencing_token: request.fencing_token,
    status: "COMPLETED" as const,
    output_tree_digest: digest("a"),
    actual_read_set: ["src/m.ts"],
    actual_write_set: ["src/m.ts"],
    evidence_ids: [],
    artifact_manifest_digest: digest("b"),
    summary: "Updated module.",
  };
  const accepted = await acceptAgentResult({
    workspace: root,
    result: { ...body, digest: sha256Hex(canonicalJsonBytes(body)) },
    observedWriteSet: ["src/m.ts"],
  });

  await assert.rejects(
    admitIntegration({
      workspace: root,
      loopId,
      bundleDigest: accepted.bundle.digest,
      fault: (point: DispatchFaultPoint) => {
        if (point === "after-integration-intent") throw new Error("injected after-integration-intent");
      },
    }),
    /injected after-integration-intent/,
  );
  await reconcileDispatch(root, loopId);

  await assert.rejects(
    admitIntegration({
      workspace: root,
      loopId,
      bundleDigest: accepted.bundle.digest,
      fault: (point: DispatchFaultPoint) => {
        if (point === "after-integration-apply") throw new Error("injected after-integration-apply");
      },
    }),
    /injected after-integration-apply/,
  );
  assert.equal(await readFile(join(root, "src", "m.ts"), "utf8"), "export const m = 3;\n");

  // Crash after apply / before Commit: retry skips re-apply and reaches Commit.
  const first = await admitIntegration({
    workspace: root,
    loopId,
    bundleDigest: accepted.bundle.digest,
  });
  assert.equal(first.admitted, true);
  assert.equal(await readFile(join(root, "src", "m.ts"), "utf8"), "export const m = 3;\n");

  const second = await admitIntegration({
    workspace: root,
    loopId,
    bundleDigest: accepted.bundle.digest,
  });
  assert.equal(second.admitted, false);
  if (!second.admitted) {
    assert.equal(second.code, "DISPATCH_REJECTED");
  }
});
