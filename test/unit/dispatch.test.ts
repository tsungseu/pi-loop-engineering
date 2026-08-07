import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { AgentRequest, AgentResult, WaveInput } from "../../src/contracts/dispatch.js";
import { LoopError, sha256Hex, type Digest, type LoopId } from "../../src/contracts/domain.js";
import type { H1Harness } from "../../src/contracts/harness.js";
import { atomicWriteJson, canonicalJsonBytes } from "../../src/core/atomic-json.js";
import {
  acceptAgentResult,
  admitIntegration,
  canShareWave,
  reconcileDispatch,
  reserveDispatch,
  type DispatchReservation,
} from "../../src/core/dispatch.js";
import { sealH1, type H1Input } from "../../src/core/harness.js";
import { openLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout } from "../../src/core/paths.js";

const execFileAsync = promisify(execFile);
const digest = (character: string): Digest => character.repeat(64) as Digest;

function gitEnv(): NodeJS.ProcessEnv {
  const separator = process.platform === "win32" ? ";" : ":";
  const extra = [dirname(process.execPath)];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    extra.push(join(systemRoot, "System32"), systemRoot);
    for (const gitDirectory of [
      process.env.LOCALAPPDATA === undefined ? "" : join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd"),
      process.env.ProgramFiles === undefined ? "" : join(process.env.ProgramFiles, "Git", "cmd"),
    ]) {
      if (gitDirectory !== "") extra.push(gitDirectory);
    }
  }
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(separator), GIT_OPTIONAL_LOCKS: "0" };
}

test("parallel admission applies the symmetric read-write rule", () => {
  assert.equal(canShareWave({ reads: ["a"], writes: ["b"] }, { reads: ["c"], writes: ["d"] }), true);
  assert.equal(canShareWave({ reads: ["a"], writes: ["b"] }, { reads: ["b"], writes: ["d"] }), false);
  assert.equal(canShareWave({ reads: "UNKNOWN", writes: ["b"] }, { reads: ["c"], writes: ["d"] }), false);
});

async function seedWorkspace(t: TestContext): Promise<{ root: string; loopId: LoopId; h1: H1Harness; wave: WaveInput }> {
  const root = await mkdtemp(join(tmpdir(), "pai-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", root], { env: gitEnv() });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");
  await writeFile(join(root, "src", "c.ts"), "export const c = 1;\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "."], { env: gitEnv() });
  await execFileAsync("git", [
    "-C", root, "-c", "user.name=PAI Tests", "-c", "user.email=pai@example.invalid",
    "commit", "-m", "seed",
  ], { env: gitEnv() });
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { env: gitEnv() });
  const baseSha = stdout.trim();
  const loopId = parseLoopId("loop-dispatch-001");
  const layout = resolveLayout(root, loopId);
  const ledger = await openLedger(layout);
  for (const phase of ["ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING"] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  const waveContent = {
    schema_version: 1 as const,
    loop_id: loopId,
    wave_id: "wave-001",
    base_sha: baseSha,
    repository_identity_digest: digest("2"),
    source_manifest_digest: digest("3"),
    tree_manifest_digest: digest("4"),
    workspace_manifest_digest: digest("5"),
    artifact_manifest_digest: digest("6"),
    h1_policy_digest: digest("7"),
  };
  const wave: WaveInput = {
    ...waveContent,
    digest: sha256Hex(canonicalJsonBytes(waveContent)),
  };
  await atomicWriteJson(join(layout.harnessRoot, "wave-inputs", "wave-001.json"), wave);
  const h1Input: H1Input = {
    loopId,
    objective: "Implement bounded parallel work.",
    acceptance: ["Checks pass."],
    outOfScope: ["Release."],
    readablePaths: ["src/**"],
    writablePaths: ["src/**"],
    waveInputDigest: wave.digest,
    projectPolicyDigest: digest("8"),
    planDigest: digest("9"),
    environmentGates: [
      {
        gate_id: "static",
        node: "SOURCE_STATIC",
        owner: "LOOP_REQUIRED",
        depends_on: [],
        evidence_ids: ["E-1"],
        requires_new_action: false,
      },
    ],
    actors: [
      {
        actor_role: "worker",
        model_class: "coding",
        capabilities: ["source-write", "dispatch", "evidence-execution"],
      },
      {
        actor_role: "reviewer",
        model_class: "review",
        capabilities: ["dispatch"],
      },
      {
        actor_role: "delegator",
        model_class: "coding",
        capabilities: ["dispatch", "recursive-dispatch"],
      },
    ],
    capabilities: [
      { capability: "source-write", enforcement: "ORCHESTRATION_ONLY" },
      { capability: "dispatch", enforcement: "RUNTIME_ENFORCED" },
      { capability: "evidence-execution", enforcement: "RUNTIME_ENFORCED" },
      { capability: "external-write", enforcement: "HOST_ENFORCED" },
    ],
    budgets: { attempts: 2, reviews: 2, transitions: 20 },
    stopRules: ["Stop on drift."],
    resultSchemas: ["agent-result"],
    planReview: "PASSED",
  };
  const h1 = await sealH1(h1Input, ledger);
  await ledger.transition("IMPLEMENTING", "ACTIVE", await ledger.cursor());
  await atomicWriteJson(join(layout.harnessRoot, `h1-execution-r${String(h1.revision).padStart(3, "0")}.json`), h1);
  return { root, loopId, h1, wave };
}

function reservation(
  root: string,
  loopId: LoopId,
  h1: H1Harness,
  wave: WaveInput,
  overrides: Partial<DispatchReservation> = {},
): DispatchReservation {
  return {
    workspace: root,
    loopId,
    workItemId: "work-a",
    actorRole: "worker",
    objective: "Edit module A.",
    acceptance: ["Module A compiles."],
    dependencies: [],
    readSet: ["src/a.ts"],
    writeSet: ["src/a.ts"],
    worktree: root,
    waveInputDigest: wave.digest,
    h1Digest: h1.digest,
    completedWorkItemIds: [],
    mode: "persistent",
    ...overrides,
  };
}

function resultFor(request: AgentRequest, overrides: Partial<AgentResult> = {}): AgentResult {
  const content = {
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
    actual_read_set: Array.isArray(request.read_set) ? [...request.read_set] : [],
    actual_write_set: [...request.write_set],
    evidence_ids: [...request.required_evidence_ids],
    artifact_manifest_digest: digest("b"),
    summary: "Completed the bounded work item.",
    ...overrides,
  };
  return { ...content, digest: sha256Hex(canonicalJsonBytes(content)) };
}

test("Dispatch rejects unmet DAG dependencies", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  await assert.rejects(
    reserveDispatch(reservation(root, loopId, h1, wave, {
      workItemId: "work-b",
      dependencies: ["work-a"],
      writeSet: ["src/b.ts"],
      readSet: ["src/b.ts"],
    })),
    (error: unknown) => error instanceof LoopError && error.code === "DISPATCH_REJECTED",
  );
});

