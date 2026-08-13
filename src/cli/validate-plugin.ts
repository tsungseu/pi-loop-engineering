import { spawn } from "node:child_process";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONTROL_EXCLUSIONS,
  SOURCE_INCLUSIONS,
  buildRuntimeManifest,
  buildSourceManifest,
} from "../core/manifests.js";
import { synchronizeAgents } from "./sync-agents.js";

export const EXPECTED_SKILLS = [
  "knowledge-evolution",
  "loop-engineering",
  "release",
  "status",
] as const;

export const EXPECTED_DIST_ENTRYPOINTS = [
  "dist/cli/loopctl.js",
  "dist/cli/releasectl.js",
  "dist/cli/knowledgectl.js",
  "dist/cli/codegraphctl.js",
  "dist/cli/triggerctl.js",
  "dist/cli/sync-agents.js",
  "dist/cli/validate-plugin.js",
] as const;

const OLD_SKILL_DIRS = ["init", "run", "review", "learn", "superworkflows"] as const;
const LICENSE_MARKERS = ["Copyright (c) 2026 Tsung Xu", "Dual-licensed: AGPL-3.0-only"] as const;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Patterns are assembled from parts so this file does not embed banned delivery tokens.
const FORBIDDEN_VOCABULARY: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "legacy run identifier field", pattern: new RegExp(String.raw`\b${"run"}_${"id"}\b`, "u") },
  { label: "legacy parent run identifier field", pattern: new RegExp(String.raw`\b${"parent"}_${"run"}_${"id"}\b`, "u") },
  { label: "legacy control-root run directory", pattern: new RegExp(String.raw`\.${"ai"}/${"runs"}\b`, "u") },
  { label: "legacy agent profile glob", pattern: new RegExp(String.raw`\b${"sw"}-\*`, "u") },
  { label: "legacy init command", pattern: new RegExp(String.raw`\$${"init"}\b`, "u") },
  { label: "legacy run command", pattern: new RegExp(String.raw`\$${"run"}\b`, "u") },
  { label: "legacy review command", pattern: new RegExp(String.raw`\$${"review"}\b`, "u") },
  { label: "legacy learn command", pattern: new RegExp(String.raw`\$${"learn"}\b`, "u") },
  { label: "legacy router command", pattern: new RegExp(String.raw`\$${"superworkflows"}\b`, "u") },
];

const SCAN_ROOTS = [
  "skills",
  "assets",
  "schemas",
  "src",
  "dist",
  ".codex-plugin",
  ".claude-plugin",
  ".cursor-plugin",
  "agents",
  "hooks",
] as const;

export type ValidateHost = "codex" | "full";

const FULL_HOST_HOOK_FILES = [
  "hooks/claude/hooks.json",
  "hooks/cursor/hooks.json",
  "hooks/scripts/session-boundary.mjs",
  "hooks/scripts/shell-guard.mjs",
] as const;

// Host loaders accept a specific shape for the `agents` manifest field.
// Claude only accepts files or file arrays (directories are rejected by
// `claude plugin validate`). Cursor accepts files or directories. We pin the
// manifest to the strictest form that both loaders accept so a single source
// tree loads identically on each host.
const HOST_AGENT_STEMS = [
  "biped-cerebellum-engineer",
  "environment-reviewer",
  "explorer",
  "release-engineer",
  "reviewer",
  "robot-brain-engineer",
  "robot-data-algorithm",
  "robot-data-collector",
  "safety-reviewer",
  "worker",
] as const;

const DOCUMENTATION_ALLOWLIST = new Set([
  "README.md",
  "README.zh-CN.md",
  "CHANGELOG.md",
  "CHANGELOG.zh-CN.md",
  "SECURITY.md",
]);

export interface ValidationReport {
  pluginId: "pi-loop-engineering";
  version: "0.3.5";
  skills: readonly ["knowledge-evolution", "loop-engineering", "release", "status"];
  runtimeLanguages: readonly ["JavaScript"];
  runtimeDependencies: readonly [];
  legacyRuntimeFiles: readonly [];
  schemaCount: 18;
  markdownLanguages: readonly ["en-US", "zh-CN"];
  distMatchesSource: true;
}

