import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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
import type { H0Harness, H1Harness } from "../contracts/harness.js";
import type { FinalHandoff, ReleaseAction, RollbackPlan } from "../contracts/release.js";
import { atomicWriteFile, atomicWriteJson, canonicalJsonBytes } from "../core/atomic-json.js";
import {
  acceptAgentResult,
  admitIntegration,
  reconcileDispatch,
  reserveDispatch,
  type DispatchReservation,
} from "../core/dispatch.js";
import { forgeH0, type HarnessDrift, type HarnessFacts } from "../core/harness.js";
import {
  createChildLoop,
  finalizeHandoff,
  observeHandoffFreshnessFacts,
  readHandoff,
  verifyHandoffFreshness,
  writeCheckpoint,
  type FinalizeInput,
} from "../core/handoff.js";
import { openLedger, type LoopSnapshot, type RecoveryReport } from "../core/ledger.js";
import { renderLoopMarkdown, resolveMarkdownLanguage, type LoopNarrativeFacts } from "../core/markdown.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../core/paths.js";
import {
  admitReviewer,
  aggregateVerdict,
  listFindings,
  readPersistedRisk,
  recordFindingUpdate,
  recordRisk,
  recordVerdict,
  requiredReviewGates,
  type FindingSummary,
  type ReviewGate,
  type RiskLevel,
  type VerdictInput,
} from "../core/review.js";
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
  reviewGates: readonly ReviewGate[];
  findingOwnership: readonly { findingId: string; status: string; updatedBy?: string; area: string }[];
  handoff: {
    digest: Digest | null;
    freshness: "ABSENT" | "FRESH" | "STALE" | "UNKNOWN";
  } | null;
  rollback: RollbackPlan | null;
  residualRisks: readonly string[];
  recommendedReleaseActions: readonly ReleaseAction[];
  releaseRequiredGates: readonly string[];
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
  "dispatch-reserve": { required: ["workspace", "request"], optional: [] },
  "dispatch-accept": { required: ["workspace", "request"], optional: [] },
  integrate: { required: ["workspace", "request"], optional: [] },
  "dispatch-reconcile": { required: ["workspace", "loop-id"], optional: [] },
  "review-admit": { required: ["workspace", "request"], optional: [] },
  "finding-update": { required: ["workspace", "request"], optional: [] },
  verdict: { required: ["workspace", "request"], optional: [] },
  finalize: { required: ["workspace", "request"], optional: [] },
  "child-loop": { required: ["workspace", "parent-loop-id", "reason", "task"], optional: [] },
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

/** True when a Loop has a snapshot and/or a non-empty WAL — not merely a guessed identifier. */
function hasLedgerEvidence(layout: LoopLayout): boolean {
  if (existsSync(layout.loopJson)) return true;
  try {
    return statSync(layout.eventsJsonl).size > 0;
  } catch {
    return false;
  }
}

function assertLedgerEvidence(layout: LoopLayout, loopId: LoopId): void {
  if (!hasLedgerEvidence(layout)) {
    throw new LoopError("RECONCILE_REQUIRED", "The requested Loop does not exist in the workspace.", {
      loop_id: loopId,
    });
  }
}

async function ensurePublicMarkdown(layout: LoopLayout, snapshot: LoopSnapshot): Promise<void> {
  if (existsSync(layout.loopMarkdown)) return;
  await renderLoopFile(layout, snapshot, await readNarrative(layout));
}

// ---------------------------------------------------------------------------
// Legacy state and terminal-status guards
// ---------------------------------------------------------------------------

