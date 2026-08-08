import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LoopError,
  type Digest,
  type LoopId,
  type MarkdownLanguage,
} from "../contracts/domain.js";
import type { ContentManifest } from "../contracts/harness.js";
import type { Preferences } from "../contracts/release.js";
import { validateSchema } from "./schema.js";
import { resolveLayout } from "./paths.js";

export type { MarkdownLanguage } from "../contracts/domain.js";

export interface LanguageInput {
  workspace: string;
  explicit?: string;
  requestInstruction?: MarkdownLanguage;
}

export interface LoopNarrativeFacts {
  loopId: LoopId;
  phase: string;
  status: string;
  problemAndContract: readonly string[];
  designAndSafetyInvariants: readonly string[];
  outOfScope: readonly string[];
  tasks: readonly string[];
  report: readonly string[];
  verification: readonly string[];
  reviewAndResidualRisk: readonly string[];
  journeyLog: readonly string[];
  evidenceDigests: readonly Digest[];
  manifests: readonly ContentManifest[];
}

async function readPreference(workspace: string): Promise<MarkdownLanguage | undefined> {
  const path = resolveLayout(workspace).preferencesJson;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new LoopError("SCHEMA_INVALID", "Markdown preferences are not valid JSON.", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "markdown_language")) {
    assertSupportedLanguage((value as Readonly<Record<string, unknown>>).markdown_language);
  }
  return validateSchema<Preferences>("preferences", value).markdown_language;
}

function assertSupportedLanguage(value: unknown): MarkdownLanguage {
  if (value !== "en-US" && value !== "zh-CN") {
    throw new LoopError("INVALID_MARKDOWN_LANGUAGE", "Supported Markdown languages are en-US and zh-CN.", { value });
  }
  return value;
}

export async function resolveMarkdownLanguage(input: LanguageInput): Promise<MarkdownLanguage> {
  const candidate = input.explicit ?? input.requestInstruction ?? await readPreference(input.workspace) ?? "en-US";
  return assertSupportedLanguage(candidate);
}

function templatePath(language: MarkdownLanguage): string {
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../assets/loop-engineering/templates", `LOOP.${language}.md`),
    resolve(moduleDirectory, "../../../assets/loop-engineering/templates", `LOOP.${language}.md`),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new LoopError("SCHEMA_INVALID", "Loop Markdown template was not found.", { language });
  }
  return path;
}

function list(values: readonly string[], language: MarkdownLanguage): string {
  if (values.length === 0) return language === "zh-CN" ? "- 无。" : "- None.";
  return values.map((value) => `- ${value.replace(/\n/gu, "\n  ")}`).join("\n");
}

function manifestList(manifests: readonly ContentManifest[], language: MarkdownLanguage): string {
  const lines = manifests.flatMap((manifest) => [
    `${manifest.kind}: ${manifest.digest}`,
    ...manifest.entries.map((entry) => `  ${entry.path} (${entry.kind}, ${entry.mode}): ${entry.digest}`),
  ]);
  return list(lines, language);
}

export function renderLoopMarkdown(facts: LoopNarrativeFacts, language: MarkdownLanguage): string {
  const template = readFileSync(templatePath(language), "utf8");
  const replacements: Readonly<Record<string, string>> = {
    loop_id: facts.loopId,
    phase: facts.phase,
    status: facts.status,
    problem_and_contract: list(facts.problemAndContract, language),
    design_and_safety_invariants: list(facts.designAndSafetyInvariants, language),
    out_of_scope: list(facts.outOfScope, language),
    tasks: list(facts.tasks, language),
    report: list(facts.report, language),
    verification: list(facts.verification, language),
    review_and_residual_risk: list(facts.reviewAndResidualRisk, language),
    journey_log: list(facts.journeyLog.slice(0, 5), language),
    evidence_digests: list(facts.evidenceDigests, language),
    manifests: manifestList(facts.manifests, language),
  };
  const rendered = template.replace(/\{\{([a-z_]+)\}\}/gu, (placeholder, key: string) => {
    const replacement = replacements[key];
    if (replacement === undefined) {
      throw new LoopError("SCHEMA_INVALID", "Loop Markdown template contains an unknown placeholder.", { placeholder });
    }
    return replacement;
  });
  return `${rendered.replace(/\n*$/u, "")}\n`;
}
