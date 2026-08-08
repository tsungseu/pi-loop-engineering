import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { LoopError, type LoopId, type MarkdownLanguage } from "../contracts/domain.js";
import type { KnowledgeProposalStatus } from "../contracts/release.js";
import {
  buildProposal,
  collectKnowledgeSources,
  defaultProposalReview,
  markProposalApplied,
  transitionProposal,
  type ProposalReview,
} from "../core/knowledge.js";
import { parseLoopId } from "../core/paths.js";

class UsageError extends Error {
  constructor(message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE_EXIT_CODE = 2;
const UNKNOWN_EXIT_CODE = 1;
const LOOP_ERROR_EXIT_CODES: Readonly<Record<string, number>> = {
  INVALID_LOOP_ID: 3,
  INVALID_MARKDOWN_LANGUAGE: 4,
  SCHEMA_INVALID: 5,
  LOCK_BUSY: 6,
  RECONCILE_REQUIRED: 7,
  CAS_MISMATCH: 8,
  INVALID_TRANSITION: 9,
  HARNESS_REQUIRED: 10,
  HARNESS_DRIFT: 11,
  DISPATCH_REJECTED: 12,
  STALE_AGENT_RESULT: 13,
  STALE_HANDOFF: 14,
  AUTHORIZATION_REQUIRED: 15,
  NON_CONVERGENT: 16,
};

const PROPOSAL_STATUSES = new Set<KnowledgeProposalStatus>([
  "PROVISIONAL",
  "REVIEW_PENDING",
  "REVISE",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
  "APPLIED",
]);

interface ErrorEnvelope {
  code: string;
  message: string;
  details: Readonly<Record<string, unknown>>;
  exitCode: number;
}

function classifyError(error: unknown): ErrorEnvelope {
  if (error instanceof UsageError) {
    return { code: "USAGE", message: error.message, details: error.details, exitCode: USAGE_EXIT_CODE };
  }
  if (error instanceof LoopError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      exitCode: LOOP_ERROR_EXIT_CODES[error.code] ?? UNKNOWN_EXIT_CODE,
    };
  }
  return {
    code: "UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
    details: {},
    exitCode: UNKNOWN_EXIT_CODE,
  };
}

interface ParsedCommand {
  command: string;
  options: Readonly<Record<string, string>>;
  loopIds: readonly string[];
}

function parseArguments(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0) throw new UsageError("A subcommand is required.");
  const [command, ...rest] = argv;
  if (command !== "propose" && command !== "transition" && command !== "mark-applied") {
    throw new UsageError("Unknown subcommand.", { command });
  }

  const options: Record<string, string> = {};
  const loopIds: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      throw new UsageError("Positional arguments are not supported.", { token });
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError("Option requires a value.", { option: key });
    }
    if (key === "loop-id") {
      loopIds.push(value);
    } else {
      if (options[key] !== undefined) {
        throw new UsageError("Option was provided more than once.", { option: key });
      }
      options[key] = value;
    }
    index += 1;
  }

  if (command === "propose") {
    if (options.workspace === undefined) throw new UsageError("Missing required option.", { option: "workspace" });
    if (loopIds.length === 0) throw new UsageError("Missing required option.", { option: "loop-id" });
    for (const key of Object.keys(options)) {
      if (key !== "workspace" && key !== "markdown-language") {
        throw new UsageError("Unknown option.", { command, option: key });
      }
    }
  } else if (command === "transition") {
    for (const key of ["workspace", "proposal-id", "to", "review"] as const) {
      if (options[key] === undefined) throw new UsageError("Missing required option.", { option: key });
    }
    for (const key of Object.keys(options)) {
      if (!["workspace", "proposal-id", "to", "review"].includes(key)) {
        throw new UsageError("Unknown option.", { command, option: key });
      }
    }
    if (loopIds.length > 0) throw new UsageError("Unknown option.", { command, option: "loop-id" });
  } else {
    for (const key of ["workspace", "proposal-id", "implementation-loop-id"] as const) {
      if (options[key] === undefined) throw new UsageError("Missing required option.", { option: key });
    }
    for (const key of Object.keys(options)) {
      if (!["workspace", "proposal-id", "implementation-loop-id"].includes(key)) {
        throw new UsageError("Unknown option.", { command, option: key });
      }
    }
    if (loopIds.length > 0) throw new UsageError("Unknown option.", { command, option: "loop-id" });
  }

  return { command, options, loopIds };
}

