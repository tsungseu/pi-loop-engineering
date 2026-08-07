import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentBundle, AgentRequest, AgentResult, WaveInput } from "../contracts/dispatch.js";
import { LoopError, sha256Hex, type Digest, type LoopId } from "../contracts/domain.js";
import type { H1Harness } from "../contracts/harness.js";
import { atomicWriteJson, canonicalJsonBytes } from "./atomic-json.js";
import { openRepositoryCoordinator, type RepositoryLease } from "./coordinator.js";
import { evaluateGate, type HarnessFacts } from "./harness.js";
import { openLedger } from "./ledger.js";
import {
  canonicalizeExternalRoot,
  captureExternalRootDigests,
  digestWorktreePaths,
  observeExternalRootWrites,
  observeWorktreeWrites,
} from "./manifests.js";
import { resolveLayout, type LoopLayout } from "./paths.js";
import { validateSchema } from "./schema.js";

export type DispatchFaultPoint =
  | "after-reservation-intent"
  | "after-reservation-artifact"
  | "before-reservation-commit"
  | "after-result-intent"
  | "after-bundle-artifact"
  | "after-integration-intent"
  | "after-integration-apply";

export interface WaveSets {
  reads: readonly string[] | "UNKNOWN";
  writes: readonly string[];
}

export interface DispatchReservation {
  workspace: string;
  loopId: LoopId;
  workItemId: string;
  actorRole: string;
  objective: string;
  acceptance: readonly string[];
  dependencies: readonly string[];
  readSet: readonly string[] | "UNKNOWN";
  writeSet: readonly string[];
  worktree: string;
  waveInputDigest: Digest;
  h1Digest: Digest;
  completedWorkItemIds?: readonly string[];
  mode?: "persistent" | "session-only";
  externalWriteRoots?: readonly string[];
  hostEnforcedExternalWrite?: boolean;
  fault?: (point: DispatchFaultPoint) => void | Promise<void>;
}

export interface AcceptedAgentBundle {
  request: AgentRequest;
  result: AgentResult;
  bundle: AgentBundle;
}

export interface AcceptAgentResultRequest {
  workspace: string;
  result: unknown;
  /** Optional convenience claim; verified against independent Worktree observation when present. */
  observedWriteSet?: readonly string[];
  fault?: (point: DispatchFaultPoint) => void | Promise<void>;
}

interface SealedPatch {
  schema_version: 1;
  request_id: string;
  worktree: string;
  base_sha: string;
  writes: readonly string[];
  digests: Readonly<Record<string, string>>;
}

export interface IntegrationRequest {
  workspace: string;
  loopId: LoopId;
  bundleDigest: Digest;
  fault?: (point: DispatchFaultPoint) => void | Promise<void>;
}

export type IntegrationDecision =
  | { admitted: true; bundleDigest: Digest; fencingToken: number }
  | { admitted: false; code: "STALE_AGENT_RESULT" | "DISPATCH_REJECTED"; reason: string };

export interface DispatchRecovery {
  openRequestIds: readonly string[];
  integratedBundleDigests: readonly string[];
  abandonedTransactionIds: readonly string[];
  completedWorkItemIds: readonly string[];
}

interface ActiveReservation {
  requestId: string;
  workItemId: string;
  attempt: number;
  actorRole: string;
  readSet: readonly string[] | "UNKNOWN";
  writeSet: readonly string[];
  worktree: string;
  waveInputDigest: Digest;
  h1Digest: Digest;
  fencingToken: number;
  leaseIds: readonly string[];
  status: "OPEN" | "ACCEPTED" | "FAILED" | "ABANDONED";
  requestDigest: Digest;
  baseSha?: string;
  baselineDigests?: Readonly<Record<string, string>>;
  externalWriteRoots?: readonly string[];
  externalBaselineDigests?: Readonly<Record<string, string>>;
}

interface PendingBundle {
  bundleDigest: Digest;
  requestId: string;
  workItemId: string;
  readSet: readonly string[];
  writeSet: readonly string[];
  waveInputDigest: Digest;
  status: "PENDING" | "INTEGRATED" | "STALE";
}

interface DispatchState {
  schema_version: 1;
  loop_id: LoopId;
  next_fencing_token: number;
  reservations: ActiveReservation[];
  pending_bundles: PendingBundle[];
  integrated_write_sets: string[];
  completed_work_item_ids: string[];
  abandoned_transaction_ids: string[];
}

function rejected(message: string, details: Readonly<Record<string, unknown>> = {}): LoopError {
  return new LoopError("DISPATCH_REJECTED", message, details);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function isHostAbsolutePath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path);
}

function normalizeObservedPath(path: string): string {
  if (isHostAbsolutePath(path)) {
    return resolve(path).replace(/\\/gu, "/").replace(/\/+$/u, "");
  }
  return normalizePath(path);
}

function materializePath(worktree: string, path: string): string {
  return isHostAbsolutePath(path) ? resolve(path) : resolve(worktree, path);
}

function sealedStoragePath(outputRoot: string, path: string): string {
  if (isHostAbsolutePath(path)) {
    return join(outputRoot, "__external__", sha256Hex(normalizeObservedPath(path)));
  }
  return join(outputRoot, normalizePath(path));
}

