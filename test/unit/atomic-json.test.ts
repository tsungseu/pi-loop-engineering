import assert from "node:assert/strict";
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
  assert.throws(
    () => assertEnglishMachineStrings({ actor_role: "worker", summary: "已完成" }),
    /summary/,
  );
  assert.doesNotThrow(() => assertEnglishMachineStrings({
    actor_role: "worker",
    argv: ["simulator", "--scenario", "测试场景"],
    cwd: "C:/项目/工作区",
    tool_versions: { 仿真器: "版本-1" },
    stdout_path: "evidence/标准输出.bin",
    stderr_path: "evidence/标准错误.bin",
  }));
});

test("atomic JSON replacement is canonical, durable, and leaves no temp file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-atomic-"));
  const target = join(root, "nested", "state.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  const durability = await atomicWriteJson(target, { sequence: 1, actor_role: "controller" });
  assert.equal(durability.fileSync, "SYNCED");
  assert.ok(durability.directorySync === "SYNCED" || durability.directorySync === "UNSUPPORTED");
  assert.equal(await readFile(target, "utf8"), '{"actor_role":"controller","sequence":1}\n');
  assert.deepEqual((await readdir(join(root, "nested"))).sort(), ["state.json"]);
});

test("failed rename preserves the previous JSON value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-atomic-rename-"));
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
  const root = await mkdtemp(join(tmpdir(), "pai-jsonl-"));
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
