import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LoopError,
  sha256Hex,
  type Digest,
  type LoopId,
} from "../contracts/domain.js";
import type {
  ActionEnvelope,
  CommitActionEnvelope,
  FinalHandoff,
  PhysicalActionEnvelope,
  ReleaseAction,
  ReleaseHarness,
  ReleasePhase,
  ReleaseRecord,
  ScopedAuthorization,
} from "../contracts/release.js";
import { atomicWriteJson, canonicalJsonBytes } from "./atomic-json.js";
import { openRepositoryCoordinator } from "./coordinator.js";
import {
  observeHandoffFreshnessFacts,
  readHandoff,
  verifyHandoffFreshness,
} from "./handoff.js";
import { openLedger } from "./ledger.js";
import { CONTROL_EXCLUSIONS, buildTreeManifest } from "./manifests.js";
import { parseLoopId, resolveLayout } from "./paths.js";
import { validateSchema } from "./schema.js";

export type OperationStatus =
  | "PENDING"
  | "UNKNOWN"
  | "READY_TO_RETRY"
  | "SUCCESS"
  | "FAILED";

export interface OperationRecord {
  schema_version: 1;
  operation_id: string;
  release_id: string;
  action: ReleaseAction;
  target: string;
  handoff_digest: Digest;
  envelope_digest: Digest;
  idempotency_key: string;
  status: OperationStatus;
  result_ref: string | null;
  created_at: string;
  updated_at: string;
  reconciled_at: string | null;
}

export interface ReadinessInput {
  workspace: string;
  loopId: LoopId;
}

export interface ReadinessReport {
  loopId: LoopId;
  handoffDigest: Digest;
  ready: boolean;
  blockers: readonly string[];
  pendingReleaseGates: readonly string[];
  allowedActions: readonly ReleaseAction[];
}

export interface ReleaseInput {
  workspace: string;
  loopId: LoopId;
  allowedTargets: readonly string[];
  expiresAt: string;
  releaseId?: string;
}

export interface ActionRequest {
  workspace: string;
  loopId: LoopId;
  releaseId: string;
  action: ReleaseAction;
  target: string;
  authorization: ScopedAuthorization;
  branch?: string;
  releaseCommitSha?: string;
  environmentNode?: PhysicalActionEnvelope["environment_node"];
}

export interface CommitResult {
  commitSha: string;
  treeDigest: Digest;
  parentSha: string;
  idempotent: boolean;
}

export interface ExecuteCommitInput {
  workspace: string;
  envelope: CommitActionEnvelope;
}

export interface OperationIntentInput {
  workspace: string;
  envelope: ActionEnvelope;
}

export interface ReconcileInput {
  workspace: string;
  releaseId: string;
  operationId: string;
}

const RELEASE_READ_ONLY_TOOLS = ["git-read", "status", "read", "manifest-read"] as const;
const PHYSICAL_ACTIONS = new Set<ReleaseAction>(["run-hil", "deploy-robot", "run-real-robot"]);
const EXTERNAL_ACTIONS = new Set<ReleaseAction>(["push", "pr", "tag", "publish", "deploy-sim"]);
/** Phases that forbid any new Action Envelope. RELEASED is not included: post-commit
 *  external/physical actions must still bind the verified Release Commit. */
