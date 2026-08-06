import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson, type AtomicWriteHooks } from "../../src/core/atomic-json.js";

const boundaries: readonly {
  name: string;
  hooks: AtomicWriteHooks;
  expectedSequence: number;
}[] = [
  { name: "after temp sync", hooks: { afterTempSync: () => { throw new Error("after temp sync"); } }, expectedSequence: 1 },
  { name: "before rename", hooks: { beforeRename: () => { throw new Error("before rename"); } }, expectedSequence: 1 },
  { name: "after rename", hooks: { afterRename: () => { throw new Error("after rename"); } }, expectedSequence: 2 },
];

for (const boundary of boundaries) {
  test(`atomic JSON ${boundary.name} failure exposes only an old or complete new value`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pai-atomic-fault-"));
    const target = join(root, "state.json");
    t.after(() => rm(root, { recursive: true, force: true }));

    await atomicWriteJson(target, { sequence: 1, state: "OLD" });
    await assert.rejects(
      atomicWriteJson(target, { sequence: 2, state: "NEW" }, boundary.hooks),
      new RegExp(boundary.name),
    );

    const bytes = await readFile(target, "utf8");
    assert.ok(bytes.endsWith("\n"));
    assert.deepEqual(JSON.parse(bytes), {
      sequence: boundary.expectedSequence,
      state: boundary.expectedSequence === 1 ? "OLD" : "NEW",
    });
    assert.deepEqual((await readdir(root)).sort(), ["state.json"]);
  });
}
