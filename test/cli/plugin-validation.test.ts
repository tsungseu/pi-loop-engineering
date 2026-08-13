import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const fixture = await mkdtemp(join(tmpdir(), "pi-plugin-validation-"));
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify({
      name: "pi-loop-engineering",
      version: "0.3.5",
      engines: { node: ">=22" },
    }, null, 2)}\n`,
  );
  await mkdir(join(fixture, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(fixture, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "pi-loop-engineering",
      version: "0.3.5",
      description: options.description ?? EXPECTED_TAGLINE,
      interface: {
        displayName: "PI Loop Engineering",
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
      plugin_version: "0.3.5",
      node: { minimum: options.nodeMinimum ?? "22" },
      runtime: {
        language: options.runtimeLanguage ?? "JavaScript",
        dependencies: options.runtimeDependencies ?? [],
      },
      agent_namespace: "pi-loop-",
    }, null, 2)}\n`,
  );
  return fixture;
}

test("plugin delivery is a Node-only four-command clean break", async () => {
  const report = await validatePlugin(root);
  assert.equal(report.pluginId, "pi-loop-engineering");
  assert.equal(report.version, "0.3.5");
  assert.deepEqual(report.skills, ["knowledge-evolution", "loop-engineering", "release", "status"]);
  assert.deepEqual(report.runtimeLanguages, ["JavaScript"]);
  assert.deepEqual(report.runtimeDependencies, []);
  assert.deepEqual(report.legacyRuntimeFiles, []);
  assert.equal(report.schemaCount, 18);
  assert.deepEqual(report.markdownLanguages, ["en-US", "zh-CN"]);
  assert.equal(report.distMatchesSource, true);
});

test("full host validatePlugin passes on the real repository root", async () => {
  const report = await validatePlugin(root, { host: "full" });
  assert.equal(report.pluginId, "pi-loop-engineering");
  assert.equal(report.version, "0.3.5");
  assert.equal(report.distMatchesSource, true);
});

test("codex host validatePlugin passes on the real repository root", async () => {
  const report = await validatePlugin(root, { host: "codex" });
  assert.equal(report.pluginId, "pi-loop-engineering");
  assert.equal(report.version, "0.3.5");
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

test("full host rejects a non-empty commands/ directory", async () => {
  const fixture = await writeEarlyValidationFixture({});
  try {
    await mkdir(join(fixture, "commands"), { recursive: true });
    await writeFile(join(fixture, "commands", "loop.md"), "# forbidden\n");
    await assert.rejects(
      () => validatePlugin(fixture, { host: "full" }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /commands\//);
        return true;
      },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("full host requires Claude and Cursor manifests", async () => {
  const fixture = await writeEarlyValidationFixture({});
  try {
    await assert.rejects(
      () => validatePlugin(fixture, { host: "full" }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /\.claude-plugin|Claude|Cursor|\.cursor-plugin/i);
        return true;
      },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("codex host skips Claude and Cursor requirements", async () => {
  const fixture = await writeEarlyValidationFixture({});
  try {
    await assert.rejects(
      () => validatePlugin(fixture, { host: "codex" }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.doesNotMatch(error.message, /claude-plugin|cursor-plugin|commands\/|hooks\//i);
        assert.match(error.message, /Skill|skills|Exactly four/i);
        return true;
      },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Codex canary keeps four $ prompts and PI Loop Engineering displayName", async () => {
  const pluginJson = JSON.parse(
    await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"),
  ) as {
    interface?: { displayName?: unknown; defaultPrompt?: unknown };
  };
  assert.equal(pluginJson.interface?.displayName, "PI Loop Engineering");
  assert.ok(Array.isArray(pluginJson.interface?.defaultPrompt));
  assert.equal((pluginJson.interface?.defaultPrompt as unknown[]).length, 4);
  const prompts = (pluginJson.interface?.defaultPrompt as unknown[]).map(String);
  for (const skill of ["knowledge-evolution", "loop-engineering", "release", "status"]) {
    assert.ok(prompts.some((prompt) => prompt.includes(`$${skill}`)), `missing $${skill}`);
  }
});
