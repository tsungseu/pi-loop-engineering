type PathPattern = readonly string[];
type PathSegment = string | number;

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MARKDOWN_BODY_FIELDS = new Set(["markdown", "markdown_body", "body_markdown", "content_markdown"]);

// Contract strings are checked by default. Only values whose bytes come from an
// external system or repository are exempted here; identifiers, enum-like
// values, actor/model classes, payload kinds, and plugin-authored prose are not.
const OPAQUE_PATHS: Readonly<Record<string, readonly PathPattern[]>> = {
  manifest: [
    ["entries", "*", "path"],
    ["entries", "*", "provenance"],
  ],
  evidence: [
    ["argv"],
    ["executable_path"],
    ["version_argv"],
    ["cwd"],
    ["tool_versions"],
    ["stdout_path"],
    ["stderr_path"],
  ],
  harness: [
    ["repository_root"],
    ["readable_paths"],
    ["writable_paths"],
  ],
  "agent-request": [
    ["read_set"],
    ["write_set"],
    ["worktree"],
  ],
  "agent-result": [
    ["actual_read_set"],
    ["actual_write_set"],
  ],
  handoff: [["rollback", "target"]],
  "release-harness": [["allowed_targets"]],
  "action-envelope": [
    ["target"],
    ["branch"],
    ["authorization", "target"],
    ["authorization", "authorized_by"],
  ],
  "project-policy": [
    ["included_paths"],
    ["excluded_paths"],
  ],
};

function pathStartsWith(path: readonly PathSegment[], pattern: PathPattern): boolean {
  if (path.length < pattern.length) return false;
  return pattern.every((segment, index) => segment === "*" || segment === String(path[index]));
}

function isExempt(schemaName: string, path: readonly PathSegment[]): boolean {
  const lastSegment = path.at(-1);
  if (typeof lastSegment === "string" && MARKDOWN_BODY_FIELDS.has(lastSegment)) return true;
  return (OPAQUE_PATHS[schemaName] ?? []).some((pattern) => pathStartsWith(path, pattern));
}

function renderPath(path: readonly PathSegment[]): string {
  return path.reduce<string>(
    (rendered, segment) => typeof segment === "number"
      ? `${rendered}[${segment}]`
      : rendered === "" ? segment : `${rendered}.${segment}`,
    "",
  );
}

function inspectValue(
  schemaName: string,
  value: unknown,
  path: readonly PathSegment[],
  variantSuffix: string,
): void {
  if (isExempt(schemaName, path)) return;

  if (typeof value === "string") {
    if (CJK_PATTERN.test(value)) {
      throw new Error(
        `Plugin-authored non-Markdown fixture contains CJK text at ${schemaName}${variantSuffix}.${renderPath(path)}.`,
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      inspectValue(schemaName, item, [...path, index], variantSuffix);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      inspectValue(schemaName, item, [...path, key], variantSuffix);
    }
  }
}

function fixtureVariants(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

export function assertPluginAuthoredEnglish(
  fixtures: Readonly<Record<string, unknown>>,
): void {
  for (const [schemaName, fixture] of Object.entries(fixtures)) {
    for (const [variantIndex, variant] of fixtureVariants(fixture).entries()) {
      const variantSuffix = Array.isArray(fixture) ? `[${variantIndex}]` : "";
      inspectValue(schemaName, variant, [], variantSuffix);
    }
  }
}