function setsIntersect(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right.map(normalizePath));
  return left.some((path) => rightSet.has(normalizePath(path)));
}

export function canShareWave(left: WaveSets, right: WaveSets): boolean {
  if (left.reads === "UNKNOWN" || right.reads === "UNKNOWN") return false;
  const leftReads = left.reads.map(normalizePath);
  const rightReads = right.reads.map(normalizePath);
  const leftWrites = left.writes.map(normalizePath);
  const rightWrites = right.writes.map(normalizePath);
  if (setsIntersect(leftWrites, [...rightReads, ...rightWrites])) return false;
  if (setsIntersect(rightWrites, [...leftReads, ...leftWrites])) return false;
  return true;
}

function dispatchStatePath(layout: LoopLayout): string {
  return join(layout.harnessRoot, "dispatch-state.json");
}

function emptyState(loopId: LoopId): DispatchState {
  return {
    schema_version: 1,
    loop_id: loopId,
    next_fencing_token: 1,
    reservations: [],
    pending_bundles: [],
    integrated_write_sets: [],
    completed_work_item_ids: [],
    abandoned_transaction_ids: [],
  };
}

async function readDispatchState(layout: LoopLayout): Promise<DispatchState> {
  try {
    const value = JSON.parse(await readFile(dispatchStatePath(layout), "utf8")) as DispatchState;
    if (value.schema_version !== 1 || value.loop_id !== layout.loopId) {
      throw new LoopError("RECONCILE_REQUIRED", "Dispatch state identity is invalid.", { path: dispatchStatePath(layout) });
    }
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyState(layout.loopId);
    throw error;
  }
}

async function writeDispatchState(layout: LoopLayout, state: DispatchState): Promise<void> {
  await mkdir(layout.harnessRoot, { recursive: true });
  await atomicWriteJson(dispatchStatePath(layout), state);
}

async function loadH1(layout: LoopLayout, digest: Digest): Promise<H1Harness> {
  const snapshot = JSON.parse(await readFile(layout.loopJson, "utf8")) as { current_harness_digest: Digest | null; current_harness_revision: number | null };
  if (snapshot.current_harness_digest !== digest || snapshot.current_harness_revision === null) {
    throw rejected("The H1 digest does not match the current Loop Harness.", {
      expected: digest,
      actual: snapshot.current_harness_digest,
    });
  }
  const path = join(layout.harnessRoot, `h1-execution-r${String(snapshot.current_harness_revision).padStart(3, "0")}.json`);
  const h1 = validateSchema<H1Harness>("harness", JSON.parse(await readFile(path, "utf8")));
  if (h1.kind !== "H1" || h1.digest !== digest) {
    throw rejected("The sealed H1 Harness could not be loaded for dispatch.", { path });
  }
  return h1;
}

async function loadWaveInput(layout: LoopLayout, digest: Digest): Promise<WaveInput> {
  const directory = join(layout.harnessRoot, "wave-inputs");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw rejected("No WaveInput is available for dispatch.", { directory });
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const wave = validateSchema<WaveInput>("wave-input", JSON.parse(await readFile(join(directory, entry), "utf8")));
    if (wave.digest === digest) return wave;
  }
  throw rejected("The WaveInput digest does not match a sealed WaveInput.", { digest });
}

function attemptDirectory(layout: LoopLayout, workItemId: string, attempt: number): string {
  return join(layout.harnessRoot, "attempts", workItemId, String(attempt));
}

function outputDirectory(layout: LoopLayout, workItemId: string, attempt: number): string {
  return join(attemptDirectory(layout, workItemId, attempt), "output");
}

function patchPath(layout: LoopLayout, workItemId: string, attempt: number): string {
  return join(attemptDirectory(layout, workItemId, attempt), "patch.json");
}

function appliedMarkerPath(layout: LoopLayout, workItemId: string, attempt: number): string {
  return join(attemptDirectory(layout, workItemId, attempt), "applied.json");
}

async function captureBaselineDigests(
  worktree: string,
  baseSha: string,
  writeSet: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const changed = await observeWorktreeWrites({ root: worktree, baseSha });
  const relativeWrites = writeSet.filter((path) => !isHostAbsolutePath(path)).map(normalizePath);
  const paths = [...new Set([...changed, ...relativeWrites])].sort();
  return digestWorktreePaths(worktree, paths);
}

async function independentlyObserveAgentWrites(options: {
  worktree: string;
  baseSha: string;
  baselineDigests: Readonly<Record<string, string>>;
  externalWriteRoots: readonly string[];
  externalBaselineDigests: Readonly<Record<string, string>>;
}): Promise<readonly string[]> {
  const changed = await observeWorktreeWrites({ root: options.worktree, baseSha: options.baseSha });
  const currentDigests = await digestWorktreePaths(options.worktree, changed);
  const writes: string[] = [];
  for (const path of changed) {
    const current = currentDigests[path] ?? sha256Hex("deleted");
    const baseline = options.baselineDigests[path];
    if (baseline === undefined || baseline !== current) writes.push(normalizePath(path));
  }
  const externalBaseline = options.externalBaselineDigests;
  for (const root of options.externalWriteRoots) {
    const canonicalRoot = await canonicalizeExternalRoot(root);
    const externalWrites = await observeExternalRootWrites({
      root: canonicalRoot,
      baselineDigests: Object.fromEntries(
        Object.entries(externalBaseline).filter(([path]) => (
          path === canonicalRoot || path.startsWith(`${canonicalRoot}/`)
        )),
      ),
    });
    for (const path of externalWrites) writes.push(normalizeObservedPath(path));
  }
  return [...new Set(writes)].sort();
}