const ENVELOPE_FORBIDDEN_PHASES = new Set<ReleasePhase>([
  "BLOCKED",
  "CANCELLED",
  "EXECUTING",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function releaseDirectory(workspace: string, releaseId: string): string {
  return join(resolveLayout(workspace).releasesRoot, releaseId);
}

function releaseJsonPath(workspace: string, releaseId: string): string {
  return join(releaseDirectory(workspace, releaseId), "release.json");
}

function releaseHarnessPath(workspace: string, releaseId: string): string {
  return join(releaseDirectory(workspace, releaseId), "release-harness.json");
}

function operationPath(workspace: string, releaseId: string, operationId: string): string {
  return join(releaseDirectory(workspace, releaseId), "operations", `${operationId}.json`);
}

function envelopePath(workspace: string, releaseId: string, operationId: string): string {
  return join(releaseDirectory(workspace, releaseId), "envelopes", `${operationId}.json`);
}

function digestReleaseContent(content: Omit<ReleaseRecord, "digest">): ReleaseRecord {
  return validateSchema<ReleaseRecord>("release", {
    ...content,
    digest: sha256Hex(canonicalJsonBytes(content)),
  });
}

function withReleasePhase(
  release: ReleaseRecord,
  phase: ReleasePhase,
  extra: Partial<Pick<ReleaseRecord, "action_envelope_digests" | "operation_ids" | "release_commit_sha">> = {},
): ReleaseRecord {
  return digestReleaseContent({
    schema_version: 1,
    release_id: release.release_id,
    loop_id: release.loop_id,
    handoff_digest: release.handoff_digest,
    phase,
    action_envelope_digests: extra.action_envelope_digests ?? release.action_envelope_digests,
    operation_ids: extra.operation_ids ?? release.operation_ids,
    created_at: release.created_at,
    updated_at: nowIso(),
    release_commit_sha: extra.release_commit_sha !== undefined
      ? extra.release_commit_sha
      : release.release_commit_sha,
  });
}

async function loadImmutableEnvelope(
  workspace: string,
  releaseId: string,
  operationId: string,
): Promise<ActionEnvelope> {
  try {
    return validateSchema<ActionEnvelope>(
      "action-envelope",
      JSON.parse(await readFile(envelopePath(workspace, releaseId, operationId), "utf8")),
    );
  } catch (error) {
    if (error instanceof LoopError) throw error;
    throw new LoopError("SCHEMA_INVALID", "Action Envelope could not be loaded from immutable Release state.", {
      operation_id: operationId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function assertHarnessUnexpired(harness: ReleaseHarness, now: Date): void {
  if (Date.parse(harness.expires_at) <= now.getTime()) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: Release Harness has expired.", {
      expires_at: harness.expires_at,
    });
  }
}

async function assertHarnessBinding(
  workspace: string,
  releaseId: string,
  envelope: ActionEnvelope,
  now: Date = new Date(),
): Promise<ReleaseHarness> {
  const harness = validateSchema<ReleaseHarness>(
    "release-harness",
    JSON.parse(await readFile(releaseHarnessPath(workspace, releaseId), "utf8")),
  );
  if (harness.handoff_digest !== envelope.handoff_digest) {
    throw new LoopError("SCHEMA_INVALID", "Action Envelope handoff_digest drifted from the Release Harness.", {
      harness: harness.handoff_digest,
      envelope: envelope.handoff_digest,
    });
  }
  if (!harness.allowed_actions.includes(envelope.action)) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "Action is not allowed by the Release Harness.", {
      action: envelope.action,
    });
  }
  if (!harness.allowed_targets.includes(envelope.target)) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "Target is not allowed by the Release Harness.", {
      target: envelope.target,
    });
  }
  assertHarnessUnexpired(harness, now);
  return harness;
}

async function healReleaseAfterSuccess(
  workspace: string,
  release: ReleaseRecord,
  operationId: string,
  commitSha: string,
): Promise<ReleaseRecord> {
  const alreadyBound = release.phase === "RELEASED"
    && release.release_commit_sha === commitSha
    && release.operation_ids.includes(operationId);
  if (alreadyBound) return release;
  const healed = withReleasePhase(release, "RELEASED", {
    release_commit_sha: commitSha,
    operation_ids: release.operation_ids.includes(operationId)
      ? release.operation_ids
      : [...release.operation_ids, operationId],
  });
  await writeRelease(workspace, healed);
  return healed;
}

function digestHarnessContent(content: Omit<ReleaseHarness, "digest">): ReleaseHarness {
  return validateSchema<ReleaseHarness>("release-harness", {
    ...content,
    digest: sha256Hex(canonicalJsonBytes(content)),
  });
}

function envelopeDigest(envelope: ActionEnvelope): Digest {
  return sha256Hex(canonicalJsonBytes(envelope));
}

function commitMetadata(handoffDigest: Digest, branch: string): { message: string; branch: string; handoff_digest: Digest } {
  return {
    message: "pai-loop-engineering: package reviewed Tree",
    branch,
    handoff_digest: handoffDigest,
  };
}