test("Dispatch rejects UNKNOWN read sets against parallel work", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-a",
    writeSet: ["src/a.ts"],
    readSet: ["src/a.ts"],
  }));
  await assert.rejects(
    reserveDispatch(reservation(root, loopId, h1, wave, {
      workItemId: "work-b",
      writeSet: ["src/b.ts"],
      readSet: "UNKNOWN",
    })),
    /DISPATCH_REJECTED/,
  );
});

test("Dispatch rejects overlapping write sets in one wave", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-a",
    writeSet: ["src/shared.ts"],
    readSet: ["src/a.ts"],
  }));
  await assert.rejects(
    reserveDispatch(reservation(root, loopId, h1, wave, {
      workItemId: "work-b",
      writeSet: ["src/shared.ts"],
      readSet: ["src/b.ts"],
    })),
    /DISPATCH_REJECTED/,
  );
});

test("Dispatch rejects undeclared Worktree writes even when the caller omits them", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const request = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-undeclared",
    writeSet: ["src/a.ts"],
    readSet: ["src/a.ts"],
  }));
  await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
  await writeFile(join(root, "src", "b.ts"), "export const b = 9;\n", "utf8");
  await assert.rejects(
    acceptAgentResult({
      workspace: root,
      result: resultFor(request, { actual_write_set: ["src/a.ts"] }),
      observedWriteSet: ["src/a.ts"],
    }),
    /DISPATCH_REJECTED|undeclared|independently observed/i,
  );
});

test("Dispatch admits disjoint writers and seals an immutable Agent bundle", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const first = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-a",
    writeSet: ["src/a.ts"],
    readSet: ["src/a.ts"],
  }));
  const second = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-b",
    writeSet: ["src/b.ts"],
    readSet: ["src/b.ts"],
  }));
  assert.notEqual(first.request_id, second.request_id);
  assert.ok(first.fencing_token >= 1);
  await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
  const accepted = await acceptAgentResult({
    workspace: root,
    result: resultFor(first),
    observedWriteSet: ["src/a.ts"],
  });
  assert.match(accepted.bundle.digest, /^[0-9a-f]{64}$/u);
  const sealedPath = join(
    resolveLayout(root, loopId).harnessRoot,
    "attempts",
    first.work_item_id,
    String(first.attempt),
    "bundle.json",
  );
  const sealed = JSON.parse(await readFile(sealedPath, "utf8"));
  assert.equal(sealed.digest, accepted.bundle.digest);
  await writeFile(join(root, "src", "a.ts"), "export const a = 3;\n", "utf8");
  const again = JSON.parse(await readFile(sealedPath, "utf8"));
  assert.equal(again.digest, accepted.bundle.digest);
});