async function digestWritePaths(
  worktree: string,
  writes: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const digests: Record<string, string> = {};
  const relative = writes.filter((path) => !isHostAbsolutePath(path)).map(normalizePath);
  Object.assign(digests, await digestWorktreePaths(worktree, relative));
  for (const path of writes.filter((entry) => isHostAbsolutePath(entry))) {
    const absolute = normalizeObservedPath(path);
    try {
      digests[absolute] = sha256Hex(await readFile(absolute));
    } catch (error) {
      if (errorCode(error) === "ENOENT") digests[absolute] = sha256Hex("deleted");
      else throw error;
    }
  }
  return digests;
}

async function sealOutputTree(
  layout: LoopLayout,
  workItemId: string,
  attempt: number,
  worktree: string,
  writes: readonly string[],
  requestId: string,
  baseSha: string,
): Promise<{ patch: SealedPatch; patchDigest: Digest }> {
  const outputRoot = outputDirectory(layout, workItemId, attempt);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const normalizedWrites = writes.map(normalizeObservedPath);
  const digests = await digestWritePaths(worktree, normalizedWrites);
  for (const path of normalizedWrites) {
    const source = materializePath(worktree, path);
    const target = sealedStoragePath(outputRoot, path);
    const digest = digests[path];
    if (digest === sha256Hex("deleted")) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(`${target}.deleted`, "deleted\n", "utf8");
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const patch: SealedPatch = {
    schema_version: 1,
    request_id: requestId,
    worktree,
    base_sha: baseSha,
    writes: [...normalizedWrites],
    digests,
  };
  await atomicWriteJson(patchPath(layout, workItemId, attempt), patch);
  return { patch, patchDigest: sha256Hex(canonicalJsonBytes(patch)) };
}

interface AppliedMarker {
  applied_at: string;
  target: string;
  writes: readonly string[];
  digests: Readonly<Record<string, string>>;
  patch_digest: Digest;
}

function appliedMarkerMatches(
  marker: AppliedMarker,
  patch: SealedPatch,
  patchDigest: Digest,
  targetRoot: string,
): boolean {
  return marker.patch_digest === patchDigest
    && normalizeObservedPath(marker.target) === normalizeObservedPath(targetRoot)
    && JSON.stringify([...marker.writes].map(normalizeObservedPath).sort())
      === JSON.stringify([...patch.writes].map(normalizeObservedPath).sort())
    && JSON.stringify(marker.digests) === JSON.stringify(patch.digests);
}

/**
 * Apply sealed output into the live tree. Idempotent when `applied.json` already
 * matches the sealed patch (crash recovery after apply / before Commit).
 */
async function applySealedPatch(
  layout: LoopLayout,
  workItemId: string,
  attempt: number,
  targetWorkspace: string,
): Promise<"applied" | "already-applied"> {
  const patch = JSON.parse(await readFile(patchPath(layout, workItemId, attempt), "utf8")) as SealedPatch;
  const patchDigest = sha256Hex(canonicalJsonBytes(patch));
  const marker = appliedMarkerPath(layout, workItemId, attempt);
  const outputRoot = outputDirectory(layout, workItemId, attempt);
  const targetRoot = resolve(targetWorkspace);
  try {
    const existing = JSON.parse(await readFile(marker, "utf8")) as AppliedMarker;
    if (appliedMarkerMatches(existing, patch, patchDigest, targetRoot)) {
      return "already-applied";
    }
    throw rejected("The applied marker does not match the sealed patch.", {
      work_item_id: workItemId,
      attempt,
    });
  } catch (error) {
    if (error instanceof LoopError) throw error;
    if (errorCode(error) !== "ENOENT") throw error;
  }
  for (const path of patch.writes) {
    const destination = isHostAbsolutePath(path) ? resolve(path) : join(targetRoot, path);
    const stored = sealedStoragePath(outputRoot, path);
    if (patch.digests[path] === sha256Hex("deleted")) {
      await rm(destination, { force: true });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(stored, destination);
  }
  const applied: AppliedMarker = {
    applied_at: new Date().toISOString(),
    target: targetRoot,
    writes: patch.writes,
    digests: patch.digests,
    patch_digest: patchDigest,
  };
  await atomicWriteJson(marker, applied);
  return "applied";
}

async function releaseReservationLeases(
  workspace: string,
  leaseIds: readonly string[],
): Promise<void> {
  if (leaseIds.length === 0) return;
  const coordinator = await openRepositoryCoordinator(workspace);
  for (const leaseId of leaseIds) {
    try {
      await coordinator.release(leaseId);
    } catch {
      // Lease may already be released or expired/reconciled.
    }
  }
}

/**
 * Compare the live tree and the bundle's declared R/W dependencies to WaveInput.
 * Only broker-tracked integrated writes and pending sealed write sets may differ
 * from the WaveInput base (equivalent to tree/R-W digest freshness). Never auto-rebase.
 */
async function assessWaveInputFreshness(options: {
  workspace: string;
  wave: WaveInput;
  pending: PendingBundle;
  integratedWriteSets: readonly string[];
  pendingBundles: readonly PendingBundle[];
}): Promise<{ fresh: true } | { fresh: false; reason: string }> {
  const observed = await observeWorktreeWrites({
    root: options.workspace,
    baseSha: options.wave.base_sha,
  });
  const allowed = new Set([
    ...options.integratedWriteSets.map(normalizePath),
    ...options.pendingBundles
      .filter((bundle) => bundle.status === "PENDING")
      .flatMap((bundle) => bundle.writeSet.map(normalizeObservedPath)),
  ]);
  const unexpected = observed.map(normalizePath).filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    return {
      fresh: false,
      reason: "Live tree drifted from WaveInput outside broker-tracked integrated writes.",
    };
  }

  // Declared read dependencies must still match WaveInput unless covered by a known
  // pending/integrated write (another sealed result owns that drift).
  const knownWrites = allowed;
  const readDeps = options.pending.readSet
    .map(normalizeObservedPath)
    .filter((path) => !isHostAbsolutePath(path) && !knownWrites.has(path));
  const driftedReads = readDeps.filter((path) => observed.map(normalizePath).includes(path));
  if (driftedReads.length > 0) {
    return {
      fresh: false,
      reason: "Declared read/write dependencies drifted from the sealed WaveInput.",
    };
  }
  if (readDeps.length > 0) {
    const current = await digestWorktreePaths(options.workspace, readDeps);
    for (const path of readDeps) {
      if (current[path] === undefined || current[path] === sha256Hex("deleted")) {
        return {
          fresh: false,
          reason: "Declared read/write dependencies drifted from the sealed WaveInput.",
        };
      }
    }
  }
  return { fresh: true };
}

function pendingRoot(layout: LoopLayout): string {
  return join(layout.harnessRoot, "dispatch-pending");
}

async function writePending(layout: LoopLayout, id: string, value: unknown): Promise<string> {
  const path = join(pendingRoot(layout), `${id}.pending.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
  return path;
}

async function commitPending(layout: LoopLayout, id: string, finalPath: string, value: unknown): Promise<void> {
  const pending = join(pendingRoot(layout), `${id}.pending.json`);
  await mkdir(dirname(finalPath), { recursive: true });
  await atomicWriteJson(finalPath, value);
  await rm(pending, { force: true });
}

function digestRequest(content: Omit<AgentRequest, "digest">): AgentRequest {
  return validateSchema<AgentRequest>("agent-request", {
    ...content,
    digest: sha256Hex(canonicalJsonBytes(content)),
  });
}

function digestBundle(content: Omit<AgentBundle, "digest">): AgentBundle {
  return validateSchema<AgentBundle>("agent-bundle", {
    ...content,
    digest: sha256Hex(canonicalJsonBytes(content)),
  });
}

function gateFacts(h1: H1Harness, attemptsUsed: number, activeWriteWave: boolean): HarnessFacts {
  return {
    harnessDigest: h1.digest,
    waveInputDigest: h1.wave_input_digest,
    projectPolicyDigest: h1.project_policy_digest,
    planDigest: h1.plan_digest,
    attemptsUsed,
    reviewsUsed: 0,
    transitionsUsed: 0,
    activeWriteWave,
    evidence: [],
  };
}

export async function reserveDispatch(request: DispatchReservation): Promise<AgentRequest> {
  const layout = resolveLayout(request.workspace, request.loopId);
  const ledger = await openLedger(layout);
  const state = await readDispatchState(layout);
  const h1 = await loadH1(layout, request.h1Digest);
  const wave = await loadWaveInput(layout, request.waveInputDigest);
  if (wave.digest !== h1.wave_input_digest) {
    throw rejected("The WaveInput digest drifted from the sealed H1 Harness.", {
      wave_input_digest: wave.digest,
      h1_wave_input_digest: h1.wave_input_digest,
    });
  }
  if (request.worktree.trim() === "") {
    throw rejected("Dispatch requires a Worktree identity.");
  }
  const worktreePath = resolve(request.worktree);
  try {
    const worktreeInfo = await stat(worktreePath);
    if (!worktreeInfo.isDirectory()) {
      throw rejected("Dispatch requires a Worktree directory.", { worktree: request.worktree });
    }
  } catch (error) {
    if (error instanceof LoopError) throw error;
    throw rejected("Dispatch requires an existing Worktree identity.", { worktree: request.worktree });
  }

  const completed = new Set([
    ...state.completed_work_item_ids,
    ...(request.completedWorkItemIds ?? []),
  ]);
  for (const dependency of request.dependencies) {
    if (!completed.has(dependency)) {
      throw rejected("Dispatch dependencies are not satisfied.", { dependency });
    }
  }

  const actor = h1.actors.find((grant) => grant.actor_role === request.actorRole);
  if (actor === undefined) {
    throw rejected("The actor role is not granted by the Harness.", { actor_role: request.actorRole });
  }
  if (actor.model_class.trim() === "") {
    throw rejected("The actor model_class is required for Sub-agent dispatch.", { actor_role: request.actorRole });
  }
  if (actor.capabilities.includes("recursive-dispatch")) {
    throw rejected("Recursive delegation is prohibited for Sub-agent dispatch.", { actor_role: request.actorRole });
  }
  if (actor.capabilities.includes("environment")) {
    throw rejected("Environment mutation is prohibited for Sub-agent dispatch.", { actor_role: request.actorRole });
  }

  const mode = request.mode ?? "persistent";
  if (mode === "session-only" && request.writeSet.length > 0) {
    throw rejected("Session-only mode rejects write-capable Sub-agent dispatch.");
  }

  const openReservations = state.reservations.filter((entry) => entry.status === "OPEN");
  if (openReservations.some((entry) => entry.workItemId === request.workItemId)) {
    throw rejected("An open reservation already exists for this work item.", { work_item_id: request.workItemId });
  }

  const priorAttempts = state.reservations.filter((entry) => entry.workItemId === request.workItemId).length;
  const nextAttempt = priorAttempts + 1;
  if (nextAttempt > h1.budgets.attempts) {
    throw rejected("The attempt budget is exhausted.", {
      work_item_id: request.workItemId,
      attempts: h1.budgets.attempts,
    });
  }

  const decision = evaluateGate({
    harness: h1,
    operation: "DISPATCH",
    actorRole: request.actorRole,
    facts: gateFacts(h1, priorAttempts, openReservations.some((entry) => entry.writeSet.length > 0)),
  });
  if (!decision.allowed) {
    throw rejected(decision.reason, { gate_code: decision.code });
  }

  const candidate: WaveSets = { reads: request.readSet, writes: request.writeSet };
  for (const open of openReservations) {
    if (!canShareWave(candidate, { reads: open.readSet, writes: open.writeSet })) {
      throw rejected("The reservation conflicts with an active wave under the symmetric read-write rule.", {
        conflicting_request_id: open.requestId,
      });
    }
    if (open.waveInputDigest !== request.waveInputDigest) {
      throw rejected("Parallel dispatch requires an identical WaveInput digest.", {
        expected: open.waveInputDigest,
        actual: request.waveInputDigest,
      });
    }
  }

  const externalRoots = request.externalWriteRoots ?? [];
  if (externalRoots.length > 0) {
    const externalCapability = h1.capabilities.find((grant) => grant.capability === "external-write");
    if (!request.hostEnforcedExternalWrite || externalCapability?.enforcement !== "HOST_ENFORCED") {
      throw rejected("External writes require HOST_ENFORCED containment and an external-root lease.");
    }
  }

  const coordinator = await openRepositoryCoordinator(request.workspace);
  const leases: RepositoryLease[] = [];
  let reservationCommitted = false;
  try {
    // Path/external-root leases stay ACTIVE across the Agent window; only short
    // Repository/Loop locks are released when reserve() returns.
    if (request.writeSet.length > 0) {
      leases.push(await coordinator.reserve({
        loopId: request.loopId,
        kind: "path",
        resources: request.writeSet,
        ttlMs: 300_000,
      }));
    }
    for (const root of externalRoots) {
      leases.push(await coordinator.reserve({
        loopId: request.loopId,
        kind: "external-root",
        resources: [root],
        ttlMs: 300_000,
      }));
    }

    const fencingToken = state.next_fencing_token;
    const requestId = randomUUID();
    const pendingId = randomUUID();
    await writePending(layout, pendingId, {
      kind: "DISPATCH_INTENT",
      request_id: requestId,
      work_item_id: request.workItemId,
      attempt: nextAttempt,
    });
    await request.fault?.("after-reservation-intent");

    const allowedTools = actor.capabilities.filter((capability) =>
      capability !== "recursive-dispatch" && capability !== "environment");
    const agentRequest = digestRequest({
      schema_version: 1,
      request_id: requestId,
      loop_id: request.loopId,
      work_item_id: request.workItemId,
      attempt: nextAttempt,
      actor_role: request.actorRole,
      objective: request.objective,
      acceptance: [...request.acceptance],
      dependencies: [...request.dependencies],
      read_set: request.readSet === "UNKNOWN" ? "UNKNOWN" : [...request.readSet],
      write_set: [...request.writeSet],
      worktree: request.worktree,
      wave_input_digest: request.waveInputDigest,
      h1_digest: request.h1Digest,
      fencing_token: fencingToken,
      required_evidence_ids: [],
      allowed_tools: allowedTools,
      stop_conditions: [...h1.stop_rules],
    });

    const attemptRoot = attemptDirectory(layout, request.workItemId, nextAttempt);
    await mkdir(attemptRoot, { recursive: true });
    await writeFile(join(attemptRoot, "request.pending.json"), `${JSON.stringify(agentRequest)}\n`, "utf8");
    await request.fault?.("after-reservation-artifact");
    await request.fault?.("before-reservation-commit");

    await ledger.transact("DISPATCH", await ledger.cursor(), async () => agentRequest);
    await atomicWriteJson(join(attemptRoot, "request.json"), agentRequest);
    await rm(join(attemptRoot, "request.pending.json"), { force: true });
    await rm(join(pendingRoot(layout), `${pendingId}.pending.json`), { force: true });

    const baselineDigests = await captureBaselineDigests(request.worktree, wave.base_sha, request.writeSet);
    const externalBaselineDigests: Record<string, string> = {};
    const canonicalExternalRoots: string[] = [];
    for (const root of externalRoots) {
      const canonical = await canonicalizeExternalRoot(root);
      canonicalExternalRoots.push(canonical);
      Object.assign(externalBaselineDigests, await captureExternalRootDigests(canonical));
    }
    await atomicWriteJson(join(attemptRoot, "baseline.json"), {
      base_sha: wave.base_sha,
      digests: baselineDigests,
      external_write_roots: canonicalExternalRoots,
      external_digests: externalBaselineDigests,
    });

    const nextState: DispatchState = {
      ...state,
      next_fencing_token: fencingToken + 1,
      reservations: [
        ...state.reservations,
        {
          requestId,
          workItemId: request.workItemId,
          attempt: nextAttempt,
          actorRole: request.actorRole,
          readSet: request.readSet === "UNKNOWN" ? "UNKNOWN" : [...request.readSet],
          writeSet: [...request.writeSet],
          worktree: request.worktree,
          waveInputDigest: request.waveInputDigest,
          h1Digest: request.h1Digest,
          fencingToken,
          leaseIds: leases.map((lease) => lease.leaseId),
          status: "OPEN",
          requestDigest: agentRequest.digest,
          baseSha: wave.base_sha,
          baselineDigests,
          externalWriteRoots: canonicalExternalRoots,
          externalBaselineDigests,
        },
      ],
    };
    await writeDispatchState(layout, nextState);
    reservationCommitted = true;
  } finally {
    if (!reservationCommitted) {
      for (const lease of leases) {
        try {
          await coordinator.release(lease.leaseId);
        } catch {
          // Best-effort rollback of leases acquired before a failed reserve.
        }
      }
    }
  }

  const refreshed = await readDispatchState(layout);
  const saved = refreshed.reservations.find((entry) => entry.status === "OPEN" && entry.workItemId === request.workItemId);
  if (saved === undefined) {
    throw new LoopError("RECONCILE_REQUIRED", "Dispatch reservation was not committed.", {
      work_item_id: request.workItemId,
    });
  }
  return validateSchema<AgentRequest>(
    "agent-request",
    JSON.parse(await readFile(join(attemptDirectory(layout, saved.workItemId, saved.attempt), "request.json"), "utf8")),
  );
}

export async function acceptAgentResult(input: AcceptAgentResultRequest): Promise<AcceptedAgentBundle> {
  const raw = input.result;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw rejected("AgentResult must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const layout = resolveLayout(input.workspace, record.loop_id as LoopId);
  const ledger = await openLedger(layout);
  const state = await readDispatchState(layout);

  const { observed_write_set: _observed, digest: providedDigest, ...envelope } = record;
  const expectedDigest = sha256Hex(canonicalJsonBytes(envelope));
  if (providedDigest !== expectedDigest) {
    throw rejected("AgentResult envelope digest mismatch.", {
      expected: expectedDigest,
      actual: providedDigest,
    });
  }
  const result = validateSchema<AgentResult>("agent-result", { ...envelope, digest: providedDigest });

  const reservation = state.reservations.find((entry) =>
    entry.requestId === result.request_id
    && (entry.status === "OPEN" || entry.status === "ABANDONED")
    && entry.workItemId === result.work_item_id
    && entry.attempt === result.attempt
    && entry.fencingToken === result.fencing_token);
  if (reservation === undefined) {
    throw rejected("No open reservation matches the AgentResult envelope.");
  }
  if (reservation.waveInputDigest !== result.wave_input_digest || reservation.h1Digest !== result.h1_digest) {
    throw rejected("AgentResult WaveInput or H1 identity drifted from the reservation.");
  }
  if (reservation.actorRole !== result.actor_role) {
    throw rejected("AgentResult actor role does not match the reservation.");
  }

  const allowedWrites = new Set(reservation.writeSet.map(normalizeObservedPath));
  const baseSha = reservation.baseSha
    ?? (await loadWaveInput(layout, reservation.waveInputDigest)).base_sha;
  const baselineDigests = reservation.baselineDigests ?? {};
  const externalWriteRoots = reservation.externalWriteRoots ?? [];
  const externalBaselineDigests = reservation.externalBaselineDigests ?? {};
  const independentWrites = await independentlyObserveAgentWrites({
    worktree: reservation.worktree,
    baseSha,
    baselineDigests,
    externalWriteRoots,
    externalBaselineDigests,
  });
  const undeclared = independentWrites.filter((path) => !allowedWrites.has(normalizeObservedPath(path)));
  if (undeclared.length > 0) {
    throw rejected("Independently observed writes are outside the declared write set.", { undeclared });
  }
  const claimedExtra = result.actual_write_set.filter((path) => !allowedWrites.has(normalizeObservedPath(path)));
  if (claimedExtra.length > 0) {
    throw rejected("AgentResult declares writes outside the reservation write set.", { claimedExtra });
  }
  const independent = [...independentWrites].map(normalizeObservedPath).sort();
  const actual = [...result.actual_write_set].map(normalizeObservedPath).sort();
  if (JSON.stringify(independent) !== JSON.stringify(actual)) {
    throw rejected("AgentResult actual write set does not match the independently observed writes.", {
      independent,
      actual,
    });
  }
  if (input.observedWriteSet !== undefined) {
    const claimed = [...input.observedWriteSet].map(normalizeObservedPath).sort();
    if (JSON.stringify(claimed) !== JSON.stringify(independent)) {
      throw rejected("Caller-observed write set does not match the independently observed writes.", {
        claimed,
        independent,
      });
    }
  }

  const pendingId = randomUUID();
  await writePending(layout, pendingId, { kind: "AGENT_RESULT_INTENT", request_id: result.request_id });
  await input.fault?.("after-result-intent");

  const requestPath = join(attemptDirectory(layout, result.work_item_id, result.attempt), "request.json");
  const request = validateSchema<AgentRequest>("agent-request", JSON.parse(await readFile(requestPath, "utf8")));

  await ledger.transact("AGENT_RESULT", await ledger.cursor(), async () => result);
  await atomicWriteJson(join(attemptDirectory(layout, result.work_item_id, result.attempt), "result.json"), result);

  const sealed = result.status === "COMPLETED"
    ? await sealOutputTree(
      layout,
      result.work_item_id,
      result.attempt,
      reservation.worktree,
      independent,
      result.request_id,
      baseSha,
    )
    : {
      patchDigest: sha256Hex(canonicalJsonBytes({
        request_id: result.request_id,
        actual_write_set: [],
        status: result.status,
      })),
    };
  const bundleContent = {
    schema_version: 1 as const,
    bundle_id: randomUUID(),
    request_digest: request.digest,
    result_digest: result.digest,
    patch_digest: sealed.patchDigest,
    output_tree_digest: result.output_tree_digest,
    artifact_manifest_digest: result.artifact_manifest_digest,
    evidence_ids: [...result.evidence_ids],
  };
  const bundle = digestBundle(bundleContent);
  const bundlePending = join(attemptDirectory(layout, result.work_item_id, result.attempt), "bundle.pending.json");
  await writeFile(bundlePending, `${JSON.stringify(bundle)}\n`, "utf8");
  await input.fault?.("after-bundle-artifact");

  await ledger.transact("AGENT_BUNDLE", await ledger.cursor(), async () => bundle);
  await commitPending(layout, pendingId, join(attemptDirectory(layout, result.work_item_id, result.attempt), "bundle.json"), bundle);
  await rm(bundlePending, { force: true });

  const terminalStatus = result.status === "COMPLETED" ? "ACCEPTED" : "FAILED";
  const nextBundles = result.status === "COMPLETED"
    ? [
      ...state.pending_bundles,
      {
        bundleDigest: bundle.digest,
        requestId: result.request_id,
        workItemId: result.work_item_id,
        readSet: result.actual_read_set.length > 0
          ? [...result.actual_read_set]
          : (Array.isArray(reservation.readSet) ? [...reservation.readSet] : []),
        writeSet: [...independent],
        waveInputDigest: result.wave_input_digest,
        status: "PENDING" as const,
      },
    ]
    : state.pending_bundles;

  const nextState: DispatchState = {
    ...state,
    reservations: state.reservations.map((entry) => (
      entry.requestId === result.request_id ? { ...entry, status: terminalStatus } : entry
    )),
    pending_bundles: nextBundles,
    completed_work_item_ids: result.status === "COMPLETED"
      ? state.completed_work_item_ids
      : state.completed_work_item_ids,
  };
  await writeDispatchState(layout, nextState);
  // Path/external-root leases span the Agent window; release on terminal accept.
  await releaseReservationLeases(input.workspace, reservation.leaseIds);
  return { request, result, bundle };
}

export async function admitIntegration(request: IntegrationRequest): Promise<IntegrationDecision> {
  const layout = resolveLayout(request.workspace, request.loopId);
  const ledger = await openLedger(layout);
  const state = await readDispatchState(layout);
  const pending = state.pending_bundles.find((bundle) => bundle.bundleDigest === request.bundleDigest);
  if (pending === undefined) {
    return { admitted: false, code: "DISPATCH_REJECTED", reason: "No pending sealed bundle matches the digest." };
  }
  if (pending.status === "INTEGRATED") {
    return { admitted: false, code: "DISPATCH_REJECTED", reason: "The sealed bundle was already integrated." };
  }
  if (pending.status === "STALE") {
    return { admitted: false, code: "STALE_AGENT_RESULT", reason: "The sealed bundle is stale relative to integrated changes." };
  }

  const touched = [...pending.readSet, ...pending.writeSet].map(normalizePath);
  if (setsIntersect(state.integrated_write_sets, touched)) {
    const nextState: DispatchState = {
      ...state,
      pending_bundles: state.pending_bundles.map((bundle) => (
        bundle.bundleDigest === request.bundleDigest ? { ...bundle, status: "STALE" as const } : bundle
      )),
    };
    await writeDispatchState(layout, nextState);
    return {
      admitted: false,
      code: "STALE_AGENT_RESULT",
      reason: "Integrated changes intersect the bundle read or write set.",
    };
  }

  const coordinator = await openRepositoryCoordinator(request.workspace);
  const integrationLease = await coordinator.reserve({
    loopId: request.loopId,
    kind: "integration",
    resources: ["tree"],
    ttlMs: 60_000,
  });
  try {
    const wave = await loadWaveInput(layout, pending.waveInputDigest);
    const freshness = await assessWaveInputFreshness({
      workspace: request.workspace,
      wave,
      pending,
      integratedWriteSets: state.integrated_write_sets,
      pendingBundles: state.pending_bundles,
    });
    if (!freshness.fresh) {
      const nextState: DispatchState = {
        ...state,
        pending_bundles: state.pending_bundles.map((bundle) => (
          bundle.bundleDigest === request.bundleDigest ? { ...bundle, status: "STALE" as const } : bundle
        )),
      };
      await writeDispatchState(layout, nextState);
      return {
        admitted: false,
        code: "STALE_AGENT_RESULT",
        reason: freshness.reason,
      };
    }

    const pendingId = randomUUID();
    await writePending(layout, pendingId, {
      kind: "INTEGRATION_INTENT",
      bundle_digest: request.bundleDigest,
      fencing_token: integrationLease.fencingToken,
    });
    await request.fault?.("after-integration-intent");

    const reservation = state.reservations.find((entry) => entry.requestId === pending.requestId);
    const attempt = reservation?.attempt ?? 1;
    const bundle = validateSchema<AgentBundle>(
      "agent-bundle",
      JSON.parse(await readFile(join(attemptDirectory(layout, pending.workItemId, attempt), "bundle.json"), "utf8")),
    );
    // Apply then Commit; apply is idempotent when applied.json already matches.
    await applySealedPatch(layout, pending.workItemId, attempt, request.workspace);
    await request.fault?.("after-integration-apply");
    await ledger.transact("INTEGRATION", await ledger.cursor(), async () => bundle);
    await rm(join(pendingRoot(layout), `${pendingId}.pending.json`), { force: true });

    const nextState: DispatchState = {
      ...state,
      pending_bundles: state.pending_bundles.map((entry) => {
        if (entry.bundleDigest === request.bundleDigest) {
          return { ...entry, status: "INTEGRATED" as const };
        }
        const dependencyPaths = [...entry.readSet, ...entry.writeSet].map(normalizePath);
        if (setsIntersect(pending.writeSet, dependencyPaths)) {
          return { ...entry, status: "STALE" as const };
        }
        return entry;
      }),
      integrated_write_sets: [...new Set([
        ...state.integrated_write_sets.map(normalizePath),
        ...pending.writeSet.map(normalizePath),
      ])],
      completed_work_item_ids: [...new Set([...state.completed_work_item_ids, pending.workItemId])],
    };
    await writeDispatchState(layout, nextState);
    return {
      admitted: true,
      bundleDigest: request.bundleDigest,
      fencingToken: integrationLease.fencingToken,
    };
  } finally {
    try {
      await coordinator.release(integrationLease.leaseId);
    } catch {
      // Integration lease may already be reconciled.
    }
  }
}

export async function reconcileDispatch(workspace: string, loopId: LoopId): Promise<DispatchRecovery> {
  const layout = resolveLayout(workspace, loopId);
  const ledger = await openLedger(layout);
  await ledger.recover();
  const coordinator = await openRepositoryCoordinator(workspace);
  await coordinator.reconcile();

  const abandoned: string[] = [];
  try {
    const pendingFiles = await readdir(pendingRoot(layout));
    for (const file of pendingFiles) {
      if (!file.endsWith(".pending.json")) continue;
      const id = file.replace(/\.pending\.json$/u, "");
      const from = join(pendingRoot(layout), file);
      const quarantine = join(pendingRoot(layout), `${file}.quarantine-${randomUUID()}`);
      await rename(from, quarantine);
      abandoned.push(id);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const state = await readDispatchState(layout);
  const previouslyOpen = state.reservations.filter((entry) => entry.status === "OPEN");
  const next: DispatchState = {
    ...state,
    // Fence open attempts during recovery so callers cannot duplicate the same dispatch.
    reservations: state.reservations.map((entry) => (
      entry.status === "OPEN" ? { ...entry, status: "ABANDONED" as const } : entry
    )),
    abandoned_transaction_ids: [...new Set([
      ...state.abandoned_transaction_ids,
      ...abandoned,
      ...previouslyOpen.map((entry) => entry.requestId),
    ])],
  };
  await writeDispatchState(layout, next);
  // Abandoned open attempts release retained path/external-root leases.
  for (const entry of previouslyOpen) {
    await releaseReservationLeases(workspace, entry.leaseIds);
  }

  return {
    openRequestIds: previouslyOpen.map((entry) => entry.requestId),
    integratedBundleDigests: next.pending_bundles
      .filter((bundle) => bundle.status === "INTEGRATED")
      .map((bundle) => bundle.bundleDigest),
    abandonedTransactionIds: next.abandoned_transaction_ids,
    completedWorkItemIds: next.completed_work_item_ids,
  };
}
