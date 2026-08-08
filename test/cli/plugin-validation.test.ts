import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONTROL_EXCLUSIONS,
  buildRuntimeManifest,
  buildSourceManifest,
} from "../../src/core/manifests.js";
import { checkDist, validatePlugin } from "../../src/cli/validate-plugin.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

const sourceOptions = {
  root,
  include: [] as const,
  exclusions: [...CONTROL_EXCLUSIONS],
  declaredArtifacts: [] as const,
};

test("plugin delivery is a Node-only four-command clean break", async () => {
  const report = await validatePlugin(root);
  assert.equal(report.pluginId, "pai-loop-engineering");
  assert.equal(report.version, "0.3.0");
  assert.deepEqual(report.skills, ["knowledge-evolution", "loop-engineering", "release", "status"]);
  assert.deepEqual(report.runtimeLanguages, ["JavaScript"]);
  assert.deepEqual(report.runtimeDependencies, []);
  assert.deepEqual(report.legacyRuntimeFiles, []);
  assert.equal(report.schemaCount, 18);
  assert.deepEqual(report.markdownLanguages, ["en-US", "zh-CN"]);
  assert.equal(report.distMatchesSource, true);
});

test("Source and Runtime manifests bind deterministic reviewed code", async () => {
  const source = await buildSourceManifest(sourceOptions);
  const runtime = await buildRuntimeManifest(root);
  assert.ok(source.entries.some((entry) => entry.path === "package-lock.json"));
  assert.ok(runtime.entries.every((entry) => entry.path.startsWith("dist/")));
  assert.equal(await checkDist(root), true);
});
