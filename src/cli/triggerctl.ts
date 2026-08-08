import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

class UsageError extends Error {
  constructor(message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE_EXIT_CODE = 2;
const UNKNOWN_EXIT_CODE = 1;

const PLUGIN_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DEFAULT_POLICY_PATH = resolve(PLUGIN_ROOT, "assets", "router", "trigger-policy.json");

const EXACT_SKILL_RE = /(?<![\w-])\$(loop-engineering|status|release|knowledge-evolution)\b/iu;
const LEGACY_COMMAND_NAMES = ["init", "run", "review", "learn", "superworkflows"] as const;
const LEGACY_EXACT_RE = new RegExp(`(?<![\\w-])\\$(?:${LEGACY_COMMAND_NAMES.join("|")})\\b`, "iu");

type SkillName = "loop-engineering" | "status" | "release" | "knowledge-evolution";
type PhysicalAction = "forbidden" | "requires_authorization";

export interface TriggerInput {
  prompt: string;
  policyPath?: string;
}

export interface TriggerDecision {
  match: "exact" | "implicit" | "none";
  skill: SkillName | null;
  decision: string;
  persistence: "persistent" | "session-only" | "none" | "readiness-only" | "proposal-only" | "response-only";
  authority:
    | "read-only"
    | "repository-write"
    | "readiness-only"
    | "readiness_or_authorized"
    | "proposal-only"
    | "blocked";
  physical_action: PhysicalAction;
}

interface TriggerPolicy {
  exact: Readonly<Record<string, string>>;
  implicit: Readonly<Record<string, string>>;
  signals: Readonly<Record<string, readonly string[]>>;
  external_patterns: readonly { name: string; regex: string }[];
}

async function loadPolicy(path: string): Promise<TriggerPolicy> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new UsageError("Unable to load trigger policy.", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError("Trigger policy must be an object.", { path });
  }
  const record = raw as Record<string, unknown>;
  if (record.exact === undefined || record.implicit === undefined) {
    throw new UsageError("Trigger policy requires exact and implicit maps.", { path });
  }
  const signals = (record.signals ?? {}) as Record<string, readonly string[]>;
  const externalPatterns = Array.isArray(record.external_patterns)
    ? record.external_patterns as { name: string; regex: string }[]
    : [];
  return {
    exact: record.exact as Readonly<Record<string, string>>,
    implicit: record.implicit as Readonly<Record<string, string>>,
    signals,
    external_patterns: externalPatterns,
  };
}

function normalize(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/gu, " ").trim();
}

function hits(text: string, phrases: readonly string[] | undefined): string[] {
  if (phrases === undefined) return [];
  return phrases.filter((phrase) => text.includes(phrase.toLowerCase())).sort();
}

function patternHits(text: string, patterns: readonly { name: string; regex: string }[]): string[] {
  const matched: string[] = [];
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern.regex, "iu").test(text)) {
        matched.push(`pattern:${pattern.name}`);
      }
    } catch {
      // Ignore invalid patterns; policy validation belongs to packaging gates.
    }
  }
  return matched.sort();
}

function hasExternal(text: string, policy: TriggerPolicy): boolean {
  const signalHits = hits(text, policy.signals.external);
  const patterns = patternHits(text, policy.external_patterns);
  return signalHits.length > 0 || patterns.length > 0;
}

function decisionForExact(skill: SkillName, decision: string, external: boolean): TriggerDecision {
  switch (skill) {
    case "loop-engineering":
      return {
        match: "exact",
        skill,
        decision,
        persistence: "persistent",
        authority: "repository-write",
        physical_action: external ? "requires_authorization" : "forbidden",
      };
    case "status":
      return {
        match: "exact",
        skill,
        decision,
        persistence: "session-only",
        authority: "read-only",
        physical_action: external ? "requires_authorization" : "forbidden",
      };
    case "release":
      return {
        match: "exact",
        skill,
        decision,
        persistence: "readiness-only",
        authority: external ? "readiness_or_authorized" : "readiness-only",
        physical_action: external ? "requires_authorization" : "forbidden",
      };
    case "knowledge-evolution":
      return {
        match: "exact",
        skill,
        decision,
        persistence: "proposal-only",
        authority: "proposal-only",
        physical_action: external ? "requires_authorization" : "forbidden",
      };
  }
}

