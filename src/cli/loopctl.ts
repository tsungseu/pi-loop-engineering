import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOOP_PHASES,
  LOOP_STATUSES,
  LoopError,
  sha256Hex,
  type Digest,
  type LoopId,
  type LoopPhase,
  type LoopStatus,
  type MarkdownLanguage,
} from "../contracts/domain.js";
import type { H0Harness } from "../contracts/harness.js";
import { atomicWriteFile, atomicWriteJson, canonicalJsonBytes } from "../core/atomic-json.js";
import { forgeH0, type HarnessDrift } from "../core/harness.js";
import { openLedger, type LoopSnapshot, type RecoveryReport } from "../core/ledger.js";
import { renderLoopMarkdown, resolveMarkdownLanguage, type LoopNarrativeFacts } from "../core/markdown.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../core/paths.js";
import { validateSchema } from "../core/schema.js";

// ---------------------------------------------------------------------------
// Public request/report contracts
// ---------------------------------------------------------------------------

export interface BootstrapRequest {
  workspace: string;
  task: string;
  markdownLanguage?: MarkdownLanguage;
}

export interface ResumeRequest {
  workspace: string;
  loopId: LoopId;
}

export interface StatusRequest {
  workspace: string;
  loopId?: LoopId;
  displayLanguage?: MarkdownLanguage;
}

export interface StatusReport {
  candidates: readonly LoopId[];
  selected: LoopSnapshot | null;
  harness: { revision: number | null; digest: Digest | null; drift: HarnessDrift };
  openFindings: readonly string[];
  staleEvidence: readonly string[];
  activeLeases: readonly string[];
  nextActions: readonly string[];
}

// ---------------------------------------------------------------------------
// Errors and exit codes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Argument parsing (rejects unknown options before any writes)
// ---------------------------------------------------------------------------

const COMMAND_OPTIONS: Readonly<Record<string, { required: readonly string[]; optional: readonly string[] }>> = {
  start: { required: ["workspace", "task"], optional: ["markdown-language"] },
  resume: { required: ["workspace", "loop-id"], optional: [] },
  transition: { required: ["workspace", "loop-id", "to"], optional: ["status"] },
  "set-markdown-language": { required: ["workspace", "loop-id", "language"], optional: [] },
  checkpoint: { required: ["workspace", "loop-id", "reason"], optional: [] },
  status: { required: ["workspace"], optional: ["loop-id", "display-language"] },
  reconcile: { required: ["workspace", "loop-id"], optional: [] },
};

interface ParsedCommand {
  command: string;
  options: Readonly<Record<string, string>>;
}

function parseArguments(argv: readonly string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw new UsageError("A subcommand is required.", { commands: Object.keys(COMMAND_OPTIONS).sort() });
  }
  const specification = COMMAND_OPTIONS[command];
  if (specification === undefined) {
    throw new UsageError("Unknown subcommand.", { command, commands: Object.keys(COMMAND_OPTIONS).sort() });
  }
  const allowed = new Set([...specification.required, ...specification.optional]);
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      throw new UsageError("Positional arguments are not accepted.", { command, token });
    }
    const key = token.slice(2);
    if (!allowed.has(key)) {
      throw new UsageError("Unknown option.", { command, option: token, allowed: [...allowed].sort() });
    }
    if (Object.hasOwn(options, key)) {
      throw new UsageError("Duplicate option.", { command, option: token });
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError("Option requires a value.", { command, option: token });
    }
    options[key] = value;
    index += 1;
  }
  for (const key of specification.required) {
    if (!Object.hasOwn(options, key)) {
      throw new UsageError("Missing required option.", { command, option: `--${key}` });
    }
  }
  return { command, options };
}

function requireOption(options: Readonly<Record<string, string>>, key: string): string {
  const value = options[key];
  if (value === undefined) throw new UsageError("Missing required option.", { option: `--${key}` });
  return value;
}

function parseLanguage(value: string): MarkdownLanguage {
  if (value !== "en-US" && value !== "zh-CN") {
    throw new LoopError("INVALID_MARKDOWN_LANGUAGE", "Supported Markdown languages are en-US and zh-CN.", { value });
  }
  return value;
}