export class ValidationError extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function walkFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".test-dist") continue;
      files.push(...await walkFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function assertLicenseHeader(relativePath: string, text: string): void {
  for (const marker of LICENSE_MARKERS) {
    if (!text.includes(marker)) {
      throw new ValidationError("Missing license header.", { path: relativePath, marker });
    }
  }
}

async function assertMarkdownLinks(root: string, relativePath: string, text: string): Promise<void> {
  const linkPattern = new RegExp(String.raw`\[([^\]]*)\]\(([^)]+)\)`, "gu");
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(text)) !== null) {
    const target = match[2]!.trim();
    if (target === "" || target.startsWith("#") || /^[a-z]+:/iu.test(target)) continue;
    const [pathPart] = target.split("#");
    if (pathPart === undefined || pathPart === "") continue;
    const resolved = resolve(dirname(join(root, relativePath)), pathPart);
    if (!(await pathExists(resolved))) {
      throw new ValidationError("Broken Markdown link.", { path: relativePath, target });
    }
  }
}

async function checkDist(root: string): Promise<boolean> {
  const script = join(root, "tooling", "check-dist.mjs");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script], { cwd: root, stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new ValidationError("check:dist mismatch.", {
        code: signal === null ? code : signal,
      }));
    });
  });
  return true;
}

export { checkDist };

async function scanForbiddenVocabulary(root: string): Promise<void> {
  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = join(root, scanRoot);
    if (!(await pathExists(absoluteRoot))) continue;
    for (const file of await walkFiles(absoluteRoot)) {
      const relativePath = toPosix(relative(root, file));
      if (relativePath.endsWith(".map")) continue;
      if (!/\.(?:ts|js|json|md|toml|yaml|yml|mjs|cjs)$/iu.test(relativePath)) continue;
      const text = await readFile(file, "utf8");
      for (const rule of FORBIDDEN_VOCABULARY) {
        if (rule.pattern.test(text)) {
          throw new ValidationError(`Forbidden delivery vocabulary: ${rule.label}.`, {
            path: relativePath,
          });
        }
      }
    }
  }
}

async function assertNoLegacyControlFiles(root: string): Promise<void> {
  const candidates = [
    "scripts/pi_loop",
    "scripts/codegraphctl.py",
    "scripts/loopctl.py",
    "scripts/triggerctl.py",
    "scripts/sync_agents.py",
    "loopctl.sh",
    "scripts/loopctl.sh",
  ];
  for (const candidate of candidates) {
    if (await pathExists(join(root, candidate))) {
      throw new ValidationError("Legacy Python/Shell control file present.", { path: candidate });
    }
  }

  for (const file of await walkFiles(root)) {
    const relativePath = toPosix(relative(root, file));
    if (relativePath.startsWith("node_modules/") || relativePath.startsWith(".test-dist/") || relativePath.startsWith("docs/")) {
      continue;
    }
    if (relativePath.endsWith(".py") || /(^|\/)[^/]+\.sh$/u.test(relativePath)) {
      throw new ValidationError("Python/Shell control file present.", { path: relativePath });
    }
  }
}

async function assertSourceMapsRelative(root: string): Promise<void> {
  const distRoot = join(root, "dist");
  if (!(await pathExists(distRoot))) {
    throw new ValidationError("Missing dist directory.");
  }
  for (const file of await walkFiles(distRoot)) {
    if (!file.endsWith(".js.map")) continue;
    const relativePath = toPosix(relative(root, file));
    const sourceMap = JSON.parse(await readFile(file, "utf8")) as {
      sourceRoot?: unknown;
      sources?: unknown;
    };
    const candidates = [
      sourceMap.sourceRoot,
      ...(Array.isArray(sourceMap.sources) ? sourceMap.sources : []),
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      if (
        isAbsolute(candidate)
        || /^[A-Za-z]:[\\/]/u.test(candidate)
        || /^\\\\/u.test(candidate)
        || /^file:\/\//iu.test(candidate)
      ) {
        throw new ValidationError("Source map contains absolute path.", {
          path: relativePath,
          candidate,
        });
      }
    }
  }
}