test("Dispatch rejects actor denial, recursive delegation, and exhausted budgets", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  await assert.rejects(
    reserveDispatch(reservation(root, loopId, h1, wave, { actorRole: "stranger" })),
    /DISPATCH_REJECTED|AUTHORIZATION_REQUIRED/,
  );
  await assert.rejects(
    reserveDispatch(reservation(root, loopId, h1, wave, { actorRole: "delegator" })),
    /DISPATCH_REJECTED/,
  );

  for (const attempt of [1, 2] as const) {
    const request = await reserveDispatch(reservation(root, loopId, h1, wave, {
      workItemId: "work-budget",
      writeSet: [`src/budget-${attempt}.ts`],
      readSet: [`src/budget-${attempt}.ts`],
    }));
    assert.equal(request.attempt, attempt);
    const failed = resultFor(request, { status: "FAILED", summary: "Attempt failed.", actual_write_set: [] });
    await acceptAgentResult({
      workspace: root,
      result: failed,
      observedWriteSet: [],
    });
  }
  await assert.rejects(
    reserveDispatch(reservation(root, loopId, h1, wave, {
      workItemId: "work-budget",
      writeSet: ["src/budget-3.ts"],
      readSet: ["src/budget-3.ts"],
    })),
    /DISPATCH_REJECTED/,
  );
});

test("session-only mode admits parallel readers and rejects every parallel writer", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  await reserveDispatch(reservation(root, loopId, h1, wave, {
    mode: "session-only",
    workItemId: "read-a",
    actorRole: "reviewer",
    writeSet: [],
    readSet: ["src/a.ts"],
  }));
  await reserveDispatch(reservation(root, loopId, h1, wave, {
    mode: "session-only",
    workItemId: "read-b",
    actorRole: "reviewer",
    writeSet: [],
    readSet: ["src/b.ts"],
  }));
  await assert.rejects(
    reserveDispatch(reservation(root, loopId, h1, wave, {
      mode: "session-only",
      workItemId: "write-a",
      writeSet: ["src/a.ts"],
      readSet: ["src/a.ts"],
    })),
    /DISPATCH_REJECTED/,
  );
});

test("external writes require HOST_ENFORCED containment and an external-root lease", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const external = await mkdtemp(join(tmpdir(), "pai-dispatch-ext-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await assert.rejects(
    reserveDispatch(reservation(root, loopId, h1, wave, {
      workItemId: "ext-a",
      writeSet: ["src/a.ts"],
      externalWriteRoots: [external],
    })),
    /DISPATCH_REJECTED/,
  );
  const admitted = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "ext-b",
    writeSet: ["src/a.ts"],
    externalWriteRoots: [external],
    hostEnforcedExternalWrite: true,
  }));
  assert.equal(admitted.work_item_id, "ext-b");
});

test("Dispatch rejects undeclared writes under a permitted external root", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const external = await mkdtemp(join(tmpdir(), "pai-dispatch-ext-write-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const request = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "ext-undeclared",
    writeSet: ["src/a.ts"],
    readSet: ["src/a.ts"],
    externalWriteRoots: [external],
    hostEnforcedExternalWrite: true,
  }));
  await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
  await writeFile(join(external, "sneaky.txt"), "undeclared external write\n", "utf8");
  await assert.rejects(
    acceptAgentResult({
      workspace: root,
      result: resultFor(request, { actual_write_set: ["src/a.ts"] }),
      observedWriteSet: ["src/a.ts"],
    }),
    /DISPATCH_REJECTED|undeclared|independently observed/i,
  );
});

