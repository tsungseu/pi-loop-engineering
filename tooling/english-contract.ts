type FieldPath = readonly string[];

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const PLUGIN_AUTHORED_FIELDS: Readonly<Record<string, readonly FieldPath[]>> = {
  "agent-request": [
    ["objective"], ["acceptance", "*"], ["stop_conditions", "*"],
  ],
  "agent-result": [["summary"]],
  checkpoint: [["blocker"], ["resume_entry"]],
  evidence: [["actor_role"]],
  harness: [
    ["objective"], ["acceptance", "*"], ["out_of_scope", "*"], ["stop_rules", "*"],
    ["environment_gates", "*", "not_applicable_reason"],
  ],
  handoff: [
    ["residual_risks", "*"], ["rollback", "procedure", "*"], ["rollback", "triggers", "*"],
  ],
  "project-policy": [["environment_gates", "*", "not_applicable_reason"]],
  "knowledge-proposal": [
    ["correction_provenance", "*"], ["counterexamples", "*"], ["privacy_review"],
    ["expected_benefit"], ["safety_impact"], ["offline_evaluation", "*"],
    ["canary", "*"], ["rollback", "*"],
  ],
};

interface LocatedValue {
  readonly path: string;
  readonly value: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function locate(value: unknown, fieldPath: FieldPath, renderedPath: string): readonly LocatedValue[] {
  const [segment, ...remaining] = fieldPath;
  if (segment === undefined) return [{ path: renderedPath, value }];

  if (segment === "*") {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item, index) => locate(item, remaining, `${renderedPath}[${index}]`));
  }

  if (!isRecord(value) || !(segment in value)) return [];
  return locate(value[segment], remaining, renderedPath === "" ? segment : `${renderedPath}.${segment}`);
}

function fixtureVariants(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

export function assertPluginAuthoredEnglish(
  fixtures: Readonly<Record<string, unknown>>,
): void {
  for (const [schemaName, fieldPaths] of Object.entries(PLUGIN_AUTHORED_FIELDS)) {
    const fixture = fixtures[schemaName];
    if (fixture === undefined) continue;

    for (const [variantIndex, variant] of fixtureVariants(fixture).entries()) {
      for (const fieldPath of fieldPaths) {
        for (const located of locate(variant, fieldPath, "")) {
          if (typeof located.value === "string" && CJK_PATTERN.test(located.value)) {
            const variantSuffix = Array.isArray(fixture) ? `[${variantIndex}]` : "";
            throw new Error(
              `Plugin-authored non-Markdown fixture contains CJK text at ${schemaName}${variantSuffix}.${located.path}.`,
            );
          }
        }
      }
    }
  }
}
