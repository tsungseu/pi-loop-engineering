import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendJsonLine,
  assertEnglishMachineStrings,
  atomicWriteJson,
  canonicalJsonBytes,
} from "../../src/core/atomic-json.js";

test("canonical JSON recursively sorts keys without changing array order", () => {
  const bytes = canonicalJsonBytes({ z: 1, a: { z: 2, a: 3 }, list: [{ b: 1, a: 2 }, "中"] });
  assert.equal(new TextDecoder().decode(bytes), '{"a":{"a":3,"z":2},"list":[{"a":2,"b":1},"中"],"z":1}\n');
});

test("canonical JSON rejects values that JSON cannot represent losslessly", () => {
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date(), new Map(), { value: undefined }]) {
    assert.throws(() => canonicalJsonBytes(value), /canonical JSON/i);
  }
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJsonBytes(cyclic), /canonical JSON/i);
});

test("machine strings reject plugin narrative but exempt opaque evidence fields", () => {
  for (const summary of ["已完成", "Завершено", "Terminé", "اكتمل"]) {
    assert.throws(
      () => assertEnglishMachineStrings({ actor_role: "worker", summary }),
      /summary/,
    );
  }
  const digest = "a".repeat(64);
  const opaqueEvidence = {
    schema_version: 1,
    evidence_id: "evidence-001",
    loop_id: "loop-001",
    work_item_id: "work-001",
    attempt: 1,
    actor_role: "worker",
    h1_digest: digest,
    wave_input_digest: digest,
    output_tree_digest: digest,
    argv: ["simulator", "--scenario", "测试场景"],
    executable_path: "C:/工具/simulator.exe",
    executable_digest: digest,
    version_argv: ["C:/工具/simulator.exe", "--version"],
    cwd: "C:/项目/工作区",
    timeout_ms: 1000,
    stdout_limit_bytes: 1048576,
    stderr_limit_bytes: 1048576,
    started_at: "2026-08-06T00:00:00.000Z",
    ended_at: "2026-08-06T00:01:00.000Z",
    exit_code: 0,
    exit_signal: null,
    termination_path: "NATURAL_EXIT",
    environment_digest: digest,
    tool_versions: { 仿真器: "版本-1" },
    stdout_path: "evidence/标准输出.bin",
    stdout_digest: digest,
    stderr_path: "evidence/标准错误.bin",
    stderr_digest: digest,
    artifact_manifest_digest: digest,
    result: "PASS",
  };
  assert.doesNotThrow(() => assertEnglishMachineStrings(opaqueEvidence));
  assert.doesNotThrow(() => assertEnglishMachineStrings({
    schema_version: 1,
    kind: "H1",
    loop_id: "loop-001",
    revision: 1,
    objective: "Validate storage.",
    acceptance: ["All checks pass."],
    out_of_scope: ["Release execution."],
    readable_paths: ["C:/项目/输入"],
    writable_paths: ["C:/项目/输出"],
    wave_input_digest: digest,
    project_policy_digest: digest,
    plan_digest: digest,
    environment_gates: [],
    actors: [],
    capabilities: [],
    budgets: { attempts: 1, reviews: 1, transitions: 1 },
    stop_rules: ["Stop on drift."],
    result_schemas: ["agent-result"],
    digest,
  }));
  assert.doesNotThrow(() => assertEnglishMachineStrings({
    schema_version: 1,
    kind: "source",
    entries: [{ path: "模型/控制器.ts", mode: "100644", digest, kind: "file", provenance: "用户仓库" }],
    digest,
  }));
  assert.throws(
    () => assertEnglishMachineStrings({
      schema_version: 1,
      evidence_id: "partial-evidence",
      argv: ["测试场景"],
      tool_versions: {},
    }),
    /argv\[0\]/,
  );
  assert.throws(() => assertEnglishMachineStrings({ path: { summary: "已完成" } }), /path\.summary/);
  assert.throws(() => assertEnglishMachineStrings({ argv: { summary: "已完成" } }), /argv\.summary/);
});

test("canonical JSON rejects stateful array descriptors and extra keys", () => {
  const accessor = [1];
  Object.defineProperty(accessor, "0", { enumerable: true, get: () => 1 });
  const extraProperty = Object.assign([1], { metadata: "stateful" });
  const symbolProperty = [1];
  Object.defineProperty(symbolProperty, Symbol("state"), { value: 2, enumerable: true });
  class StatefulArray extends Array<number> {}

  for (const value of [accessor, extraProperty, symbolProperty, new StatefulArray(1)]) {
    assert.throws(() => canonicalJsonBytes(value), /canonical JSON/i);
  }
});

test("canonical JSON rejects a maximum-length sparse array within bounded memory", () => {
  const runtimeUrl = new URL("../../src/core/atomic-json.js", import.meta.url).href;
  const script = `
    const { canonicalJsonBytes } = await import(${JSON.stringify(runtimeUrl)});
    try {
      canonicalJsonBytes(new Array(2 ** 32 - 1));
      console.error("accepted sparse array");
      process.exitCode = 2;
    } catch (error) {
      if (!/canonical JSON/i.test(String(error))) {
        console.error(error);
        process.exitCode = 3;
      } else {
        console.log("REJECTED");
      }
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=32", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.status, 0, `signal=${result.signal}; error=${result.error?.message}; stderr=${result.stderr}`);
  assert.equal(result.stdout.trim(), "REJECTED");
});

test("atomic JSON replacement is canonical, durable, and leaves no temp file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-atomic-"));
  const target = join(root, "nested", "state.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  const durability = await atomicWriteJson(target, { sequence: 1, actor_role: "controller" });
  assert.equal(durability.fileSync, "SYNCED");
  assert.ok(durability.directorySync === "SYNCED" || durability.directorySync === "UNSUPPORTED");
  assert.equal(await readFile(target, "utf8"), '{"actor_role":"controller","sequence":1}\n');
  assert.deepEqual((await readdir(join(root, "nested"))).sort(), ["state.json"]);
});

test("failed rename preserves the previous JSON value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-atomic-rename-"));
  const target = join(root, "state.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  await atomicWriteJson(target, { sequence: 1 });
  await assert.rejects(
    atomicWriteJson(target, { sequence: 2 }, { beforeRename: () => { throw new Error("injected"); } }),
    /injected/,
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { sequence: 1 });
  assert.deepEqual((await readdir(root)).sort(), ["state.json"]);
});

test("append JSON line writes one compact canonical UTF-8 record and syncs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-jsonl-"));
  const target = join(root, "events.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));

  await appendJsonLine(target, { sequence: 1, type: "LOOP_CREATED" });
  await appendJsonLine(target, { type: "PHASE_CHANGED", sequence: 2 });
  assert.equal(
    await readFile(target, "utf8"),
    '{"sequence":1,"type":"LOOP_CREATED"}\n{"sequence":2,"type":"PHASE_CHANGED"}\n',
  );
  await assert.rejects(appendJsonLine(target, { summary: "已完成" }), /summary/);
});