function requireOption(options: Readonly<Record<string, string>>, key: string): string {
  const value = options[key];
  if (value === undefined) throw new UsageError("Missing required option.", { option: key });
  return value;
}

function parseStatus(value: string): KnowledgeProposalStatus {
  if (!PROPOSAL_STATUSES.has(value as KnowledgeProposalStatus)) {
    throw new UsageError("Unsupported Knowledge proposal status.", { status: value });
  }
  return value as KnowledgeProposalStatus;
}

async function loadReview(path: string): Promise<ProposalReview> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new LoopError("SCHEMA_INVALID", "Review JSON could not be read.", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LoopError("SCHEMA_INVALID", "Review JSON must be an object.");
  }
  const record = raw as Readonly<Record<string, unknown>>;
  for (const key of [
    "privacy_review",
    "expected_benefit",
    "safety_impact",
    "offline_evaluation",
    "canary",
    "rollback",
    "review_date",
  ] as const) {
    if (record[key] === undefined) {
      throw new LoopError("SCHEMA_INVALID", "Review JSON is incomplete.", { missing: key });
    }
  }
  if (typeof record.privacy_review !== "string"
    || typeof record.expected_benefit !== "string"
    || typeof record.safety_impact !== "string"
    || typeof record.review_date !== "string"
    || !Array.isArray(record.offline_evaluation)
    || !Array.isArray(record.canary)
    || !Array.isArray(record.rollback)
  ) {
    throw new LoopError("SCHEMA_INVALID", "Review JSON field types are invalid.");
  }
  const review: ProposalReview = {
    privacy_review: record.privacy_review,
    expected_benefit: record.expected_benefit,
    safety_impact: record.safety_impact,
    offline_evaluation: record.offline_evaluation.map(String),
    canary: record.canary.map(String),
    rollback: record.rollback.map(String),
    review_date: record.review_date,
  };
  if (Array.isArray(record.counterexamples)) {
    review.counterexamples = record.counterexamples.map(String);
  }
  if (Array.isArray(record.correction_provenance)) {
    review.correction_provenance = record.correction_provenance.map(String);
  }
  if (typeof record.explicit_user_correction === "boolean") {
    review.explicit_user_correction = record.explicit_user_correction;
  }
  return review;
}

async function run(parsed: ParsedCommand): Promise<unknown> {
  const { command, options, loopIds } = parsed;
  switch (command) {
    case "propose": {
      const workspace = requireOption(options, "workspace");
      const parsedLoopIds = loopIds.map((value) => parseLoopId(value)) as LoopId[];
      const observations = await collectKnowledgeSources({ workspace, loopIds: parsedLoopIds });
      const defaults = defaultProposalReview();
      const language = options["markdown-language"] as MarkdownLanguage | undefined;
      return buildProposal({
        workspace,
        observations,
        proposal_type: "PROJECT_KNOWLEDGE",
        ...(language === undefined ? {} : { markdown_language: language }),
        privacy_review: defaults.privacy_review,
        expected_benefit: defaults.expected_benefit,
        safety_impact: defaults.safety_impact,
        offline_evaluation: defaults.offline_evaluation,
        canary: defaults.canary,
        rollback: defaults.rollback,
        review_date: defaults.review_date,
        ...(defaults.counterexamples === undefined ? {} : { counterexamples: defaults.counterexamples }),
      });
    }
    case "transition": {
      return transitionProposal({
        workspace: requireOption(options, "workspace"),
        proposalId: requireOption(options, "proposal-id"),
        to: parseStatus(requireOption(options, "to")),
        review: await loadReview(requireOption(options, "review")),
      });
    }
    case "mark-applied": {
      return markProposalApplied({
        workspace: requireOption(options, "workspace"),
        proposalId: requireOption(options, "proposal-id"),
        implementationLoopId: parseLoopId(requireOption(options, "implementation-loop-id")),
      });
    }
    default:
      throw new UsageError("Unknown subcommand.", { command });
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    const output = await run(parsed);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch (error) {
    const envelope = classifyError(error);
    process.stderr.write(`${JSON.stringify({
      error: { code: envelope.code, message: envelope.message, details: envelope.details },
    })}\n`);
    return envelope.exitCode;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