function decisionForImplicit(
  intent: "complex_implementation" | "status" | "release" | "knowledge" | "review",
  decision: string,
  external: boolean,
): TriggerDecision {
  if (external) {
    return {
      match: "implicit",
      skill: "release",
      decision: "READINESS_ONLY",
      persistence: "readiness-only",
      authority: "blocked",
      physical_action: "requires_authorization",
    };
  }
  switch (intent) {
    case "complex_implementation":
      return {
        match: "implicit",
        skill: "loop-engineering",
        decision,
        persistence: "session-only",
        authority: "repository-write",
        physical_action: "forbidden",
      };
    case "status":
      return {
        match: "implicit",
        skill: "status",
        decision,
        persistence: "session-only",
        authority: "read-only",
        physical_action: "forbidden",
      };
    case "release":
      return {
        match: "implicit",
        skill: "release",
        decision,
        persistence: "readiness-only",
        authority: "readiness-only",
        physical_action: "forbidden",
      };
    case "knowledge":
      return {
        match: "implicit",
        skill: "knowledge-evolution",
        decision,
        persistence: "response-only",
        authority: "read-only",
        physical_action: "forbidden",
      };
    case "review":
      return {
        match: "implicit",
        skill: "loop-engineering",
        decision,
        persistence: "session-only",
        authority: "read-only",
        physical_action: "forbidden",
      };
  }
}

type ImplicitIntent = "complex_implementation" | "status" | "release" | "knowledge" | "review";

function selectImplicitIntent(text: string, policy: TriggerPolicy): ImplicitIntent | null {
  const order: readonly ImplicitIntent[] = [
    "status",
    "knowledge",
    "release",
    "complex_implementation",
    "review",
  ];
  for (const intent of order) {
    if (hits(text, policy.signals[intent]).length > 0) {
      return intent;
    }
  }
  return null;
}

export async function classifyTrigger(input: TriggerInput): Promise<TriggerDecision> {
  const prompt = input.prompt;
  if (prompt.trim() === "") {
    throw new UsageError("Prompt must not be empty.");
  }
  const policy = await loadPolicy(input.policyPath ?? DEFAULT_POLICY_PATH);
  const text = normalize(prompt);
  const external = hasExternal(text, policy);

  const exactMatch = EXACT_SKILL_RE.exec(prompt);
  if (exactMatch?.[1] !== undefined) {
    const skill = exactMatch[1].toLowerCase() as SkillName;
    const key = `$${skill}`;
    const decision = policy.exact[key];
    if (decision === undefined) {
      return {
        match: "none",
        skill: null,
        decision: "UNKNOWN",
        persistence: "none",
        authority: "read-only",
        physical_action: "forbidden",
      };
    }
    return decisionForExact(skill, decision, external);
  }

  if (LEGACY_EXACT_RE.test(prompt)) {
    return {
      match: "none",
      skill: null,
      decision: "UNKNOWN",
      persistence: "none",
      authority: "read-only",
      physical_action: "forbidden",
    };
  }

  if (external) {
    return decisionForImplicit("release", policy.implicit.release ?? "READINESS_ONLY", true);
  }

  const intent = selectImplicitIntent(text, policy);
  if (intent === null) {
    return {
      match: "none",
      skill: null,
      decision: "UNKNOWN",
      persistence: "none",
      authority: "read-only",
      physical_action: "forbidden",
    };
  }
  const decision = policy.implicit[intent];
  if (decision === undefined) {
    return {
      match: "none",
      skill: null,
      decision: "UNKNOWN",
      persistence: "none",
      authority: "read-only",
      physical_action: "forbidden",
    };
  }
  return decisionForImplicit(intent, decision, false);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseArguments(argv: readonly string[]): { command: string; options: Record<string, string> } {
  if (argv.length === 0) throw new UsageError("A subcommand is required.");
  const [command, ...rest] = argv;
  if (command !== "classify") {
    throw new UsageError("Unknown subcommand.", { command });
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      throw new UsageError("Positional arguments are not supported.", { token });
    }
    const key = token.slice(2);
    if (key !== "prompt" && key !== "policy") {
      throw new UsageError("Unknown option.", { command, option: key });
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError("Option requires a value.", { option: key });
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    let prompt = parsed.options.prompt;
    if (prompt === undefined) {
      prompt = await readStdin();
    }
    const input: TriggerInput = { prompt };
    if (parsed.options.policy !== undefined) {
      input.policyPath = parsed.options.policy;
    }
    const output = await classifyTrigger(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${JSON.stringify({
        error: { code: "USAGE", message: error.message, details: error.details },
      })}\n`);
      return USAGE_EXIT_CODE;
    }
    process.stderr.write(`${JSON.stringify({
      error: {
        code: "UNEXPECTED",
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    })}\n`);
    return UNKNOWN_EXIT_CODE;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