test("Dispatch external-root baselines survive a symlink path alias", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const external = await mkdtemp(join(tmpdir(), "pai-dispatch-ext-real-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, "seed.txt"), "baseline\n", "utf8");
  const aliasParent = await mkdtemp(join(tmpdir(), "pai-dispatch-ext-alias-"));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const alias = join(aliasParent, "link");
  try {
    const { symlink } = await import("node:fs/promises");
    await symlink(external, alias, process.platform === "win32" ? "junction" : undefined);
  } catch {
    t.skip("Creating a directory symlink/junction requires unavailable platform privileges.");
    return;
  }
  const request = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "ext-symlink",
    writeSet: ["src/a.ts"],
    readSet: ["src/a.ts"],
    externalWriteRoots: [alias],
    hostEnforcedExternalWrite: true,
  }));
  await writeFile(join(root, "src", "a.ts"), "export const a = 3;\n", "utf8");
  // Unchanged seed.txt under the real path must not look like a new write via the alias.
  const accepted = await acceptAgentResult({
    workspace: root,
    result: resultFor(request, { actual_write_set: ["src/a.ts"] }),
  });
  assert.equal(accepted.result.actual_write_set.length, 1);
  assert.equal(accepted.result.actual_write_set[0], "src/a.ts");
});

test("Integration rejects WaveInput drift outside broker-tracked writes as stale", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const request = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-wave-drift",
    writeSet: ["src/a.ts"],
    readSet: ["src/a.ts"],
  }));
  await writeFile(join(root, "src", "a.ts"), "export const a = 7;\n", "utf8");
  const accepted = await acceptAgentResult({
    workspace: root,
    result: resultFor(request, { actual_write_set: ["src/a.ts"] }),
  });
  // Mutate a path outside the sealed write set / integrated writes so WaveInput freshness fails.
  await writeFile(join(root, "src", "c.ts"), "export const c = 99;\n", "utf8");
  const decision = await admitIntegration({
    workspace: root,
    loopId,
    bundleDigest: accepted.bundle.digest,
  });
  assert.equal(decision.admitted, false);
  if (!decision.admitted) assert.equal(decision.code, "STALE_AGENT_RESULT");
  assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 7;\n");
});

test("Integration applies the sealed bundle exactly once into the live tree", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const request = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-apply",
    writeSet: ["src/a.ts"],
    readSet: ["src/a.ts"],
  }));
  await writeFile(join(root, "src", "a.ts"), "export const a = 42;\n", "utf8");
  const accepted = await acceptAgentResult({
    workspace: root,
    result: resultFor(request, { actual_write_set: ["src/a.ts"] }),
  });
  await writeFile(join(root, "src", "a.ts"), "export const a = 0;\n", "utf8");
  const first = await admitIntegration({
    workspace: root,
    loopId,
    bundleDigest: accepted.bundle.digest,
  });
  assert.equal(first.admitted, true);
  assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 42;\n");
  const second = await admitIntegration({
    workspace: root,
    loopId,
    bundleDigest: accepted.bundle.digest,
  });
  assert.equal(second.admitted, false);
  if (!second.admitted) assert.equal(second.code, "DISPATCH_REJECTED");
  assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 42;\n");
});

test("stale Agent results are ineligible after a conflicting integration", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const first = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-a",
    writeSet: ["src/shared.ts"],
    readSet: ["src/a.ts"],
  }));
  await writeFile(join(root, "src", "shared.ts"), "export const shared = 1;\n", "utf8");
  const acceptedA = await acceptAgentResult({
    workspace: root,
    result: resultFor(first, { actual_write_set: ["src/shared.ts"], actual_read_set: ["src/a.ts"] }),
    observedWriteSet: ["src/shared.ts"],
  });
  const second = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-b",
    writeSet: ["src/b.ts"],
    readSet: ["src/shared.ts"],
  }));
  await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");
  const acceptedB = await acceptAgentResult({
    workspace: root,
    result: resultFor(second, { actual_write_set: ["src/b.ts"], actual_read_set: ["src/shared.ts"] }),
    observedWriteSet: ["src/b.ts"],
  });
  const integrated = await admitIntegration({
    workspace: root,
    loopId,
    bundleDigest: acceptedA.bundle.digest,
  });
  assert.equal(integrated.admitted, true);
  const stale = await admitIntegration({
    workspace: root,
    loopId,
    bundleDigest: acceptedB.bundle.digest,
  });
  assert.equal(stale.admitted, false);
  if (!stale.admitted) assert.equal(stale.code, "STALE_AGENT_RESULT");
});

test("Dispatch recovery completes Intent/Commit boundaries without duplicate dispatch", async (t) => {
  const { root, loopId, h1, wave } = await seedWorkspace(t);
  const request = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-recover",
    writeSet: ["src/c.ts"],
  }));
  const recovery = await reconcileDispatch(root, loopId);
  assert.ok(recovery.openRequestIds.includes(request.request_id));
  const again = await reserveDispatch(reservation(root, loopId, h1, wave, {
    workItemId: "work-recover",
    writeSet: ["src/c.ts"],
  }));
  assert.equal(again.attempt, request.attempt + 1);
  assert.notEqual(again.request_id, request.request_id);
});
