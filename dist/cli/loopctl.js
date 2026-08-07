import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOOP_PHASES, LOOP_STATUSES, LoopError, sha256Hex, } from "../contracts/domain.js";
import { atomicWriteFile, atomicWriteJson, canonicalJsonBytes } from "../core/atomic-json.js";
import { acceptAgentResult, admitIntegration, reconcileDispatch, reserveDispatch, } from "../core/dispatch.js";
import { forgeH0 } from "../core/harness.js";
import { openLedger } from "../core/ledger.js";
import { renderLoopMarkdown, resolveMarkdownLanguage } from "../core/markdown.js";
import { parseLoopId, resolveLayout } from "../core/paths.js";
import { validateSchema } from "../core/schema.js";
// ---------------------------------------------------------------------------
// Errors and exit codes
// ---------------------------------------------------------------------------
class UsageError extends Error {
    details;
    constructor(message, details = {}) {
        super(message);
        this.details = details;
        this.name = "UsageError";
    }
}
const USAGE_EXIT_CODE = 2;
const UNKNOWN_EXIT_CODE = 1;
const LOOP_ERROR_EXIT_CODES = {
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
function classifyError(error) {
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
const COMMAND_OPTIONS = {
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
};
function parseArguments(argv) {
    const [command, ...rest] = argv;
    if (command === undefined) {
        throw new UsageError("A subcommand is required.", { commands: Object.keys(COMMAND_OPTIONS).sort() });
    }
    const specification = COMMAND_OPTIONS[command];
    if (specification === undefined) {
        throw new UsageError("Unknown subcommand.", { command, commands: Object.keys(COMMAND_OPTIONS).sort() });
    }
    const allowed = new Set([...specification.required, ...specification.optional]);
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (token === undefined)
            continue;
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
function requireOption(options, key) {
    const value = options[key];
    if (value === undefined)
        throw new UsageError("Missing required option.", { option: `--${key}` });
    return value;
}
function parseLanguage(value) {
    if (value !== "en-US" && value !== "zh-CN") {
        throw new LoopError("INVALID_MARKDOWN_LANGUAGE", "Supported Markdown languages are en-US and zh-CN.", { value });
    }
    return value;
}
function parsePhase(value) {
    if (!LOOP_PHASES.includes(value)) {
        throw new UsageError("Unknown target phase.", { value, phases: LOOP_PHASES });
    }
    return value;
}
function parseStatus(value) {
    if (!LOOP_STATUSES.includes(value)) {
        throw new UsageError("Unknown target status.", { value, statuses: LOOP_STATUSES });
    }
    return value;
}
async function deriveRepositoryIdentity(workspace) {
    const repositoryRoot = await realpath(resolve(workspace));
    const repositoryId = sha256Hex(Buffer.from(`pai-loop/repository/v1\0${repositoryRoot}`, "utf8"));
    const repositoryRulesDigest = sha256Hex(canonicalJsonBytes({ repository_id: repositoryId }));
    return { repositoryRoot, repositoryId, repositoryRulesDigest };
}
function generateLoopId() {
    const stamp = new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14);
    return parseLoopId(`loop-${stamp}-${randomBytes(5).toString("hex")}`);
}
function narrativePath(layout) {
    return join(layout.loopRoot, "narrative.json");
}
async function readNarrative(layout) {
    try {
        const value = JSON.parse(await readFile(narrativePath(layout), "utf8"));
        return {
            task: typeof value.task === "string" ? value.task : "",
            journey: Array.isArray(value.journey) ? value.journey.filter((entry) => typeof entry === "string") : [],
        };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { task: "", journey: [] };
        throw error;
    }
}
async function writeNarrative(layout, narrative) {
    await atomicWriteFile(narrativePath(layout), new TextEncoder().encode(JSON.stringify(narrative)));
}
async function renderLoopFile(layout, snapshot, narrative) {
    const facts = {
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
function hasLedgerEvidence(layout) {
    if (existsSync(layout.loopJson))
        return true;
    try {
        return statSync(layout.eventsJsonl).size > 0;
    }
    catch {
        return false;
    }
}
function assertLedgerEvidence(layout, loopId) {
    if (!hasLedgerEvidence(layout)) {
        throw new LoopError("RECONCILE_REQUIRED", "The requested Loop does not exist in the workspace.", {
            loop_id: loopId,
        });
    }
}
async function ensurePublicMarkdown(layout, snapshot) {
    if (existsSync(layout.loopMarkdown))
        return;
    await renderLoopFile(layout, snapshot, await readNarrative(layout));
}
// ---------------------------------------------------------------------------
// Legacy state and terminal-status guards
// ---------------------------------------------------------------------------
function assertNoLegacyRuns(workspace) {
    if (existsSync(join(resolve(workspace), ".ai", "runs"))) {
        throw new LoopError("RECONCILE_REQUIRED", "Legacy v1 .ai/runs state cannot be resumed by the v0.3 runtime.", {
            workspace: resolve(workspace),
        });
    }
}
function assertResumable(snapshot) {
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
async function readH0(layout) {
    const path = join(layout.harnessRoot, "h0-discovery.json");
    try {
        return validateSchema("harness", JSON.parse(await readFile(path, "utf8")));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new LoopError("HARNESS_REQUIRED", "The Loop has no discovery Harness and cannot be resumed.", { path });
        }
        throw error;
    }
}
// ---------------------------------------------------------------------------
// start / bootstrap
// ---------------------------------------------------------------------------
export async function bootstrapLoop(request) {
    if (request.task.trim() === "") {
        throw new LoopError("SCHEMA_INVALID", "A start task description is required.");
    }
    const language = await resolveMarkdownLanguage(request.markdownLanguage === undefined
        ? { workspace: request.workspace }
        : { workspace: request.workspace, explicit: request.markdownLanguage });
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
    const narrative = { task: request.task, journey: ["Bootstrapped the Loop to ORIENTING."] };
    await writeNarrative(layout, narrative);
    await renderLoopFile(layout, await ledger.snapshot(), narrative);
    const snapshot = await ledger.transition("ORIENTING", "ACTIVE", await ledger.cursor());
    await renderLoopFile(layout, snapshot, narrative);
    return snapshot;
}
// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------
export async function resumeLoop(request) {
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
async function transitionLoop(workspace, loopId, to, status) {
    const layout = resolveLayout(workspace, loopId);
    assertLedgerEvidence(layout, loopId);
    const ledger = await openLedger(layout);
    const snapshot = await ledger.transition(to, status, await ledger.cursor());
    const narrative = await readNarrative(layout);
    const updated = {
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
async function setMarkdownLanguage(workspace, loopId, language) {
    const layout = resolveLayout(workspace, loopId);
    assertLedgerEvidence(layout, loopId);
    const ledger = await openLedger(layout);
    const before = await ledger.snapshot();
    const snapshot = await ledger.setMarkdownLanguage(language, await ledger.cursor());
    if (snapshot.last_event_sequence === before.last_event_sequence) {
        return snapshot;
    }
    const narrative = await readNarrative(layout);
    const updated = {
        task: narrative.task,
        journey: [...narrative.journey, `MARKDOWN_LANGUAGE_CHANGED to ${language}.`],
    };
    await writeNarrative(layout, updated);
    await renderLoopFile(layout, snapshot, updated);
    return snapshot;
}
async function checkpointLoop(workspace, loopId, reason) {
    if (reason.trim() === "") {
        throw new LoopError("SCHEMA_INVALID", "A checkpoint reason is required.");
    }
    const layout = resolveLayout(workspace, loopId);
    assertLedgerEvidence(layout, loopId);
    const ledger = await openLedger(layout);
    const snapshot = await ledger.snapshot();
    const committed = await ledger.transact("CHECKPOINT", await ledger.cursor(), async () => {
        const content = {
            schema_version: 1,
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
        const checkpoint = { ...content, digest: sha256Hex(canonicalJsonBytes(content)) };
        return validateSchema("checkpoint", checkpoint);
    });
    return committed.snapshot;
}
// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------
async function reconcileLoop(workspace, loopId) {
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
async function readRequestFile(path) {
    let value;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT") {
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
    return value;
}
function requireString(record, key) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new LoopError("SCHEMA_INVALID", `Request field ${key} must be a non-empty string.`, { key });
    }
    return value;
}
function optionalStringArray(record, key) {
    const value = record[key];
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
        throw new LoopError("SCHEMA_INVALID", `Request field ${key} must be an array of non-empty strings.`, { key });
    }
    return value;
}
function readSetField(record) {
    const value = record.read_set;
    if (value === "UNKNOWN")
        return "UNKNOWN";
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
        throw new LoopError("SCHEMA_INVALID", "Request field read_set must be UNKNOWN or an array of paths.");
    }
    return value;
}
async function dispatchReserveCommand(workspace, requestPath) {
    const record = await readRequestFile(requestPath);
    const reservation = {
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
        waveInputDigest: requireString(record, "wave_input_digest"),
        h1Digest: requireString(record, "h1_digest"),
        completedWorkItemIds: optionalStringArray(record, "completed_work_item_ids"),
        mode: record.mode === "session-only" ? "session-only" : "persistent",
    };
    return reserveDispatch(reservation);
}
async function dispatchAcceptCommand(workspace, requestPath) {
    const record = await readRequestFile(requestPath);
    const observed = optionalStringArray(record, "observed_write_set");
    const { observed_write_set: _observed, ...result } = record;
    return acceptAgentResult({
        workspace,
        result,
        observedWriteSet: observed,
    });
}
async function integrateCommand(workspace, requestPath) {
    const record = await readRequestFile(requestPath);
    return admitIntegration({
        workspace,
        loopId: parseLoopId(requireString(record, "loop_id")),
        bundleDigest: requireString(record, "bundle_digest"),
    });
}
async function dispatchReconcileCommand(workspace, loopId) {
    const layout = resolveLayout(workspace, loopId);
    assertLedgerEvidence(layout, loopId);
    return reconcileDispatch(workspace, loopId);
}
// ---------------------------------------------------------------------------
// status (strictly read-only)
// ---------------------------------------------------------------------------
async function listCandidates(loopsRoot) {
    let entries;
    try {
        entries = await readdir(loopsRoot, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        try {
            candidates.push(parseLoopId(entry.name));
        }
        catch {
            // Ignore directories that are not valid Loop identifiers.
        }
    }
    return candidates.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
let workflowTransitionsCache;
async function readWorkflowTransitions() {
    if (workflowTransitionsCache !== undefined)
        return workflowTransitionsCache;
    const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
    const candidates = [
        resolve(moduleDirectory, "../../assets/loop-engineering/workflow-spec.json"),
        resolve(moduleDirectory, "../../../assets/loop-engineering/workflow-spec.json"),
    ];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(await readFile(candidate, "utf8"));
            workflowTransitionsCache = parsed.transitions ?? {};
            return workflowTransitionsCache;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    workflowTransitionsCache = {};
    return workflowTransitionsCache;
}
async function legalNextActions(snapshot, language) {
    const transitions = await readWorkflowTransitions();
    const targets = transitions[snapshot.phase] ?? [];
    return targets.map((target) => language === "zh-CN" ? `转换到 ${target}` : `Transition to ${target}`);
}
export async function inspectLoops(request) {
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
    const selected = validateSchema("loop", JSON.parse(await readFile(layout.loopJson, "utf8")));
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
async function run(parsed) {
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
            return transitionLoop(workspace, parseLoopId(requireOption(options, "loop-id")), parsePhase(requireOption(options, "to")), statusOption === undefined ? "ACTIVE" : parseStatus(statusOption));
        }
        case "set-markdown-language":
            return setMarkdownLanguage(workspace, parseLoopId(requireOption(options, "loop-id")), parseLanguage(requireOption(options, "language")));
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
        default:
            throw new UsageError("Unknown subcommand.", { command });
    }
}
export async function main(argv) {
    try {
        const parsed = parseArguments(argv);
        const output = await run(parsed);
        process.stdout.write(`${JSON.stringify(output)}\n`);
        return 0;
    }
    catch (error) {
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
//# sourceMappingURL=loopctl.js.map