async function assertSchemaFixturesEnglish(root: string): Promise<void> {
  const schemaRoot = join(root, "schemas");
  for (const file of await walkFiles(schemaRoot)) {
    if (!file.endsWith(".json")) continue;
    const text = await readFile(file, "utf8");
    if (CJK_PATTERN.test(text)) {
      throw new ValidationError("Non-English plugin-generated Schema fixture.", {
        path: toPosix(relative(root, file)),
      });
    }
  }
}

async function assertNoCommandsDirectory(root: string): Promise<void> {
  const commandsPath = join(root, "commands");
  if (!(await pathExists(commandsPath))) return;
  const info = await stat(commandsPath);
  if (info.isDirectory()) {
    throw new ValidationError("commands/ directory is forbidden.", { path: "commands" });
  }
}

function normalizeDeclaredPath(root: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return toPosix(relative(root, resolve(root, value))).replace(/\/$/u, "");
}

function isHooksRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const hooks = record.hooks;
  return hooks !== null && typeof hooks === "object" && !Array.isArray(hooks);
}

/**
 * Host loaders disagree on what the `agents` manifest field may contain.
 *
 * - Claude Code (`claude plugin validate`): accepts a file path or a file
 *   array only. A directory value fails with "agents: Invalid input".
 * - Cursor: accepts files, file arrays, or directories.
 *
 * We therefore ship Claude's manifest as a file array (one entry per agent
 * profile, sorted by stem) and Cursor's as a directory. The validator mirrors
 * both forms so a regression on either side is caught locally.
 */
function assertClaudeAgentsField(root: string, relativePath: string, value: unknown): void {
  // Claude Code rejects directory values for `agents`. A single string is
  // allowed only when it points at a specific agent file.
  if (typeof value === "string") {
    const file = normalizeDeclaredPath(root, value);
    if (!file?.startsWith("agents/claude/pi-loop-") || !file.endsWith(".md")) {
      throw new ValidationError(".claude-plugin agents must be a file path or file array.", {
        path: relativePath,
        agents: value,
      });
    }
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ValidationError(".claude-plugin agents must be a file path or file array.", {
      path: relativePath,
      agents: value,
    });
  }
  const resolved = value.map((entry) => normalizeDeclaredPath(root, entry)).sort();
  const expected = HOST_AGENT_STEMS
    .map((stem) => `agents/claude/pi-loop-${stem}.md`)
    .sort();
  if (resolved.length !== expected.length || resolved.some((entry, index) => entry !== expected[index])) {
    throw new ValidationError(".claude-plugin agents must enumerate every pi-loop-*.md under agents/claude/.", {
      path: relativePath,
      agents: value,
      resolved,
      expected,
    });
  }
}

function assertCursorAgentsField(root: string, relativePath: string, value: unknown): void {
  // Cursor accepts a directory string, a file string, an array of files, or
  // an array of directories. A bare directory string is the common case and
  // must be honored before we treat it as a one-element file list.
  if (typeof value === "string") {
    const directory = normalizeDeclaredPath(root, value);
    if (directory === "agents/cursor") return;
    const file = normalizeDeclaredPath(root, value);
    if (file === "agents/cursor/pi-loop-worker.md") return;
    throw new ValidationError(".cursor-plugin agents must point to ./agents/cursor/ or enumerate the files.", {
      path: relativePath,
      agents: value,
    });
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ValidationError(".cursor-plugin agents must be a path or an array of paths.", {
      path: relativePath,
      agents: value,
    });
  }
  const resolved = value.map((entry) => normalizeDeclaredPath(root, entry)).sort();
  const expected = HOST_AGENT_STEMS
    .map((stem) => `agents/cursor/pi-loop-${stem}.md`)
    .sort();
  const allFiles = resolved.length === expected.length
    && resolved.every((entry, index) => entry === expected[index]);
  if (!allFiles) {
    throw new ValidationError(".cursor-plugin agents array must enumerate every pi-loop-*.md under agents/cursor/.", {
      path: relativePath,
      agents: value,
      resolved,
      expected,
    });
  }
}