function parsePhase(value: string): LoopPhase {
  if (!(LOOP_PHASES as readonly string[]).includes(value)) {
    throw new UsageError("Unknown target phase.", { value, phases: LOOP_PHASES });
  }
  return value as LoopPhase;
}

function parseStatus(value: string): LoopStatus {
  if (!(LOOP_STATUSES as readonly string[]).includes(value)) {
    throw new UsageError("Unknown target status.", { value, statuses: LOOP_STATUSES });
  }
  return value as LoopStatus;
}

// ---------------------------------------------------------------------------
// Repository identity and Loop identifier derivation
// ---------------------------------------------------------------------------

interface RepositoryIdentity {
  repositoryRoot: string;
  repositoryId: string;
  repositoryRulesDigest: Digest;
}

async function deriveRepositoryIdentity(workspace: string): Promise<RepositoryIdentity> {
  const repositoryRoot = await realpath(resolve(workspace));
  const repositoryId = sha256Hex(Buffer.from(`pai-loop/repository/v1\0${repositoryRoot}`, "utf8"));
  const repositoryRulesDigest = sha256Hex(canonicalJsonBytes({ repository_id: repositoryId }));
  return { repositoryRoot, repositoryId, repositoryRulesDigest };
}

function generateLoopId(): LoopId {
  const stamp = new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14);
  return parseLoopId(`loop-${stamp}-${randomBytes(5).toString("hex")}`);
}

// ---------------------------------------------------------------------------
// Loop narrative sidecar (raw, CLI-owned; never through the English machine gate)
// ---------------------------------------------------------------------------

interface Narrative {
  task: string;
  journey: readonly string[];
}

function narrativePath(layout: LoopLayout): string {
  return join(layout.loopRoot, "narrative.json");
}