function git(workspace: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", workspace, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(Buffer.concat(stderr).toString("utf8") || `git ${args[0]} exited ${code}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

async function readRelease(workspace: string, releaseId: string): Promise<ReleaseRecord> {
  return validateSchema<ReleaseRecord>("release", JSON.parse(await readFile(releaseJsonPath(workspace, releaseId), "utf8")));
}

async function writeRelease(workspace: string, release: ReleaseRecord): Promise<void> {
  await atomicWriteJson(releaseJsonPath(workspace, release.release_id), release);
}

async function readOperation(
  workspace: string,
  releaseId: string,
  operationId: string,
): Promise<OperationRecord | null> {
  try {
    return JSON.parse(await readFile(operationPath(workspace, releaseId, operationId), "utf8")) as OperationRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeOperation(workspace: string, record: OperationRecord): Promise<OperationRecord> {
  await mkdir(join(releaseDirectory(workspace, record.release_id), "operations"), { recursive: true });
  await atomicWriteJson(operationPath(workspace, record.release_id, record.operation_id), record);
  return record;
}

async function assertHandoffReady(workspace: string, loopId: LoopId): Promise<{
  handoff: FinalHandoff;
  blockers: string[];
  pendingReleaseGates: readonly string[];
  allowedActions: readonly ReleaseAction[];
}> {
  const layout = resolveLayout(workspace, loopId);
  const ledger = await openLedger(layout);
  const snapshot = await ledger.snapshot();
  const blockers: string[] = [];

  if (snapshot.phase !== "HANDOFF_READY" || snapshot.status !== "COMPLETE") {
    blockers.push(`Loop must be HANDOFF_READY + COMPLETE (found ${snapshot.phase}/${snapshot.status}).`);
  }
  if (snapshot.handoff_digest === null) {
    blockers.push("Committed Final Handoff digest is missing; Checkpoint-only Loops are not Release-ready.");
  }

  const handoff = await readHandoff(workspace, loopId);
  if (handoff === null) {
    blockers.push("Final Handoff file is absent.");
    return {
      handoff: {
        schema_version: 1,
        loop_id: loopId,
        markdown_language: "en-US",
        source_head_sha: "0".repeat(40),
        reviewed_tree_digest: "0".repeat(64) as Digest,
        workspace_digest: "0".repeat(64) as Digest,
        source_manifest_digest: "0".repeat(64) as Digest,
        runtime_manifest_digest: "0".repeat(64) as Digest,
        project_policy_digest: null,
        h0_digest: "0".repeat(64) as Digest,
        h1_revision: 1,
        h1_digest: "0".repeat(64) as Digest,
        loop_markdown_digest: "0".repeat(64) as Digest,
        agent_bundle_digests: [],
        evidence_manifest_digest: "0".repeat(64) as Digest,
        review_verdict: "PASS",
        residual_risks: [],
        rollback: { target: "none", procedure: ["n/a"], triggers: ["n/a"], estimated_recovery_minutes: 0 },
        release_required_gates: [],
        recommended_release_actions: [],
        finalize_event_sequence: 1,
        digest: "0".repeat(64) as Digest,
      },
      blockers,
      pendingReleaseGates: [],
      allowedActions: [],
    };
  }

  if (snapshot.handoff_digest !== null && snapshot.handoff_digest !== handoff.digest) {
    blockers.push("Ledger Handoff digest does not match handoff.json.");
  }
  if (handoff.rollback.procedure.length === 0 || handoff.rollback.triggers.length === 0) {
    blockers.push("Handoff rollback procedure/triggers are incomplete.");
  }
  if (handoff.recommended_release_actions.length === 0) {
    blockers.push("Handoff recommends no Release actions.");
  }

  const observation = await observeHandoffFreshnessFacts(workspace, loopId);
  if (observation.kind === "UNKNOWN") {
    blockers.push(`Freshness observation failed: ${observation.reason}`);
    blockers.push("check:dist facts could not be observed.");
  } else {
    try {
      await verifyHandoffFreshness(handoff, observation.facts);
    } catch (error) {
      if (error instanceof LoopError && error.code === "STALE_HANDOFF") {
        blockers.push("STALE_HANDOFF: reviewed facts drifted from the immutable Handoff.");
      } else {
        throw error;
      }
    }
    // Runtime digest parity is the Release Readiness stand-in for check:dist.
    if (observation.facts.runtimeManifestDigest !== handoff.runtime_manifest_digest) {
      blockers.push("check:dist runtime manifest is stale relative to the Handoff.");
    }
  }

  return {
    handoff,
    blockers,
    pendingReleaseGates: handoff.release_required_gates,
    allowedActions: handoff.recommended_release_actions,
  };
}

async function requireFreshHandoff(workspace: string, loopId: LoopId, handoffDigest: Digest): Promise<FinalHandoff> {
  const { handoff, blockers } = await assertHandoffReady(workspace, loopId);
  if (blockers.length > 0) {
    const stale = blockers.some((blocker) => blocker.includes("STALE_HANDOFF"));
    throw new LoopError(
      stale ? "STALE_HANDOFF" : "AUTHORIZATION_REQUIRED",
      stale ? "STALE_HANDOFF: reviewed facts drifted from the immutable Handoff." : "Release preconditions are not satisfied.",
      { blockers },
    );
  }
  if (handoff.digest !== handoffDigest) {
    throw new LoopError("STALE_HANDOFF", "STALE_HANDOFF: Action Envelope Handoff digest no longer matches.", {
      expected: handoffDigest,
      actual: handoff.digest,
    });
  }
  return handoff;
}

/** Read-only readiness: never creates Release files or mutates the repository. */
export async function checkReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  const loopId = parseLoopId(input.loopId);
  const { handoff, blockers, pendingReleaseGates, allowedActions } = await assertHandoffReady(input.workspace, loopId);
  return {
    loopId,
    handoffDigest: handoff.digest,
    ready: blockers.length === 0,
    blockers,
    pendingReleaseGates,
    allowedActions,
  };
}

export async function createRelease(input: ReleaseInput): Promise<ReleaseRecord> {
  const loopId = parseLoopId(input.loopId);
  const handoff = await readHandoff(input.workspace, loopId);
  if (handoff === null) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "Final Handoff is required to create a Release.");
  }

  const releaseId = input.releaseId ?? `release-${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
  const directory = releaseDirectory(input.workspace, releaseId);
  await mkdir(join(directory, "operations"), { recursive: true });
  await mkdir(join(directory, "envelopes"), { recursive: true });

  const createdAt = nowIso();
  let release = digestReleaseContent({
    schema_version: 1,
    release_id: releaseId,
    loop_id: loopId,
    handoff_digest: handoff.digest,
    phase: "NEW",
    action_envelope_digests: [],
    operation_ids: [],
    created_at: createdAt,
    updated_at: createdAt,
    release_commit_sha: null,
  });
  await writeRelease(input.workspace, release);

  release = withReleasePhase(release, "VALIDATING_HANDOFF");
  await writeRelease(input.workspace, release);

  const readiness = await checkReadiness({ workspace: input.workspace, loopId });
  if (!readiness.ready) {
    release = withReleasePhase(release, "BLOCKED");
    await writeRelease(input.workspace, release);
    const stale = readiness.blockers.some((blocker) => blocker.includes("STALE_HANDOFF"));
    throw new LoopError(
      stale ? "STALE_HANDOFF" : "AUTHORIZATION_REQUIRED",
      stale ? "STALE_HANDOFF: reviewed facts drifted from the immutable Handoff." : "Release cannot start until readiness blockers are cleared.",
      { blockers: readiness.blockers },
    );
  }
  if (readiness.handoffDigest !== handoff.digest) {
    release = withReleasePhase(release, "BLOCKED");
    await writeRelease(input.workspace, release);
    throw new LoopError("STALE_HANDOFF", "STALE_HANDOFF: Handoff digest changed during Release validation.", {
      expected: handoff.digest,
      actual: readiness.handoffDigest,
    });
  }

  release = withReleasePhase(release, "READY");
  await writeRelease(input.workspace, release);

  const harness = digestHarnessContent({
    schema_version: 1,
    kind: "RELEASE",
    release_id: releaseId,
    loop_id: loopId,
    handoff_digest: handoff.digest,
    allowed_actions: [...handoff.recommended_release_actions],
    allowed_targets: [...input.allowedTargets],
    allowed_tools: [...RELEASE_READ_ONLY_TOOLS],
    expires_at: input.expiresAt,
  });
  const harnessFile = releaseHarnessPath(input.workspace, releaseId);
  await atomicWriteJson(harnessFile, harness);
  try {
    await chmod(harnessFile, 0o444);
  } catch {
    // Best-effort immutability on hosts that support POSIX modes.
  }
  return release;
}

export async function createActionEnvelope(input: ActionRequest): Promise<ActionEnvelope> {
  const loopId = parseLoopId(input.loopId);
  const release = await readRelease(input.workspace, input.releaseId);
  if (release.loop_id !== loopId) {
    throw new LoopError("INVALID_LOOP_ID", "Release does not belong to the requested Loop.", {
      release_id: input.releaseId,
      loop_id: loopId,
    });
  }
  if (ENVELOPE_FORBIDDEN_PHASES.has(release.phase)) {
    throw new LoopError(
      "AUTHORIZATION_REQUIRED",
      "AUTHORIZATION_REQUIRED: Action Envelope cannot be created while the Release is blocked, cancelled, or in-flight.",
      { phase: release.phase, release_id: release.release_id },
    );
  }
  if (
    input.action === "commit"
    && (release.phase === "RELEASED" || release.release_commit_sha !== null)
  ) {
    throw new LoopError(
      "AUTHORIZATION_REQUIRED",
      "AUTHORIZATION_REQUIRED: commit Action Envelope cannot be created after the Release Commit is bound.",
      {
        phase: release.phase,
        release_id: release.release_id,
        release_commit_sha: release.release_commit_sha,
      },
    );
  }
  const handoff = await requireFreshHandoff(input.workspace, loopId, release.handoff_digest);
  const now = new Date();
  const harness = validateSchema<ReleaseHarness>(
    "release-harness",
    JSON.parse(await readFile(releaseHarnessPath(input.workspace, input.releaseId), "utf8")),
  );
  if (!harness.allowed_actions.includes(input.action)) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "Action is not allowed by the Release Harness.", {
      action: input.action,
    });
  }
  if (!harness.allowed_targets.includes(input.target)) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "Target is not allowed by the Release Harness.", {
      target: input.target,
    });
  }
  assertHarnessUnexpired(harness, now);
  if (input.authorization.action !== input.action || input.authorization.target !== input.target) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: authorization action/target must match the envelope.", {
      authorization_action: input.authorization.action,
      authorization_target: input.authorization.target,
    });
  }
  if (Date.parse(input.authorization.expires_at) <= now.getTime()) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: scoped authorization has expired.", {
      expires_at: input.authorization.expires_at,
    });
  }

  const operationId = `operation-${randomUUID()}`;
  const headSha = await git(input.workspace, ["rev-parse", "HEAD"]);
  let envelope: ActionEnvelope;

  if (input.action === "commit") {
    const branch = input.branch ?? input.target;
    const metadata = commitMetadata(handoff.digest, branch);
    envelope = validateSchema<CommitActionEnvelope>("action-envelope", {
      schema_version: 1,
      operation_id: operationId,
      release_id: input.releaseId,
      handoff_digest: handoff.digest,
      target: input.target,
      source_head_sha: handoff.source_head_sha,
      reviewed_tree_digest: handoff.reviewed_tree_digest,
      authorization: input.authorization,
      metadata_digest: sha256Hex(canonicalJsonBytes(metadata)),
      action: "commit",
      expected_parent_sha: headSha,
      branch,
    });
  } else if (EXTERNAL_ACTIONS.has(input.action)) {
    const releaseCommitSha = input.releaseCommitSha ?? release.release_commit_sha;
    if (releaseCommitSha === null || releaseCommitSha === undefined) {
      throw new LoopError("AUTHORIZATION_REQUIRED", "External actions require a verified Release Commit.", {
        action: input.action,
      });
    }
    envelope = validateSchema<ActionEnvelope>("action-envelope", {
      schema_version: 1,
      operation_id: operationId,
      release_id: input.releaseId,
      handoff_digest: handoff.digest,
      target: input.target,
      source_head_sha: handoff.source_head_sha,
      reviewed_tree_digest: handoff.reviewed_tree_digest,
      authorization: input.authorization,
      metadata_digest: sha256Hex(canonicalJsonBytes({ action: input.action, target: input.target })),
      action: input.action,
      release_commit_sha: releaseCommitSha,
    });
  } else if (PHYSICAL_ACTIONS.has(input.action)) {
    const releaseCommitSha = input.releaseCommitSha ?? release.release_commit_sha;
    if (releaseCommitSha === null || releaseCommitSha === undefined) {
      throw new LoopError("AUTHORIZATION_REQUIRED", "Physical actions require a verified Release Commit.", {
        action: input.action,
      });
    }
    const environmentNode = input.environmentNode ?? input.authorization.environment_node;
    if (
      environmentNode !== "HIL"
      && environmentNode !== "BENCH"
      && environmentNode !== "CLOSED_COURSE"
      && environmentNode !== "REAL_VEHICLE_ROBOT"
    ) {
      throw new LoopError("AUTHORIZATION_REQUIRED", "Physical actions require a physical environment node.");
    }
    envelope = validateSchema<PhysicalActionEnvelope>("action-envelope", {
      schema_version: 1,
      operation_id: operationId,
      release_id: input.releaseId,
      handoff_digest: handoff.digest,
      target: input.target,
      source_head_sha: handoff.source_head_sha,
      reviewed_tree_digest: handoff.reviewed_tree_digest,
      authorization: input.authorization,
      metadata_digest: sha256Hex(canonicalJsonBytes({ action: input.action, target: input.target, environment_node: environmentNode })),
      action: input.action,
      release_commit_sha: releaseCommitSha,
      environment_node: environmentNode,
    });
  } else {
    throw new LoopError("SCHEMA_INVALID", "Unsupported Release action.", { action: input.action });
  }

  await mkdir(join(releaseDirectory(input.workspace, input.releaseId), "envelopes"), { recursive: true });
  await atomicWriteJson(envelopePath(input.workspace, input.releaseId, operationId), envelope);

  const updated = withReleasePhase(release, "AWAITING_AUTHORIZATION", {
    action_envelope_digests: [...release.action_envelope_digests, envelopeDigest(envelope)],
    operation_ids: [...release.operation_ids, operationId],
    // Preserve a bound Release Commit across post-commit envelope creation.
    release_commit_sha: release.release_commit_sha,
  });
  await writeRelease(input.workspace, updated);
  return envelope;
}

/** Verify scoped authorization matches the envelope action/target and is unexpired. */
export function assertScopedAuthorization(envelope: ActionEnvelope, now: Date): void {
  const auth = envelope.authorization;
  if (auth.action !== envelope.action) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: authorization action mismatch.");
  }
  if (auth.target !== envelope.target) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: authorization target mismatch.");
  }
  if (auth.authorized_by.trim() === "") {
    throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: authorizer is required.");
  }
  if (Date.parse(auth.expires_at) <= now.getTime()) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: scoped authorization has expired.", {
      expires_at: auth.expires_at,
    });
  }
  if (PHYSICAL_ACTIONS.has(envelope.action)) {
    const physical = envelope as PhysicalActionEnvelope;
    if (auth.environment_node !== physical.environment_node) {
      throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: authorization environment_node mismatch.");
    }
  }
}

export function assertPhysicalAuthorization(envelope: ActionEnvelope, now: Date): void {
  if (!PHYSICAL_ACTIONS.has(envelope.action)) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "AUTHORIZATION_REQUIRED: envelope is not a physical action.");
  }
  assertScopedAuthorization(envelope, now);
}

function idempotencyKey(envelope: ActionEnvelope): string {
  return sha256Hex(canonicalJsonBytes({
    release_id: envelope.release_id,
    action: envelope.action,
    target: envelope.target,
    handoff_digest: envelope.handoff_digest,
    reviewed_tree_digest: envelope.reviewed_tree_digest,
    metadata_digest: envelope.metadata_digest,
    operation_id: envelope.operation_id,
  }));
}

export async function recordOperationIntent(input: OperationIntentInput): Promise<OperationRecord> {
  const existing = await readOperation(input.workspace, input.envelope.release_id, input.envelope.operation_id);
  if (existing !== null) {
    const suppliedDigest = envelopeDigest(input.envelope);
    if (existing.envelope_digest !== suppliedDigest) {
      throw new LoopError(
        "SCHEMA_INVALID",
        "Operation Intent envelope_digest does not match the supplied Action Envelope.",
        {
          operation_id: existing.operation_id,
          existing: existing.envelope_digest,
          supplied: suppliedDigest,
        },
      );
    }
    return existing;
  }
  const createdAt = nowIso();
  const record: OperationRecord = {
    schema_version: 1,
    operation_id: input.envelope.operation_id,
    release_id: input.envelope.release_id,
    action: input.envelope.action,
    target: input.envelope.target,
    handoff_digest: input.envelope.handoff_digest,
    envelope_digest: envelopeDigest(input.envelope),
    idempotency_key: idempotencyKey(input.envelope),
    status: "PENDING",
    result_ref: null,
    created_at: createdAt,
    updated_at: createdAt,
    reconciled_at: null,
  };
  return writeOperation(input.workspace, record);
}

export async function markOperationUnknown(input: ReconcileInput): Promise<OperationRecord> {
  const existing = await readOperation(input.workspace, input.releaseId, input.operationId);
  if (existing === null) {
    throw new LoopError("RECONCILE_REQUIRED", "Operation Intent was not found.", { operation_id: input.operationId });
  }
  if (existing.status === "SUCCESS" || existing.status === "FAILED") {
    return existing;
  }
  return writeOperation(input.workspace, {
    ...existing,
    status: "UNKNOWN",
    updated_at: nowIso(),
  });
}

async function currentTreeDigest(workspace: string): Promise<Digest> {
  const tree = await buildTreeManifest({
    root: workspace,
    include: [],
    exclusions: [...CONTROL_EXCLUSIONS],
  });
  return tree.digest;
}

async function parentOfHead(workspace: string): Promise<string | null> {
  try {
    return await git(workspace, ["rev-parse", "HEAD^"]);
  } catch {
    return null;
  }
}

export async function reconcileOperation(input: ReconcileInput): Promise<OperationRecord> {
  const existing = await readOperation(input.workspace, input.releaseId, input.operationId);
  if (existing === null) {
    throw new LoopError("RECONCILE_REQUIRED", "Operation Intent was not found.", { operation_id: input.operationId });
  }
  if (existing.status === "FAILED") {
    return existing;
  }
  if (existing.status === "SUCCESS") {
    if (existing.result_ref !== null) {
      const release = await readRelease(input.workspace, input.releaseId);
      await healReleaseAfterSuccess(
        input.workspace,
        release,
        input.operationId,
        existing.result_ref,
      );
    }
    return existing;
  }

  let release = await readRelease(input.workspace, input.releaseId);
  if (existing.status === "UNKNOWN" && release.phase !== "RELEASED" && release.phase !== "CANCELLED") {
    release = withReleasePhase(release, "RECONCILING");
    await writeRelease(input.workspace, release);
  }

  let envelope: ActionEnvelope;
  try {
    envelope = await loadImmutableEnvelope(input.workspace, input.releaseId, input.operationId);
  } catch (error) {
    throw new LoopError("RECONCILE_REQUIRED", "Action Envelope could not be loaded for reconcile.", {
      operation_id: input.operationId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const head = await git(input.workspace, ["rev-parse", "HEAD"]);
  const treeDigest = await currentTreeDigest(input.workspace);
  release = await readRelease(input.workspace, input.releaseId);
  const now = nowIso();

  if (envelope.action === "commit") {
    const commitEnvelope = envelope;
    const parent = await parentOfHead(input.workspace);
    const headMatchesTree = treeDigest === commitEnvelope.reviewed_tree_digest;
    const alreadyCommitted = headMatchesTree && (
      head === commitEnvelope.expected_parent_sha
      || parent === commitEnvelope.expected_parent_sha
      || release.release_commit_sha === head
      || existing.result_ref === head
    );
    if (alreadyCommitted && (
      parent === commitEnvelope.expected_parent_sha
      || release.release_commit_sha === head
      || existing.result_ref === head
    )) {
      const succeeded = await writeOperation(input.workspace, {
        ...existing,
        status: "SUCCESS",
        result_ref: head,
        updated_at: now,
        reconciled_at: now,
      });
      await healReleaseAfterSuccess(input.workspace, release, input.operationId, head);
      return succeeded;
    }
    // No external evidence of completion — authorize a single retry via READY_TO_RETRY.
    return writeOperation(input.workspace, {
      ...existing,
      status: "READY_TO_RETRY",
      updated_at: now,
      reconciled_at: now,
    });
  }

  if (release.release_commit_sha !== null && EXTERNAL_ACTIONS.has(envelope.action)) {
    // External actions are simulated: SUCCESS when Release Commit is bound and Intent existed.
    if (existing.result_ref !== null) {
      return writeOperation(input.workspace, {
        ...existing,
        status: "SUCCESS",
        updated_at: now,
        reconciled_at: now,
      });
    }
  }

  // Clear UNKNOWN/PENDING for a single authorized retry after reconcile.
  return writeOperation(input.workspace, {
    ...existing,
    status: "READY_TO_RETRY",
    updated_at: now,
    reconciled_at: now,
  });
}

export async function executeCommit(input: ExecuteCommitInput): Promise<CommitResult> {
  const { workspace } = input;
  if (input.envelope.action !== "commit") {
    throw new LoopError("SCHEMA_INVALID", "executeCommit requires a commit Action Envelope.");
  }

  // Prefer the on-disk immutable envelope over the caller-supplied object.
  const onDisk = await loadImmutableEnvelope(workspace, input.envelope.release_id, input.envelope.operation_id);
  if (onDisk.action !== "commit") {
    throw new LoopError("SCHEMA_INVALID", "On-disk Action Envelope is not a commit action.", {
      action: onDisk.action,
    });
  }
  if (envelopeDigest(onDisk) !== envelopeDigest(input.envelope)) {
    throw new LoopError(
      "SCHEMA_INVALID",
      "Caller-supplied Action Envelope drifted from the on-disk immutable envelope.",
      {
        operation_id: input.envelope.operation_id,
        on_disk: envelopeDigest(onDisk),
        supplied: envelopeDigest(input.envelope),
      },
    );
  }
  const envelope = onDisk;
  const now = new Date();
  await assertHarnessBinding(workspace, envelope.release_id, envelope, now);
  assertScopedAuthorization(envelope, now);

  let release = await readRelease(workspace, envelope.release_id);
  await requireFreshHandoff(workspace, release.loop_id, envelope.handoff_digest);

  // Pre-existing PENDING/UNKNOWN Intent from a prior crash/call must be reconciled first.
  // Reconcile is the sole producer of READY_TO_RETRY authorization for a one-shot retry.
  const preexisting = await readOperation(workspace, envelope.release_id, envelope.operation_id);
  if (
    preexisting !== null
    && (preexisting.status === "PENDING" || preexisting.status === "UNKNOWN")
  ) {
    throw new LoopError("RECONCILE_REQUIRED", "PENDING/UNKNOWN operations must be reconciled before retry.", {
      operation_id: preexisting.operation_id,
      status: preexisting.status,
    });
  }

  let operation = await recordOperationIntent({ workspace, envelope });
  if (operation.status === "SUCCESS" && operation.result_ref !== null) {
    release = await healReleaseAfterSuccess(
      workspace,
      release,
      envelope.operation_id,
      operation.result_ref,
    );
    return {
      commitSha: operation.result_ref,
      treeDigest: envelope.reviewed_tree_digest,
      parentSha: envelope.expected_parent_sha,
      idempotent: true,
    };
  }
  if (operation.status === "FAILED") {
    throw new LoopError("RECONCILE_REQUIRED", "FAILED operations cannot be retried without a new Action Envelope.", {
      operation_id: operation.operation_id,
    });
  }
  // Consume one-shot reconcile authorization before mutating.
  if (operation.status === "READY_TO_RETRY") {
    operation = await writeOperation(workspace, {
      ...operation,
      status: "PENDING",
      updated_at: nowIso(),
    });
  }

  const metadata = commitMetadata(envelope.handoff_digest, envelope.branch);
  if (sha256Hex(canonicalJsonBytes(metadata)) !== envelope.metadata_digest) {
    throw new LoopError("SCHEMA_INVALID", "Commit metadata digest does not match the Action Envelope.");
  }

  if (release.phase !== "RELEASED" && release.phase !== "EXECUTING") {
    release = withReleasePhase(release, "EXECUTING");
    await writeRelease(workspace, release);
  }

  // Exclude concurrent Dispatch integration while packaging the Release Commit.
  // Limitation: only the integration/"tree" lease is held for the mutate critical section;
  // path-level leases matching individual packaging pathspecs are not reserved.
  const coordinator = await openRepositoryCoordinator(workspace);
  const lease = await coordinator.reserve({
    loopId: release.loop_id,
    kind: "integration",
    resources: ["tree"],
    ttlMs: 60_000,
  });
  try {
    const head = await git(workspace, ["rev-parse", "HEAD"]);
    const treeDigest = await currentTreeDigest(workspace);
    const headTree = await git(workspace, ["rev-parse", "HEAD^{tree}"]);
    const indexTree = await git(workspace, ["write-tree"]);
    const indexAlreadyCommitted = headTree === indexTree;

    if (treeDigest === envelope.reviewed_tree_digest && indexAlreadyCommitted) {
      const parent = await parentOfHead(workspace);
      const alreadyPackaged = head === envelope.expected_parent_sha
        || parent === envelope.expected_parent_sha
        || release.release_commit_sha === head
        || operation.result_ref === head;
      if (alreadyPackaged) {
        operation = await writeOperation(workspace, {
          ...operation,
          status: "SUCCESS",
          result_ref: head,
          updated_at: nowIso(),
        });
        // Bind RELEASED immediately after SUCCESS Intent to narrow the crash window.
        await healReleaseAfterSuccess(workspace, release, envelope.operation_id, head);
        return {
          commitSha: head,
          treeDigest,
          parentSha: envelope.expected_parent_sha,
          idempotent: true,
        };
      }
    }

    if (head !== envelope.expected_parent_sha) {
      throw new LoopError("CAS_MISMATCH", "HEAD does not match the Action Envelope expected parent SHA.", {
        head,
        expected_parent_sha: envelope.expected_parent_sha,
      });
    }

    // Stage tracked updates without rewriting file bytes. Pathspecs are optional when absent.
    await git(workspace, ["add", "-u"]);
    for (const pathspec of ["src", "schemas", "assets", "package.json", "package-lock.json"] as const) {
      try {
        await git(workspace, ["add", "--", pathspec]);
      } catch {
        // Sparse test workspaces may omit optional product roots.
      }
    }
    const stagedTree = await currentTreeDigest(workspace);
    if (stagedTree !== envelope.reviewed_tree_digest) {
      throw new LoopError("STALE_HANDOFF", "STALE_HANDOFF: staged Tree drifted from the reviewed Tree digest.", {
        staged: stagedTree,
        reviewed: envelope.reviewed_tree_digest,
      });
    }

    await git(workspace, [
      "-c", "user.name=PAI Loop Engineering",
      "-c", "user.email=pai-loop-engineering@example.invalid",
      "commit",
      "-m", metadata.message,
    ]);
    const commitSha = await git(workspace, ["rev-parse", "HEAD"]);
    const committedTree = await currentTreeDigest(workspace);
    if (committedTree !== envelope.reviewed_tree_digest) {
      throw new LoopError("STALE_HANDOFF", "STALE_HANDOFF: committed Tree drifted from the reviewed Tree digest.", {
        committed: committedTree,
        reviewed: envelope.reviewed_tree_digest,
      });
    }

    await writeOperation(workspace, {
      ...operation,
      status: "SUCCESS",
      result_ref: commitSha,
      updated_at: nowIso(),
    });
    // Bind RELEASED immediately after SUCCESS Intent to narrow the crash window.
    await healReleaseAfterSuccess(workspace, release, envelope.operation_id, commitSha);

    return {
      commitSha,
      treeDigest: committedTree,
      parentSha: envelope.expected_parent_sha,
      idempotent: false,
    };
  } finally {
    try {
      await coordinator.release(lease.leaseId);
    } catch {
      // Integration lease may already be reconciled.
    }
  }
}

/** High-level CLI helper: create Release (if needed), envelope, intent, and execute commit. */
export async function performReleaseAction(input: {
  workspace: string;
  loopId: LoopId;
  action: ReleaseAction;
  target: string;
  authorization: ScopedAuthorization;
  releaseId?: string;
  branch?: string;
  environmentNode?: PhysicalActionEnvelope["environment_node"];
}): Promise<{
  release: ReleaseRecord;
  envelope: ActionEnvelope;
  commit?: CommitResult;
  operation: OperationRecord;
}> {
  const loopId = parseLoopId(input.loopId);
  let release: ReleaseRecord;
  if (input.releaseId !== undefined) {
    release = await readRelease(input.workspace, input.releaseId);
  } else {
    release = await createRelease({
      workspace: input.workspace,
      loopId,
      allowedTargets: [input.target],
      expiresAt: input.authorization.expires_at,
    });
  }

  const envelopeRequest: ActionRequest = {
    workspace: input.workspace,
    loopId,
    releaseId: release.release_id,
    action: input.action,
    target: input.target,
    authorization: input.authorization,
  };
  if (input.branch !== undefined) envelopeRequest.branch = input.branch;
  if (input.environmentNode !== undefined) envelopeRequest.environmentNode = input.environmentNode;
  const envelope = await createActionEnvelope(envelopeRequest);

  if (envelope.action === "commit") {
    // Intent is created inside executeCommit so a pre-existing PENDING is distinguishable.
    const commit = await executeCommit({ workspace: input.workspace, envelope });
    const completed = await readOperation(input.workspace, release.release_id, envelope.operation_id);
    if (completed === null) {
      throw new LoopError("RECONCILE_REQUIRED", "Operation Intent was not recorded after commit.", {
        operation_id: envelope.operation_id,
      });
    }
    return {
      release: await readRelease(input.workspace, release.release_id),
      envelope,
      commit,
      operation: completed,
    };
  }

  const operation = await recordOperationIntent({ workspace: input.workspace, envelope });

  if (PHYSICAL_ACTIONS.has(envelope.action)) {
    assertPhysicalAuthorization(envelope, new Date());
  }

  // External/physical execution is intentionally stubbed; Intent + Reconcile remain real.
  return {
    release: await readRelease(input.workspace, release.release_id),
    envelope,
    operation,
  };
}