async function assertHostPluginManifest(
  root: string,
  relativeDir: ".claude-plugin" | ".cursor-plugin",
  host: "claude" | "cursor",
): Promise<void> {
  const relativePath = `${relativeDir}/plugin.json`;
  const absolute = join(root, relativePath);
  if (!(await pathExists(absolute))) {
    throw new ValidationError(`Missing ${relativePath}.`, { path: relativePath });
  }
  const manifest = JSON.parse(await readFile(absolute, "utf8")) as {
    name?: unknown;
    version?: unknown;
    skills?: unknown;
    agents?: unknown;
    hooks?: unknown;
    commands?: unknown;
  };
  if (manifest.name !== "pi-loop-engineering") {
    throw new ValidationError(`${relativeDir} name must be pi-loop-engineering.`, {
      path: relativePath,
      name: manifest.name,
    });
  }
  if (manifest.version !== "0.3.5") {
    throw new ValidationError(`${relativeDir} version must be 0.3.5.`, {
      path: relativePath,
      version: manifest.version,
    });
  }
  if ("commands" in manifest) {
    throw new ValidationError(`${relativeDir} must not declare commands.`, {
      path: relativePath,
    });
  }
  const skillsPath = normalizeDeclaredPath(root, manifest.skills);
  if (skillsPath !== "skills") {
    throw new ValidationError(`${relativeDir} skills must point to ./skills/.`, {
      path: relativePath,
      skills: manifest.skills,
    });
  }
  if (host === "claude") {
    assertClaudeAgentsField(root, relativePath, manifest.agents);
  } else {
    assertCursorAgentsField(root, relativePath, manifest.agents);
  }
  const hooksPath = normalizeDeclaredPath(root, manifest.hooks);
  if (hooksPath !== `hooks/${host}/hooks.json`) {
    throw new ValidationError(`${relativeDir} hooks must point to ./hooks/${host}/hooks.json.`, {
      path: relativePath,
      hooks: manifest.hooks,
    });
  }
}

async function assertHostAgentMarkdown(
  root: string,
  host: "claude" | "cursor",
): Promise<void> {
  const relativeDir = `agents/${host}`;
  const absolute = join(root, relativeDir);
  if (!(await pathExists(absolute))) {
    throw new ValidationError(`Missing ${relativeDir} directory.`, { path: relativeDir });
  }
  const files = (await readdir(absolute))
    .filter((name) => name.startsWith("pi-loop-") && name.endsWith(".md"))
    .sort();
  if (files.length !== 10) {
    throw new ValidationError(`${relativeDir} must contain exactly 10 pi-loop-*.md files.`, {
      path: relativeDir,
      files,
      count: files.length,
    });
  }
}

function assertClaudeHooksShape(payload: unknown, relativePath: string): void {
  if (!isHooksRecord(payload)) {
    throw new ValidationError("Claude hooks.json must be an object with a `hooks` key.", { path: relativePath });
  }
  const hooks = payload.hooks as Record<string, unknown>;
  const sessionStart = hooks.SessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length === 0) {
    throw new ValidationError("Claude hooks.json must wire SessionStart.", { path: relativePath });
  }
  const preToolUse = hooks.PreToolUse;
  if (!Array.isArray(preToolUse) || preToolUse.length === 0) {
    throw new ValidationError("Claude hooks.json must wire PreToolUse for Bash.", { path: relativePath });
  }
}

