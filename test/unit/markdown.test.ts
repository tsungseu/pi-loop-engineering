import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Digest, LoopId, MarkdownLanguage } from "../../src/contracts/domain.js";
import type { ContentManifest } from "../../src/contracts/harness.js";
import {
  renderLoopMarkdown,
  resolveMarkdownLanguage,
  type LoopNarrativeFacts,
} from "../../src/core/markdown.js";

async function writePreferences(root: string, value: unknown): Promise<void> {
  const stateRoot = join(root, ".ai-loop");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "preferences.json"), JSON.stringify(value), "utf8");
}

test("language priority is explicit then request instruction, preferences, and en-US", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-language-"));
  const emptyRoot = await mkdtemp(join(tmpdir(), "pi-language-empty-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(emptyRoot, { recursive: true, force: true }),
  ]));

  await writePreferences(root, { schema_version: 1, markdown_language: "zh-CN" });
  assert.equal(await resolveMarkdownLanguage({ workspace: root }), "zh-CN");
  assert.equal(await resolveMarkdownLanguage({ workspace: root, requestInstruction: "en-US" }), "en-US");
  assert.equal(await resolveMarkdownLanguage({ workspace: root, explicit: "en-US", requestInstruction: "zh-CN" }), "en-US");
  assert.equal(await resolveMarkdownLanguage({ workspace: emptyRoot }), "en-US");
});

test("unsupported explicit or persisted Markdown languages fail before rendering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-language-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const isInvalidLanguage = (error: unknown): boolean => (
    (error as { code?: string }).code === "INVALID_MARKDOWN_LANGUAGE"
  );
  await assert.rejects(resolveMarkdownLanguage({ workspace: root, explicit: "fr-FR" }), isInvalidLanguage);
  await assert.rejects(
    resolveMarkdownLanguage({ workspace: root, requestInstruction: "de-DE" as MarkdownLanguage }),
    isInvalidLanguage,
  );
  await writePreferences(root, { schema_version: 1, markdown_language: "fr-FR" });
  await assert.rejects(resolveMarkdownLanguage({ workspace: root }), isInvalidLanguage);
});

test("localized Markdown preserves stable IDs, enums, paths, and evidence digests", () => {
  const digest = "a".repeat(64) as Digest;
  const manifest = {
    schema_version: 1,
    kind: "source",
    entries: [{ path: "src/controller.ts", mode: "100644", digest, kind: "file" }],
    digest,
  } as const satisfies ContentManifest;
  const facts: LoopNarrativeFacts = {
    loopId: "loop-001" as LoopId,
    phase: "VERIFYING",
    status: "ACTIVE",
    problemAndContract: ["Control latency must remain bounded."],
    designAndSafetyInvariants: ["Emergency stop authority remains external."],
    outOfScope: ["REAL_VEHICLE_ROBOT deployment."],
    tasks: ["task-001: verify replay"],
    report: ["Implementation is ready for verification."],
    verification: [`evidence-001: ${digest}`],
    reviewAndResidualRisk: ["HIL remains RELEASE_REQUIRED."],
    journeyLog: ["Prefer replay before simulation."],
    evidenceDigests: [digest],
    manifests: [manifest],
  };

  const english = renderLoopMarkdown(facts, "en-US");
  const chinese = renderLoopMarkdown(facts, "zh-CN");

  for (const stableFact of ["loop-001", "VERIFYING", "ACTIVE", "[S1]", "[S2]", "[S3]", "src/controller.ts", digest]) {
    assert.ok(english.includes(stableFact), `English Markdown omitted ${stableFact}`);
    assert.ok(chinese.includes(stableFact), `Chinese Markdown omitted ${stableFact}`);
  }
  assert.match(english, /^# PI Loop Engineering/m);
  assert.match(english, /## Tasks/);
  assert.match(chinese, /## 任务/);
  assert.match(chinese, /## 审查与残余风险/);
  assert.ok(english.endsWith("\n"));
  assert.ok(chinese.endsWith("\n"));
});
