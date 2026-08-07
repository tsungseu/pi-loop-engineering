import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  LoopError,
} from "../contracts/domain.js";
import type { ReleaseAction, ScopedAuthorization } from "../contracts/release.js";
import { parseLoopId } from "../core/paths.js";
import {
  checkReadiness,
  performReleaseAction,
  reconcileOperation,
} from "../core/release.js";

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

const COMMAND_OPTIONS: Readonly<Record<string, { required: readonly string[]; optional: readonly string[] }>> = {
  readiness: { required: ["workspace", "loop-id"], optional: [] },
  action: {
    required: ["workspace", "loop-id", "action", "target", "authorization"],
    optional: ["release-id", "branch", "environment-node"],
  },
  reconcile: { required: ["workspace", "release-id", "operation-id"], optional: [] },
};

interface ParsedCommand {
  command: string;
  options: Readonly<Record<string, string>>;
}

function parseArguments(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0) throw new UsageError("A subcommand is required.");
  const [command, ...rest] = argv;
  if (command === undefined || !Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new UsageError("Unknown subcommand.", { command });
  }
  const spec = COMMAND_OPTIONS[command]!;
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      throw new UsageError("Positional arguments are not supported.", { token });
    }
    const key = token.slice(2);
    const allowed = new Set([...spec.required, ...spec.optional]);
    if (!allowed.has(key)) {
      throw new UsageError("Unknown option.", { command, option: key });
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError("Option requires a value.", { option: key });
    }
    options[key] = value;
    index += 1;
  }
  for (const key of spec.required) {
    if (options[key] === undefined) {
      throw new UsageError("Missing required option.", { command, option: key });
    }
  }
  return { command, options };
}

function requireOption(options: Readonly<Record<string, string>>, key: string): string {
  const value = options[key];
  if (value === undefined) throw new UsageError("Missing required option.", { option: key });
  return value;
}

const RELEASE_ACTIONS = new Set<ReleaseAction>([
  "commit", "push", "pr", "tag", "publish", "deploy-sim", "run-hil", "deploy-robot", "run-real-robot",
]);

function parseAction(value: string): ReleaseAction {
  if (!RELEASE_ACTIONS.has(value as ReleaseAction)) {
    throw new UsageError("Unsupported Release action.", { action: value });
  }
  return value as ReleaseAction;
}

async function loadAuthorization(path: string): Promise<ScopedAuthorization> {
  const raw = JSON.parse(await readFile(path, "utf8")) as ScopedAuthorization;
  if (
    typeof raw.authorization_id !== "string"
    || typeof raw.action !== "string"
    || typeof raw.target !== "string"
    || typeof raw.authorized_by !== "string"
    || typeof raw.expires_at !== "string"
    || typeof raw.digest !== "string"
  ) {
    throw new LoopError("SCHEMA_INVALID", "Authorization JSON is incomplete.");
  }
  return raw;
}

async function run(parsed: ParsedCommand): Promise<unknown> {
  const { command, options } = parsed;
  switch (command) {
    case "readiness": {
      const workspace = requireOption(options, "workspace");
      const loopId = parseLoopId(requireOption(options, "loop-id"));
      return checkReadiness({ workspace, loopId });
    }
    case "action": {
      const workspace = requireOption(options, "workspace");
      const loopId = parseLoopId(requireOption(options, "loop-id"));
      const action = parseAction(requireOption(options, "action"));
      const target = requireOption(options, "target");
      const authorization = await loadAuthorization(requireOption(options, "authorization"));
      const request: Parameters<typeof performReleaseAction>[0] = {
        workspace,
        loopId,
        action,
        target,
        authorization,
      };
      if (options["release-id"] !== undefined) request.releaseId = options["release-id"];
      if (options.branch !== undefined) request.branch = options.branch;
      const environmentNode = options["environment-node"];
      if (
        environmentNode === "HIL"
        || environmentNode === "BENCH"
        || environmentNode === "CLOSED_COURSE"
        || environmentNode === "REAL_VEHICLE_ROBOT"
      ) {
        request.environmentNode = environmentNode;
      }
      return performReleaseAction(request);
    }
    case "reconcile": {
      const workspace = requireOption(options, "workspace");
      const releaseId = requireOption(options, "release-id");
      const operationId = requireOption(options, "operation-id");
      return reconcileOperation({ workspace, releaseId, operationId });
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