function assertCursorHooksShape(payload: unknown, relativePath: string): void {
  if (!isHooksRecord(payload)) {
    throw new ValidationError("Cursor hooks.json must be an object with a `hooks` key.", { path: relativePath });
  }
  for (const key of Object.keys(payload)) {
    if (key !== "hooks") {
      throw new ValidationError("Cursor hooks.json must not declare a top-level wrapper.", {
        path: relativePath,
        key,
      });
    }
  }
  const hooks = payload.hooks as Record<string, unknown>;
  const sessionStart = hooks.sessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length === 0) {
    throw new ValidationError("Cursor hooks.json must wire sessionStart.", { path: relativePath });
  }
  const beforeShell = hooks.beforeShellExecution;
  if (!Array.isArray(beforeShell) || beforeShell.length === 0) {
    throw new ValidationError("Cursor hooks.json must wire beforeShellExecution.", { path: relativePath });
  }
}

async function assertHostHooksArtifacts(root: string): Promise<void> {
  for (const relativePath of FULL_HOST_HOOK_FILES) {
    const absolute = join(root, relativePath);
    const info = await stat(absolute).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new ValidationError("Missing required host hook artifact.", { path: relativePath });
    }
    if (relativePath.endsWith("hooks.json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(absolute, "utf8"));
      } catch (error) {
        throw new ValidationError("Host hooks.json must be valid JSON.", {
          path: relativePath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      if (relativePath.startsWith("hooks/claude/")) {
        assertClaudeHooksShape(parsed, relativePath);
      } else {
        assertCursorHooksShape(parsed, relativePath);
      }
    }
  }
}

async function assertFullHostSurface(root: string): Promise<void> {
  await assertHostPluginManifest(root, ".claude-plugin", "claude");
  await assertHostPluginManifest(root, ".cursor-plugin", "cursor");
  await assertHostHooksArtifacts(root);
  await assertHostAgentMarkdown(root, "claude");
  await assertHostAgentMarkdown(root, "cursor");
  try {
    await synchronizeAgents({ root, check: true });
  } catch (error) {
    throw new ValidationError("Host agent contracts drifted from TOML source.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function validatePlugin(
  root: string,
  options: { host?: ValidateHost } = {},
): Promise<ValidationReport> {
  const host = options.host ?? "full";
  const canonicalRoot = await realpath(resolve(root));
  const packageJson = JSON.parse(await readFile(join(canonicalRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    engines?: { node?: unknown };
    dependencies?: unknown;
    scripts?: Record<string, unknown>;
  };
  const pluginJson = JSON.parse(
    await readFile(join(canonicalRoot, ".codex-plugin", "plugin.json"), "utf8"),
  ) as {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    interface?: {
      displayName?: unknown;
      shortDescription?: unknown;
      defaultPrompt?: unknown;
    };
  };
  const compatibility = JSON.parse(
    await readFile(join(canonicalRoot, "compatibility.json"), "utf8"),
  ) as {
    plugin_version?: unknown;
    agent_namespace?: unknown;
    python?: unknown;
    runtime?: { language?: unknown; dependencies?: unknown };
    node?: { minimum?: unknown };
  };

  if (packageJson.name !== "pi-loop-engineering" || pluginJson.name !== "pi-loop-engineering") {
    throw new ValidationError("Plugin id must be pi-loop-engineering.", {
      packageName: packageJson.name,
      pluginName: pluginJson.name,
    });
  }
  if (
    packageJson.version !== "0.3.5"
    || pluginJson.version !== "0.3.5"
    || compatibility.plugin_version !== "0.3.5"
  ) {
    throw new ValidationError("Inconsistent versions.", {
      packageVersion: packageJson.version,
      pluginVersion: pluginJson.version,
      compatibilityVersion: compatibility.plugin_version,
    });
  }
  if (packageJson.engines?.node !== ">=22") {
    throw new ValidationError("Node engine must be >=22.", { engines: packageJson.engines });
  }
  if (compatibility.python !== undefined) {
    throw new ValidationError("compatibility.json must not declare a Python runtime.");
  }
  if (compatibility.agent_namespace !== "pi-loop-") {
    throw new ValidationError("Agent namespace must be pi-loop-.", {
      agent_namespace: compatibility.agent_namespace,
    });
  }
  if (compatibility.node?.minimum !== "22") {
    throw new ValidationError("compatibility.json node.minimum must be \"22\".", {
      node: compatibility.node,
    });
  }
  if (compatibility.runtime?.language !== "JavaScript") {
    throw new ValidationError("compatibility.json runtime.language must be JavaScript.", {
      runtime: compatibility.runtime,
    });
  }
  const runtimeDependencies = compatibility.runtime?.dependencies;
  if (!Array.isArray(runtimeDependencies) || runtimeDependencies.length !== 0) {
    throw new ValidationError("compatibility.json runtime.dependencies must be an empty array.", {
      dependencies: runtimeDependencies,
    });
  }
  if (pluginJson.interface?.displayName !== "PI Loop Engineering") {
    throw new ValidationError("Display name must be PI Loop Engineering.");
  }
  const expectedTagline = "From Prompt Engineering to Loop Engineering for Physical AI.";
  if (
    pluginJson.description !== expectedTagline
    || pluginJson.interface?.shortDescription !== expectedTagline
  ) {
    throw new ValidationError("Tagline must be From Prompt Engineering to Loop Engineering for Physical AI.", {
      description: pluginJson.description,
      shortDescription: pluginJson.interface?.shortDescription,
    });
  }
  const prompts = pluginJson.interface?.defaultPrompt;
  if (!Array.isArray(prompts) || prompts.length !== 4) {
    throw new ValidationError("plugin.json must declare exactly four command prompts.");
  }
  const promptText = prompts.map(String).join("\n");
  for (const skill of EXPECTED_SKILLS) {
    if (!promptText.includes(`$${skill}`)) {
      throw new ValidationError("plugin.json prompts must cover every public command.", { skill });
    }
  }

  if (packageJson.dependencies !== undefined && Object.keys(packageJson.dependencies as object).length > 0) {
    throw new ValidationError("npm runtime dependencies must be empty.", {
      dependencies: packageJson.dependencies,
    });
  }

  await assertNoCommandsDirectory(canonicalRoot);

  if (host === "full") {
    await assertFullHostSurface(canonicalRoot);
  }

  const skillsRoot = join(canonicalRoot, "skills");
  if (!(await pathExists(skillsRoot))) {
    throw new ValidationError("Exactly four Skills are required.", { skills: [] });
  }
  const skills = await listDirectories(skillsRoot);
  if (JSON.stringify(skills) !== JSON.stringify([...EXPECTED_SKILLS])) {
    throw new ValidationError("Exactly four Skills are required.", { skills });
  }
  for (const old of OLD_SKILL_DIRS) {
    if (skills.includes(old)) {
      throw new ValidationError("Legacy Skill directory present.", { skill: old });
    }
  }
  if (skills.includes("superworkflows") || skills.includes("router")) {
    throw new ValidationError("Router Skill is not allowed.");
  }

  for (const skill of EXPECTED_SKILLS) {
    const skillMarkdown = await readFile(join(canonicalRoot, "skills", skill, "SKILL.md"), "utf8");
    const yaml = await readFile(join(canonicalRoot, "skills", skill, "agents", "openai.yaml"), "utf8");
    assertLicenseHeader(`skills/${skill}/SKILL.md`, skillMarkdown);
    assertLicenseHeader(`skills/${skill}/agents/openai.yaml`, yaml);
  }

  const agentRoot = join(canonicalRoot, "assets", "agents");
  const agentFiles = (await readdir(agentRoot)).filter((name) => name.endsWith(".toml")).sort();
  if (agentFiles.length === 0) {
    throw new ValidationError("No Agent profiles found.");
  }
  for (const file of agentFiles) {
    if (!file.startsWith("pi-loop-")) {
      throw new ValidationError("Legacy or non-namespaced Agent profile present.", { file });
    }
    assertLicenseHeader(`assets/agents/${file}`, await readFile(join(agentRoot, file), "utf8"));
  }

  for (const relativePath of [
    "assets/loop-engineering/workflow.md",
    "assets/loop-engineering/review.md",
  ]) {
    assertLicenseHeader(relativePath, await readFile(join(canonicalRoot, relativePath), "utf8"));
  }

  const templates = (await readdir(join(canonicalRoot, "assets", "loop-engineering", "templates")))
    .filter((name) => name.endsWith(".md"))
    .sort();
  if (JSON.stringify(templates) !== JSON.stringify(["LOOP.en-US.md", "LOOP.zh-CN.md"])) {
    throw new ValidationError("Only two LOOP Markdown templates are allowed.", { templates });
  }
  const knowledgeTemplates = (await readdir(join(canonicalRoot, "assets", "knowledge")))
    .filter((name) => name.endsWith(".md"))
    .sort();
  if (JSON.stringify(knowledgeTemplates) !== JSON.stringify(["proposal.en-US.md", "proposal.zh-CN.md"])) {
    throw new ValidationError("Only two Knowledge Proposal templates are allowed.", {
      knowledgeTemplates,
    });
  }
  if (await pathExists(join(canonicalRoot, "assets", "loop-engineering", "project-profile.json"))) {
    throw new ValidationError("Legacy project-profile.json must be deleted.");
  }

  const schemas = (await readdir(join(canonicalRoot, "schemas")))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  if (schemas.length !== 18) {
    throw new ValidationError("Schema count must be 18.", { schemaCount: schemas.length, schemas });
  }
  await assertSchemaFixturesEnglish(canonicalRoot);

  await assertNoLegacyControlFiles(canonicalRoot);
  await scanForbiddenVocabulary(canonicalRoot);

  for (const entrypoint of EXPECTED_DIST_ENTRYPOINTS) {
    const info = await stat(join(canonicalRoot, entrypoint)).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new ValidationError("Missing dist entrypoint.", { entrypoint });
    }
  }
  await assertSourceMapsRelative(canonicalRoot);

  for (const doc of DOCUMENTATION_ALLOWLIST) {
    const text = await readFile(join(canonicalRoot, doc), "utf8");
    await assertMarkdownLinks(canonicalRoot, doc, text);
  }

  const source = await buildSourceManifest({
    root: canonicalRoot,
    include: [...SOURCE_INCLUSIONS],
    exclusions: [...CONTROL_EXCLUSIONS],
    declaredArtifacts: [],
  });
  const runtime = await buildRuntimeManifest(canonicalRoot);
  if (!source.entries.some((entry) => entry.path === "package-lock.json")) {
    throw new ValidationError("Source manifest must include package-lock.json.");
  }
  if (!runtime.entries.every((entry) => entry.path.startsWith("dist/"))) {
    throw new ValidationError("Runtime manifest must contain only dist/ entries.");
  }

  const distMatchesSource = await checkDist(canonicalRoot);
  if (distMatchesSource !== true) {
    throw new ValidationError("distMatchesSource must be true.");
  }

  return {
    pluginId: "pi-loop-engineering",
    version: "0.3.5",
    skills: EXPECTED_SKILLS,
    runtimeLanguages: ["JavaScript"],
    runtimeDependencies: [],
    legacyRuntimeFiles: [],
    schemaCount: 18,
    markdownLanguages: ["en-US", "zh-CN"],
    distMatchesSource: true,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    let host: ValidateHost = "full";
    let rootArg: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]!;
      if (arg === "--host") {
        const value = argv[index + 1];
        if (value !== "codex" && value !== "full") {
          throw new ValidationError("Invalid --host value.", { host: value });
        }
        host = value;
        index += 1;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new ValidationError("Unknown CLI flag.", { flag: arg });
      }
      if (rootArg !== undefined) {
        throw new ValidationError("Multiple root arguments are not supported.", {
          root: rootArg,
          extra: arg,
        });
      }
      rootArg = arg;
    }
    const root = rootArg === undefined
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
      : resolve(rootArg);
    const report = await validatePlugin(root, { host });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof ValidationError ? error.details : {};
    process.stderr.write(`${JSON.stringify({ error: { code: "VALIDATION_FAILED", message, details } })}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
