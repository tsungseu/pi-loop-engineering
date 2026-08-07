import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LoopError, } from "../contracts/domain.js";
import { validateSchema } from "./schema.js";
import { resolveLayout } from "./paths.js";
async function readPreference(workspace) {
    const path = resolveLayout(workspace).preferencesJson;
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new LoopError("SCHEMA_INVALID", "Markdown preferences are not valid JSON.", {
            path,
            cause: error instanceof Error ? error.message : String(error),
        });
    }
    if (value !== null && typeof value === "object" && Object.hasOwn(value, "markdown_language")) {
        assertSupportedLanguage(value.markdown_language);
    }
    return validateSchema("preferences", value).markdown_language;
}
function assertSupportedLanguage(value) {
    if (value !== "en-US" && value !== "zh-CN") {
        throw new LoopError("INVALID_MARKDOWN_LANGUAGE", "Supported Markdown languages are en-US and zh-CN.", { value });
    }
    return value;
}
export async function resolveMarkdownLanguage(input) {
    const candidate = input.explicit ?? input.requestInstruction ?? await readPreference(input.workspace) ?? "en-US";
    return assertSupportedLanguage(candidate);
}
function templatePath(language) {
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
function list(values, language) {
    if (values.length === 0)
        return language === "zh-CN" ? "- 无。" : "- None.";
    return values.map((value) => `- ${value.replace(/\n/gu, "\n  ")}`).join("\n");
}
function manifestList(manifests, language) {
    const lines = manifests.flatMap((manifest) => [
        `${manifest.kind}: ${manifest.digest}`,
        ...manifest.entries.map((entry) => `  ${entry.path} (${entry.kind}, ${entry.mode}): ${entry.digest}`),
    ]);
    return list(lines, language);
}
export function renderLoopMarkdown(facts, language) {
    const template = readFileSync(templatePath(language), "utf8");
    const replacements = {
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
    const rendered = template.replace(/\{\{([a-z_]+)\}\}/gu, (placeholder, key) => {
        const replacement = replacements[key];
        if (replacement === undefined) {
            throw new LoopError("SCHEMA_INVALID", "Loop Markdown template contains an unknown placeholder.", { placeholder });
        }
        return replacement;
    });
    return `${rendered.replace(/\n*$/u, "")}\n`;
}
//# sourceMappingURL=markdown.js.map