async function readNarrative(layout: LoopLayout): Promise<Narrative> {
  try {
    const value = JSON.parse(await readFile(narrativePath(layout), "utf8")) as Partial<Narrative>;
    return {
      task: typeof value.task === "string" ? value.task : "",
      journey: Array.isArray(value.journey) ? value.journey.filter((entry): entry is string => typeof entry === "string") : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { task: "", journey: [] };
    throw error;
  }
}

async function writeNarrative(layout: LoopLayout, narrative: Narrative): Promise<void> {
  await atomicWriteFile(narrativePath(layout), new TextEncoder().encode(JSON.stringify(narrative)));
}

async function renderLoopFile(layout: LoopLayout, snapshot: LoopSnapshot, narrative: Narrative): Promise<void> {
  const facts: LoopNarrativeFacts = {
    loopId: snapshot.loop_id,
    phase: snapshot.phase,
    status: snapshot.status,
    problemAndContract: narrative.task === "" ? [] : [narrative.task],
    designAndSafetyInvariants: [],
    outOfScope: [],
    tasks: narrative.task === "" ? [] : [narrative.task],
    report: [],
    verification: [],
    reviewAndResidualRisk: [],
    journeyLog: narrative.journey,
    evidenceDigests: [],
    manifests: [],
  };
  const markdown = renderLoopMarkdown(facts, snapshot.markdown_language);
  await atomicWriteFile(layout.loopMarkdown, new TextEncoder().encode(markdown));
}

// ---------------------------------------------------------------------------
// Legacy state and terminal-status guards
// ---------------------------------------------------------------------------

function assertNoLegacyRuns(workspace: string): void {
  if (existsSync(join(resolve(workspace), ".ai", "runs"))) {
    throw new LoopError("RECONCILE_REQUIRED", "Legacy v1 .ai/runs state cannot be resumed by the v0.3 runtime.", {
      workspace: resolve(workspace),
    });
  }
}

function assertResumable(snapshot: LoopSnapshot): void {
  if (snapshot.status === "COMPLETE") {
    throw new LoopError("INVALID_TRANSITION", "A complete Loop cannot be resumed.", { status: snapshot.status });
  }
  if (snapshot.status === "CANCELLED" || snapshot.phase === "CANCELLED") {
    throw new LoopError("INVALID_TRANSITION", "A cancelled Loop cannot be resumed.", { phase: snapshot.phase });
  }
  if (snapshot.phase === "HANDOFF_READY") {
    throw new LoopError("INVALID_TRANSITION", "A handed-off Loop cannot be resumed.", { phase: snapshot.phase });
  }
  if (snapshot.status === "NON_CONVERGENT") {
    throw new LoopError("NON_CONVERGENT", "A non-convergent Loop cannot be resumed; create a Child Loop.", {
      phase: snapshot.phase,
    });
  }
}

async function readH0(layout: LoopLayout): Promise<H0Harness> {
  const path = join(layout.harnessRoot, "h0-discovery.json");
  try {
    return validateSchema<H0Harness>("harness", JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LoopError("HARNESS_REQUIRED", "The Loop has no discovery Harness and cannot be resumed.", { path });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// start / bootstrap
// ---------------------------------------------------------------------------

export async function bootstrapLoop(request: BootstrapRequest): Promise<LoopSnapshot> {
  if (request.task.trim() === "") {
    throw new LoopError("SCHEMA_INVALID", "A start task description is required.");
  }
  const language = await resolveMarkdownLanguage(
    request.markdownLanguage === undefined
      ? { workspace: request.workspace }
      : { workspace: request.workspace, explicit: request.markdownLanguage },
  );
  const identity = await deriveRepositoryIdentity(request.workspace);
  const loopId = generateLoopId();
  const layout = resolveLayout(request.workspace, loopId);
  const ledger = await openLedger(layout);

  await ledger.transact("BOOTSTRAP", await ledger.cursor(), async () => {
    const h0 = await forgeH0({
      loopId,
      repositoryId: identity.repositoryId,
      repositoryRoot: identity.repositoryRoot,
      readablePaths: ["**"],
      repositoryRulesDigest: identity.repositoryRulesDigest,
      exploreCapabilities: ["native-search"],
      networkClass: "DISABLED",
    });
    await atomicWriteJson(join(layout.harnessRoot, "h0-discovery.json"), h0);
    return h0;
  });

  if (language !== "en-US") {
    await ledger.setMarkdownLanguage(language, await ledger.cursor());
  }
  const snapshot = await ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor());

  const narrative: Narrative = { task: request.task, journey: ["Bootstrapped the Loop to ORIENTING."] };
  await writeNarrative(layout, narrative);
  await renderLoopFile(layout, snapshot, narrative);
  return snapshot;
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

export async function resumeLoop(request: ResumeRequest): Promise<LoopSnapshot> {
  assertNoLegacyRuns(request.workspace);
  const layout = resolveLayout(request.workspace, request.loopId);
  if (!existsSync(layout.loopJson)) {
    throw new LoopError("RECONCILE_REQUIRED", "The requested Loop does not exist in the workspace.", {
      loop_id: request.loopId,
    });
  }
  const ledger = await openLedger(layout);
  await ledger.cursor();
  const snapshot = await ledger.snapshot();
  assertResumable(snapshot);

  const h0 = await readH0(layout);
  const identity = await deriveRepositoryIdentity(request.workspace);
  if (h0.repository_id !== identity.repositoryId) {
    throw new LoopError("RECONCILE_REQUIRED", "The Loop belongs to a different repository identity.", {
      expected_repository_id: h0.repository_id,
      actual_repository_id: identity.repositoryId,
    });
  }
  if (h0.loop_id !== request.loopId) {
    throw new LoopError("RECONCILE_REQUIRED", "The discovery Harness lineage does not match the Loop identifier.", {
      harness_loop_id: h0.loop_id,
      loop_id: request.loopId,
    });
  }
  if (snapshot.parent_loop_id !== null) {
    const parent = resolveLayout(request.workspace, snapshot.parent_loop_id);
    if (!existsSync(parent.loopJson)) {
      throw new LoopError("RECONCILE_REQUIRED", "The parent Loop in the lineage is missing.", {
        parent_loop_id: snapshot.parent_loop_id,
      });
    }
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

async function transitionLoop(
  workspace: string,
  loopId: LoopId,
  to: LoopPhase,
  status: LoopStatus,
): Promise<LoopSnapshot> {
  const layout = resolveLayout(workspace, loopId);
  if (!existsSync(layout.loopJson)) {
    throw new LoopError("RECONCILE_REQUIRED", "The requested Loop does not exist in the workspace.", { loop_id: loopId });
  }
  const ledger = await openLedger(layout);
  const snapshot = await ledger.transition(to, status, await ledger.cursor());
  const narrative = await readNarrative(layout);
  const updated: Narrative = {
    task: narrative.task,
    journey: [...narrative.journey, `Transitioned to ${to} (${status}).`],
  };
  await writeNarrative(layout, updated);
  await renderLoopFile(layout, snapshot, updated);
  return snapshot;
}

// ---------------------------------------------------------------------------
// set-markdown-language
// ---------------------------------------------------------------------------

async function setMarkdownLanguage(
  workspace: string,
  loopId: LoopId,
  language: MarkdownLanguage,
): Promise<LoopSnapshot> {
  const layout = resolveLayout(workspace, loopId);
  if (!existsSync(layout.loopJson)) {
    throw new LoopError("RECONCILE_REQUIRED", "The requested Loop does not exist in the workspace.", { loop_id: loopId });
  }
  const ledger = await openLedger(layout);
  const snapshot = await ledger.setMarkdownLanguage(language, await ledger.cursor());
  const narrative = await readNarrative(layout);
  const updated: Narrative = {
    task: narrative.task,
    journey: [...narrative.journey, `MARKDOWN_LANGUAGE_CHANGED to ${language}.`],
  };
  await writeNarrative(layout, updated);
  await renderLoopFile(layout, snapshot, updated);
  return snapshot;
}

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

interface Checkpoint {
  schema_version: 1;
  loop_id: LoopId;
  sequence: number;
  phase: LoopPhase;
  status: LoopStatus;
  source_head_sha: string;
  completed_work_item_ids: readonly string[];
  evidence_ids: readonly string[];
  blocker: string | null;
  resume_entry: string;
  digest: Digest;
}

async function checkpointLoop(workspace: string, loopId: LoopId, reason: string): Promise<LoopSnapshot> {
  if (reason.trim() === "") {
    throw new LoopError("SCHEMA_INVALID", "A checkpoint reason is required.");
  }
  const layout = resolveLayout(workspace, loopId);
  if (!existsSync(layout.loopJson)) {
    throw new LoopError("RECONCILE_REQUIRED", "The requested Loop does not exist in the workspace.", { loop_id: loopId });
  }
  const ledger = await openLedger(layout);
  const snapshot = await ledger.snapshot();
  const committed = await ledger.transact("CHECKPOINT", await ledger.cursor(), async () => {
    const content = {
      schema_version: 1 as const,
      loop_id: loopId,
      sequence: Math.max(1, snapshot.last_event_sequence),
      phase: snapshot.phase,
      status: snapshot.status,
      source_head_sha: sha256Hex(canonicalJsonBytes({
        loop_id: loopId,
        phase: snapshot.phase,
        sequence: snapshot.last_event_sequence,
      })),
      completed_work_item_ids: [],
      evidence_ids: [],
      blocker: null,
      resume_entry: reason,
    };
    const checkpoint: Checkpoint = { ...content, digest: sha256Hex(canonicalJsonBytes(content)) };
    return validateSchema<Checkpoint>("checkpoint", checkpoint);
  });
  return committed.snapshot;
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

async function reconcileLoop(workspace: string, loopId: LoopId): Promise<RecoveryReport> {
  const layout = resolveLayout(workspace, loopId);
  if (!existsSync(layout.loopJson)) {
    throw new LoopError("RECONCILE_REQUIRED", "The requested Loop does not exist in the workspace.", {
      loop_id: loopId,
    });
  }
  const ledger = await openLedger(layout);
  return ledger.recover();
}

// ---------------------------------------------------------------------------
// status (strictly read-only)
// ---------------------------------------------------------------------------

async function listCandidates(loopsRoot: string): Promise<LoopId[]> {
  let entries;
  try {
    entries = await readdir(loopsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates: LoopId[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      candidates.push(parseLoopId(entry.name));
    } catch {
      // Ignore directories that are not valid Loop identifiers.
    }
  }
  return candidates.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

let workflowTransitionsCache: Readonly<Record<string, readonly string[]>> | undefined;

async function readWorkflowTransitions(): Promise<Readonly<Record<string, readonly string[]>>> {
  if (workflowTransitionsCache !== undefined) return workflowTransitionsCache;
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../assets/loop-engineering/workflow-spec.json"),
    resolve(moduleDirectory, "../../../assets/loop-engineering/workflow-spec.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { transitions?: Record<string, readonly string[]> };
      workflowTransitionsCache = parsed.transitions ?? {};
      return workflowTransitionsCache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  workflowTransitionsCache = {};
  return workflowTransitionsCache;
}

async function legalNextActions(snapshot: LoopSnapshot, language: MarkdownLanguage): Promise<string[]> {
  const transitions = await readWorkflowTransitions();
  const targets = transitions[snapshot.phase] ?? [];
  return targets.map((target) =>
    language === "zh-CN" ? `转换到 ${target}` : `Transition to ${target}`,
  );
}

export async function inspectLoops(request: StatusRequest): Promise<StatusReport> {
  const displayLanguage = request.displayLanguage ?? "en-US";
  const workspaceLayout = resolveLayout(request.workspace);
  const candidates = await listCandidates(workspaceLayout.loopsRoot);

  if (request.loopId === undefined) {
    return {
      candidates,
      selected: null,
      harness: { revision: null, digest: null, drift: { kind: "NONE" } },
      openFindings: [],
      staleEvidence: [],
      activeLeases: [],
      nextActions: [],
    };
  }

  const layout = resolveLayout(request.workspace, request.loopId);
  if (!existsSync(layout.loopJson)) {
    throw new LoopError("RECONCILE_REQUIRED", "The requested Loop does not exist in the workspace.", {
      loop_id: request.loopId,
    });
  }
  const selected = validateSchema<LoopSnapshot>("loop", JSON.parse(await readFile(layout.loopJson, "utf8")));
  const activeLeases = existsSync(`${layout.loopRoot}.lock`) ? [request.loopId] : [];
  return {
    candidates,
    selected,
    harness: {
      revision: selected.current_harness_revision,
      digest: selected.current_harness_digest,
      drift: { kind: "NONE" },
    },
    openFindings: [],
    staleEvidence: [],
    activeLeases,
    nextActions: await legalNextActions(selected, displayLanguage),
  };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function run(parsed: ParsedCommand): Promise<unknown> {
  const { command, options } = parsed;
  const workspace = requireOption(options, "workspace");
  switch (command) {
    case "start": {
      const markdownLanguage = options["markdown-language"];
      return bootstrapLoop({
        workspace,
        task: requireOption(options, "task"),
        ...(markdownLanguage === undefined ? {} : { markdownLanguage: parseLanguage(markdownLanguage) }),
      });
    }
    case "resume":
      return resumeLoop({ workspace, loopId: parseLoopId(requireOption(options, "loop-id")) });
    case "transition": {
      const statusOption = options.status;
      return transitionLoop(
        workspace,
        parseLoopId(requireOption(options, "loop-id")),
        parsePhase(requireOption(options, "to")),
        statusOption === undefined ? "ACTIVE" : parseStatus(statusOption),
      );
    }
    case "set-markdown-language":
      return setMarkdownLanguage(
        workspace,
        parseLoopId(requireOption(options, "loop-id")),
        parseLanguage(requireOption(options, "language")),
      );
    case "checkpoint":
      return checkpointLoop(workspace, parseLoopId(requireOption(options, "loop-id")), requireOption(options, "reason"));
    case "reconcile":
      return reconcileLoop(workspace, parseLoopId(requireOption(options, "loop-id")));
    case "status": {
      const loopIdOption = options["loop-id"];
      const displayLanguageOption = options["display-language"];
      return inspectLoops({
        workspace,
        ...(loopIdOption === undefined ? {} : { loopId: parseLoopId(loopIdOption) }),
        ...(displayLanguageOption === undefined ? {} : { displayLanguage: parseLanguage(displayLanguageOption) }),
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