function assertNoLegacyRuns(workspace: string): void {
  if (existsSync(join(resolve(workspace), ".ai", "runs"))) {
    throw new LoopError("RECONCILE_REQUIRED", "Legacy v1 run directories cannot be resumed by the v0.3 runtime; archive them and Bootstrap a new Loop.", {
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

  // Persist the public Markdown sidecar before ORIENTING so a crash after the
  // phase Commit still leaves LOOP.md; re-render after the transition for phase accuracy.
  const narrative: Narrative = { task: request.task, journey: ["Bootstrapped the Loop to ORIENTING."] };
  await writeNarrative(layout, narrative);
  await renderLoopFile(layout, await ledger.snapshot(), narrative);

  const snapshot = await ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor());
  await renderLoopFile(layout, snapshot, narrative);
  return snapshot;
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

export async function resumeLoop(request: ResumeRequest): Promise<LoopSnapshot> {
  assertNoLegacyRuns(request.workspace);
  const layout = resolveLayout(request.workspace, request.loopId);
  assertLedgerEvidence(layout, request.loopId);
  if (!existsSync(layout.loopJson) || !existsSync(layout.loopMarkdown)) {
    throw new LoopError("RECONCILE_REQUIRED", "The Loop snapshot or public Markdown sidecar requires reconcile before resume.", {
      loop_id: request.loopId,
      loop_json_present: existsSync(layout.loopJson),
      loop_markdown_present: existsSync(layout.loopMarkdown),
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
    if (!hasLedgerEvidence(parent)) {
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
  assertLedgerEvidence(layout, loopId);
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
  assertLedgerEvidence(layout, loopId);
  const ledger = await openLedger(layout);
  const before = await ledger.snapshot();
  const snapshot = await ledger.setMarkdownLanguage(language, await ledger.cursor());
  if (snapshot.last_event_sequence === before.last_event_sequence) {
    return snapshot;
  }
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

async function checkpointLoop(workspace: string, loopId: LoopId, reason: string): Promise<LoopSnapshot> {
  if (reason.trim() === "") {
    throw new LoopError("SCHEMA_INVALID", "A checkpoint reason is required.");
  }
  const layout = resolveLayout(workspace, loopId);
  assertLedgerEvidence(layout, loopId);
  const ledger = await openLedger(layout);
  const snapshot = await ledger.snapshot();
  await writeCheckpoint({
    workspace,
    loopId,
    sourceHeadSha: sha256Hex(canonicalJsonBytes({
      loop_id: loopId,
      phase: snapshot.phase,
      sequence: snapshot.last_event_sequence,
    })),
    completedWorkItemIds: [],
    evidenceIds: [],
    blocker: null,
    resumeEntry: reason,
  });
  return ledger.snapshot();
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

async function reconcileLoop(workspace: string, loopId: LoopId): Promise<RecoveryReport> {
  const layout = resolveLayout(workspace, loopId);
  assertLedgerEvidence(layout, loopId);
  const ledger = await openLedger(layout);
  const report = await ledger.recover();
  await ensurePublicMarkdown(layout, await ledger.snapshot());
  return report;
}

// ---------------------------------------------------------------------------
// dispatch-reserve / dispatch-accept / integrate / dispatch-reconcile
// ---------------------------------------------------------------------------

async function readRequestFile(path: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UsageError("Request file was not found.", { path });
    }
    throw new LoopError("SCHEMA_INVALID", "Request file is not valid JSON.", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LoopError("SCHEMA_INVALID", "Request file must contain a JSON object.", { path });
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new LoopError("SCHEMA_INVALID", `Request field ${key} must be a non-empty string.`, { key });
  }
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new LoopError("SCHEMA_INVALID", `Request field ${key} must be an array of non-empty strings.`, { key });
  }
  return value;
}

/** Omitted optional arrays stay undefined; present arrays (including empty) are validated. */
function optionalStringArrayField(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) {
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new LoopError("SCHEMA_INVALID", `Request field ${key} must be an array of non-empty strings.`, { key });
  }
  return value;
}

function readSetField(record: Record<string, unknown>): readonly string[] | "UNKNOWN" {
  const value = record.read_set;
  if (value === "UNKNOWN") return "UNKNOWN";
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new LoopError("SCHEMA_INVALID", "Request field read_set must be UNKNOWN or an array of paths.");
  }
  return value;
}

async function dispatchReserveCommand(workspace: string, requestPath: string): Promise<unknown> {
  const record = await readRequestFile(requestPath);
  const externalWriteRoots = optionalStringArrayField(record, "external_write_roots");
  const reservation: DispatchReservation = {
    workspace,
    loopId: parseLoopId(requireString(record, "loop_id")),
    workItemId: requireString(record, "work_item_id"),
    actorRole: requireString(record, "actor_role"),
    objective: requireString(record, "objective"),
    acceptance: optionalStringArray(record, "acceptance"),
    dependencies: optionalStringArray(record, "dependencies"),
    readSet: readSetField(record),
    writeSet: optionalStringArray(record, "write_set"),
    worktree: requireString(record, "worktree"),
    waveInputDigest: requireString(record, "wave_input_digest") as Digest,
    h1Digest: requireString(record, "h1_digest") as Digest,
    completedWorkItemIds: optionalStringArray(record, "completed_work_item_ids"),
    mode: record.mode === "session-only" ? "session-only" : "persistent",
    ...(externalWriteRoots === undefined ? {} : { externalWriteRoots }),
    ...(record.host_enforced_external_write === true ? { hostEnforcedExternalWrite: true } : {}),
  };
  return reserveDispatch(reservation);
}

async function dispatchAcceptCommand(workspace: string, requestPath: string): Promise<unknown> {
  const record = await readRequestFile(requestPath);
  const observed = optionalStringArrayField(record, "observed_write_set");
  const { observed_write_set: _observed, ...result } = record;
  return acceptAgentResult(observed === undefined
    ? { workspace, result }
    : { workspace, result, observedWriteSet: observed });
}

async function integrateCommand(workspace: string, requestPath: string): Promise<unknown> {
  const record = await readRequestFile(requestPath);
  return admitIntegration({
    workspace,
    loopId: parseLoopId(requireString(record, "loop_id")),
    bundleDigest: requireString(record, "bundle_digest") as Digest,
  });
}

async function dispatchReconcileCommand(workspace: string, loopId: LoopId): Promise<unknown> {
  const layout = resolveLayout(workspace, loopId);
  assertLedgerEvidence(layout, loopId);
  return reconcileDispatch(workspace, loopId);
}

// ---------------------------------------------------------------------------
// review-admit / finding-update / verdict / finalize / child-loop
// ---------------------------------------------------------------------------

function requireDigest(record: Record<string, unknown>, key: string): Digest {
  return requireString(record, key) as Digest;
}

function optionalFindingSummaries(record: Record<string, unknown>, key: string): readonly FindingSummary[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new LoopError("SCHEMA_INVALID", `Request field ${key} must be an array.`, { key });
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LoopError("SCHEMA_INVALID", `Request field ${key}[${index}] must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    return {
      findingId: requireString(item, "findingId"),
      status: requireString(item, "status") as FindingSummary["status"],
      severity: requireString(item, "severity") as FindingSummary["severity"],
      area: requireString(item, "area"),
      sourceDigest: requireDigest(item, "sourceDigest"),
    };
  });
}

async function reviewAdmitCommand(workspace: string, requestPath: string): Promise<unknown> {
  const record = await readRequestFile(requestPath);
  return admitReviewer({
    workspace,
    loopId: parseLoopId(requireString(record, "loop_id")),
    gate: requireString(record, "gate") as ReviewGate,
    reviewerActor: requireString(record, "reviewer_actor"),
    implementerActors: optionalStringArray(record, "implementer_actors"),
    baseSha: requireString(record, "base_sha"),
    headSha: requireString(record, "head_sha"),
    sourceDigest: requireDigest(record, "source_digest"),
    diffCoordinates: optionalStringArray(record, "diff_coordinates"),
    acceptance: optionalStringArray(record, "acceptance"),
    verificationEvidenceIds: optionalStringArray(record, "verification_evidence_ids"),
    privateOutputRoot: requireString(record, "private_output_root"),
  });
}

async function findingUpdateCommand(workspace: string, requestPath: string): Promise<unknown> {
  const record = await readRequestFile(requestPath);
  return recordFindingUpdate({
    workspace,
    loopId: parseLoopId(requireString(record, "loop_id")),
    findingId: requireString(record, "finding_id"),
    actorRole: requireString(record, "actor_role"),
    status: requireString(record, "status") as FindingSummary["status"],
    sourceDigest: requireDigest(record, "source_digest"),
    ...(typeof record.area === "string" ? { area: record.area } : {}),
    ...(typeof record.severity === "string"
      ? { severity: record.severity as FindingSummary["severity"] }
      : {}),
    ...(typeof record.reviewer_actor === "string" ? { reviewerActor: record.reviewer_actor } : {}),
  });
}

async function verdictCommand(workspace: string, requestPath: string): Promise<unknown> {
  const record = await readRequestFile(requestPath);
  const budgets = record.budgets;
  if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw new LoopError("SCHEMA_INVALID", "Request field budgets must be an object.");
  }
  const budgetRecord = budgets as Record<string, unknown>;
  const loopId = parseLoopId(requireString(record, "loop_id"));
  const input: VerdictInput = {
    workspace,
    loopId,
    risk: requireString(record, "risk") as RiskLevel,
    completedGates: optionalStringArray(record, "completed_gates") as ReviewGate[],
    findings: optionalFindingSummaries(record, "findings"),
    evidenceFresh: record.evidence_fresh === true,
    oscillation: record.oscillation === true,
    budgets: {
      attemptsUsed: Number(budgetRecord.attemptsUsed ?? 0),
      attempts: Number(budgetRecord.attempts ?? 0),
      reviewsUsed: Number(budgetRecord.reviewsUsed ?? 0),
      reviews: Number(budgetRecord.reviews ?? 0),
      transitionsUsed: Number(budgetRecord.transitionsUsed ?? 0),
      transitions: Number(budgetRecord.transitions ?? 0),
    },
  };
  await recordRisk(workspace, loopId, input.risk, "verdict");
  const verdict = aggregateVerdict(input);
  await recordVerdict(workspace, loopId, verdict);
  if (verdict.kind === "NON_CONVERGENT") {
    const layout = resolveLayout(workspace, loopId);
    assertLedgerEvidence(layout, loopId);
    const ledger = await openLedger(layout);
    const snapshot = await ledger.snapshot();
    await writeCheckpoint({
      workspace,
      loopId,
      sourceHeadSha: sha256Hex(canonicalJsonBytes({
        loop_id: loopId,
        phase: snapshot.phase,
        sequence: snapshot.last_event_sequence,
        reason: "NON_CONVERGENT",
      })),
      completedWorkItemIds: [],
      evidenceIds: [],
      blocker: verdict.reasons.join("; "),
      resumeEntry: "Create a Child Loop from this Checkpoint; the parent Loop is NON_CONVERGENT.",
      status: "NON_CONVERGENT",
      phase: snapshot.phase,
    });
    await ledger.transition(snapshot.phase, "NON_CONVERGENT", await ledger.cursor());
  }
  return verdict;
}

function requireRollback(record: Record<string, unknown>): RollbackPlan {
  const value = record.rollback;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LoopError("SCHEMA_INVALID", "Request field rollback must be an object.");
  }
  const rollback = value as Record<string, unknown>;
  return {
    target: requireString(rollback, "target"),
    procedure: optionalStringArray(rollback, "procedure"),
    triggers: optionalStringArray(rollback, "triggers"),
    estimated_recovery_minutes: Number(rollback.estimated_recovery_minutes ?? 0),
  };
}

function requireHarnessFacts(record: Record<string, unknown>): HarnessFacts {
  const value = record.harness_facts;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LoopError("SCHEMA_INVALID", "Request field harness_facts must be an object.");
  }
  const facts = value as Record<string, unknown>;
  if (!Array.isArray(facts.evidence)) {
    throw new LoopError("SCHEMA_INVALID", "Request field harness_facts.evidence must be an array.");
  }
  return {
    harnessDigest: requireDigest(facts, "harnessDigest"),
    waveInputDigest: requireDigest(facts, "waveInputDigest"),
    projectPolicyDigest: requireDigest(facts, "projectPolicyDigest"),
    planDigest: requireDigest(facts, "planDigest"),
    attemptsUsed: Number(facts.attemptsUsed ?? 0),
    reviewsUsed: Number(facts.reviewsUsed ?? 0),
    transitionsUsed: Number(facts.transitionsUsed ?? 0),
    activeWriteWave: facts.activeWriteWave === true,
    evidence: facts.evidence as HarnessFacts["evidence"],
  };
}

async function finalizeCommand(workspace: string, requestPath: string): Promise<FinalHandoff> {
  const record = await readRequestFile(requestPath);
  if (record.h0 === null || typeof record.h0 !== "object" || Array.isArray(record.h0)) {
    throw new LoopError("SCHEMA_INVALID", "Request field h0 must be an object.");
  }
  if (record.h1 === null || typeof record.h1 !== "object" || Array.isArray(record.h1)) {
    throw new LoopError("SCHEMA_INVALID", "Request field h1 must be an object.");
  }
  if (!Array.isArray(record.evidence)) {
    throw new LoopError("SCHEMA_INVALID", "Request field evidence must be an array.");
  }
  if (!Array.isArray(record.agent_bundle_digests)) {
    throw new LoopError("SCHEMA_INVALID", "Request field agent_bundle_digests must be an array.");
  }
  if (!Array.isArray(record.recommended_release_actions)) {
    throw new LoopError("SCHEMA_INVALID", "Request field recommended_release_actions must be an array.");
  }
  const input: FinalizeInput = {
    workspace,
    loopId: parseLoopId(requireString(record, "loop_id")),
    actorRole: requireString(record, "actor_role"),
    sourceHeadSha: requireString(record, "source_head_sha"),
    reviewedTreeDigest: requireDigest(record, "reviewed_tree_digest"),
    workspaceDigest: requireDigest(record, "workspace_digest"),
    sourceManifestDigest: requireDigest(record, "source_manifest_digest"),
    runtimeManifestDigest: requireDigest(record, "runtime_manifest_digest"),
    projectPolicyDigest: record.project_policy_digest === null
      ? null
      : requireDigest(record, "project_policy_digest"),
    h0: record.h0 as H0Harness,
    h1: record.h1 as H1Harness,
    loopMarkdownDigest: requireDigest(record, "loop_markdown_digest"),
    agentBundleDigests: record.agent_bundle_digests as Digest[],
    evidenceManifestDigest: requireDigest(record, "evidence_manifest_digest"),
    evidence: record.evidence as HarnessFacts["evidence"],
    residualRisks: optionalStringArray(record, "residual_risks"),
    rollback: requireRollback(record),
    recommendedReleaseActions: record.recommended_release_actions as ReleaseAction[],
    harnessFacts: requireHarnessFacts(record),
    dispatchConsistent: record.dispatch_consistent === true,
  };
  return finalizeHandoff(input);
}

async function childLoopCommand(
  workspace: string,
  parentLoopId: LoopId,
  reason: string,
  task: string,
): Promise<LoopSnapshot> {
  return createChildLoop({ workspace, parentLoopId, reason, task });
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
  const emptyExtras = {
    reviewGates: [] as ReviewGate[],
    findingOwnership: [] as StatusReport["findingOwnership"],
    handoff: null as StatusReport["handoff"],
    rollback: null as RollbackPlan | null,
    residualRisks: [] as string[],
    recommendedReleaseActions: [] as ReleaseAction[],
    releaseRequiredGates: [] as string[],
  };

  if (request.loopId === undefined) {
    return {
      candidates,
      selected: null,
      harness: { revision: null, digest: null, drift: { kind: "NONE" } },
      openFindings: [],
      staleEvidence: [],
      activeLeases: [],
      nextActions: [],
      ...emptyExtras,
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
  const findings = await listFindings(request.workspace, request.loopId);
  const openFindings = findings
    .filter((finding) => finding.status === "OPEN" || finding.status === "FIXED" || finding.status === "REOPENED")
    .map((finding) => finding.findingId);
  const findingOwnership = findings.map((finding) => ({
    findingId: finding.findingId,
    status: finding.status,
    updatedBy: finding.updatedBy,
    area: finding.area,
  }));
  // Uncommitted orphan handoff.json is not consumable until ledger handoff_digest exists.
  const handoffRecord = selected.handoff_digest === null
    ? null
    : await readHandoff(request.workspace, request.loopId);
  let freshness: "ABSENT" | "FRESH" | "STALE" | "UNKNOWN" = "ABSENT";
  let rollback: RollbackPlan | null = null;
  let residualRisks: readonly string[] = [];
  let recommendedReleaseActions: readonly ReleaseAction[] = [];
  let releaseRequiredGates: readonly string[] = [];
  let reportHandoffDigest: Digest | null = selected.handoff_digest;
  if (selected.handoff_digest === null) {
    freshness = "ABSENT";
    reportHandoffDigest = null;
  } else if (handoffRecord === null) {
    freshness = "UNKNOWN";
  } else if (handoffRecord.digest !== selected.handoff_digest) {
    freshness = "STALE";
    rollback = handoffRecord.rollback;
    residualRisks = handoffRecord.residual_risks;
    recommendedReleaseActions = handoffRecord.recommended_release_actions;
    releaseRequiredGates = handoffRecord.release_required_gates;
  } else {
    rollback = handoffRecord.rollback;
    residualRisks = handoffRecord.residual_risks;
    recommendedReleaseActions = handoffRecord.recommended_release_actions;
    releaseRequiredGates = handoffRecord.release_required_gates;
    reportHandoffDigest = handoffRecord.digest;
    const observation = await observeHandoffFreshnessFacts(request.workspace, request.loopId);
    if (observation.kind === "UNKNOWN") {
      freshness = "UNKNOWN";
    } else {
      try {
        await verifyHandoffFreshness(handoffRecord, observation.facts);
        freshness = "FRESH";
      } catch (error) {
        freshness = error instanceof LoopError && error.code === "STALE_HANDOFF" ? "STALE" : "UNKNOWN";
      }
    }
  }
  const persistedRisk = await readPersistedRisk(request.workspace, request.loopId);
  const reviewGates = persistedRisk === null ? [] : requiredReviewGates(persistedRisk);
  return {
    candidates,
    selected,
    harness: {
      revision: selected.current_harness_revision,
      digest: selected.current_harness_digest,
      drift: { kind: "NONE" },
    },
    openFindings,
    staleEvidence: [],
    activeLeases,
    nextActions: await legalNextActions(selected, displayLanguage),
    reviewGates,
    findingOwnership,
    handoff: {
      digest: reportHandoffDigest,
      freshness,
    },
    rollback,
    residualRisks,
    recommendedReleaseActions,
    releaseRequiredGates,
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
    case "dispatch-reserve":
      return dispatchReserveCommand(workspace, requireOption(options, "request"));
    case "dispatch-accept":
      return dispatchAcceptCommand(workspace, requireOption(options, "request"));
    case "integrate":
      return integrateCommand(workspace, requireOption(options, "request"));
    case "dispatch-reconcile":
      return dispatchReconcileCommand(workspace, parseLoopId(requireOption(options, "loop-id")));
    case "review-admit":
      return reviewAdmitCommand(workspace, requireOption(options, "request"));
    case "finding-update":
      return findingUpdateCommand(workspace, requireOption(options, "request"));
    case "verdict":
      return verdictCommand(workspace, requireOption(options, "request"));
    case "finalize":
      return finalizeCommand(workspace, requireOption(options, "request"));
    case "child-loop":
      return childLoopCommand(
        workspace,
        parseLoopId(requireOption(options, "parent-loop-id")),
        requireOption(options, "reason"),
        requireOption(options, "task"),
      );
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
