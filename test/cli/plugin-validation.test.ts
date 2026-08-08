import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONTROL_EXCLUSIONS,
  buildRuntimeManifest,
  buildSourceManifest,
} from "../../src/core/manifests.js";
import { ValidationError, checkDist, validatePlugin } from "../../src/cli/validate-plugin.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EXPECTED_TAGLINE = "From Prompt Engineering to Loop Engineering for Physical AI.";

const sourceOptions = {
  root,
  include: [] as const,
  exclusions: [...CONTROL_EXCLUSIONS],
  declaredArtifacts: [] as const,
};

async function writeEarlyValidationFixture(options: {
  description?: string;
  shortDescription?: string;
  nodeMinimum?: string;
  runtimeLanguage?: string;
  runtimeDependencies?: unknown;
}): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "pai-plugin-validation-"));
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify({
      name: "pai-loop-engineering",
      version: "0.3.0",
      engines: { node: ">=22" },
    }, null, 2)}\n`,
  );
  await mkdir(join(fixture, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(fixture, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "pai-loop-engineering",
      version: "0.3.0",
      description: options.description ?? EXPECTED_TAGLINE,
      interface: {
        displayName: "PAI Loop Engineering",
        shortDescription: options.shortDescription ?? EXPECTED_TAGLINE,
        defaultPrompt: [
          "$loop-engineering",
          "$status",
          "$release",
          "$knowledge-evolution",
        ],
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    join(fixture, "compatibility.json"),
    `${JSON.stringify({
      plugin_version: "0.3.0",
      node: { minimum: options.nodeMinimum ?? "22" },
      runtime: {
        language: options.runtimeLanguage ?? "JavaScript",
        dependencies: options.runtimeDependencies ?? [],
      },
      agent_namespace: "pai-loop-",
    }, null, 2)}\n`,
  );
  return fixture;
}

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

test("validator rejects when only one tagline field matches", async () => {
  const fixture = await writeEarlyValidationFixture({
    description: "Wrong tagline",
    shortDescription: EXPECTED_TAGLINE,
  });
  try {
    await assert.rejects(
      () => validatePlugin(fixture),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /Tagline must be/);
        return true;
      },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("validator rejects incompatible compatibility.json runtime gates", async () => {
  const fixture = await writeEarlyValidationFixture({
    nodeMinimum: "20",
    runtimeLanguage: "Python",
    runtimeDependencies: ["lodash"],
  });
  try {
    await assert.rejects(
      () => validatePlugin(fixture),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /node\.minimum must be "22"/);
        return true;
      },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
