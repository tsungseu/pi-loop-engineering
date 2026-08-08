import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  LoopError,
  sha256Hex,
  type Digest,
  type LoopId,
  type LoopPhase,
  type LoopStatus,
} from "../contracts/domain.js";
import type { H0Harness, H1Harness } from "../contracts/harness.js";
import type {
  Checkpoint,
  FinalHandoff,
  ReleaseAction,
  RollbackPlan,
} from "../contracts/release.js";
import { atomicWriteJson, canonicalJsonBytes } from "./atomic-json.js";
import {
  assertFinalizeGates,
  evaluateGate,
  forgeH0,
  summarizeEnvironmentGates,
  type HarnessFacts,
} from "./harness.js";
import { GENESIS_DIGEST, openLedger, type LoopSnapshot } from "./ledger.js";
import {
  CONTROL_EXCLUSIONS,
  buildRuntimeManifest,
  buildSourceManifest,
  buildTreeManifest,
  buildWorkspaceManifest,
} from "./manifests.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "./paths.js";
import {
  listFindings,
  readPersistedVerdict,
  type FindingSummary,
} from "./review.js";
import { validateSchema } from "./schema.js";

export type FinalizeFaultPoint =
  | "after-pending-write"
  | "after-pending-rename"
  | "after-handoff-commit"
  | "before-phase-transition"
  | "after-phase-transition";

export interface CheckpointInput {
  workspace: string;
  loopId: LoopId;
  sourceHeadSha: string;
  completedWorkItemIds: readonly string[];
  evidenceIds: readonly string[];
  blocker: string | null;
  resumeEntry: string;
  status?: LoopStatus;
  phase?: LoopPhase;
}

export interface FinalizeInput {
  workspace: string;
  loopId: LoopId;
  actorRole: string;
  sourceHeadSha: string;
  reviewedTreeDigest: Digest;
  workspaceDigest: Digest;
  sourceManifestDigest: Digest;
  runtimeManifestDigest: Digest;
  projectPolicyDigest: Digest | null;
  h0: H0Harness;
  h1: H1Harness;
  loopMarkdownDigest: Digest;
  agentBundleDigests: readonly Digest[];
  evidenceManifestDigest: Digest;
  evidence: HarnessFacts["evidence"];
  residualRisks: readonly string[];
  rollback: RollbackPlan;
  recommendedReleaseActions: readonly ReleaseAction[];
  harnessFacts: HarnessFacts;
  dispatchConsistent: boolean;
  fault?: FinalizeFaultPoint;
}

export interface FreshnessFacts {
  sourceHeadSha: string;
  reviewedTreeDigest: Digest;
  workspaceDigest: Digest;
  sourceManifestDigest: Digest;
  runtimeManifestDigest: Digest;
  projectPolicyDigest: Digest | null;
  h1Digest: Digest;
  loopMarkdownDigest: Digest;
  evidenceManifestDigest: Digest;
}

export type FreshnessObservation =
  | { kind: "OBSERVED"; facts: FreshnessFacts }
  | { kind: "UNKNOWN"; reason: string };

function gitRevParseHead(workspace: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", workspace, "rev-parse", "HEAD"], {
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
        rejectPromise(new Error(Buffer.concat(stderr).toString("utf8") || `git rev-parse exited ${code}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

export async function digestEvidenceIndex(evidenceRoot: string): Promise<Digest> {
  const entries: { path: string; digest: Digest }[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    let listing;
    try {
      listing = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of listing.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        entries.push({ path: relative.replace(/\\/gu, "/"), digest: sha256Hex(await readFile(absolute)) });
      }
    }
  }
  await walk(evidenceRoot, "");
  return sha256Hex(canonicalJsonBytes({ schema_version: 1, kind: "evidence-index", entries }));
}

async function readProjectPolicyDigest(layout: LoopLayout): Promise<Digest | null> {
  try {
    const value = JSON.parse(await readFile(layout.projectPolicyJson, "utf8")) as { digest?: string };
    if (typeof value.digest === "string" && /^[0-9a-f]{64}$/u.test(value.digest)) {
      return value.digest as Digest;
    }
    return sha256Hex(await readFile(layout.projectPolicyJson));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Read-only observation of freshness-covered facts for status/Release checks. */
export async function observeHandoffFreshnessFacts(
  workspace: string,
  loopId: LoopId,
): Promise<FreshnessObservation> {
  const layout = resolveLayout(workspace, loopId);
  try {
    let snapshot: LoopSnapshot;
    try {
      snapshot = validateSchema<LoopSnapshot>("loop", JSON.parse(await readFile(layout.loopJson, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "UNKNOWN", reason: "LOOP.json is missing." };
      }
      throw error;
    }
    if (snapshot.current_harness_digest === null) {
      return { kind: "UNKNOWN", reason: "No sealed H1 digest is available." };
    }
    let loopMarkdownDigest: Digest;
    try {
      loopMarkdownDigest = sha256Hex(await readFile(layout.loopMarkdown));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "UNKNOWN", reason: "LOOP.md is missing." };
      }
      throw error;
    }
    let sourceHeadSha: string;
    try {
      sourceHeadSha = await gitRevParseHead(layout.workspaceRoot);
    } catch (error) {
      return {
        kind: "UNKNOWN",
        reason: `Source HEAD could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!/^[0-9a-f]{40,64}$/u.test(sourceHeadSha)) {
      return { kind: "UNKNOWN", reason: "Source HEAD SHA is malformed." };
    }

    const manifestRoot = layout.workspaceRoot;
    const [sourceManifest, treeManifest, workspaceManifest, runtimeManifest, projectPolicyDigest, evidenceManifestDigest] = await Promise.all([
      buildSourceManifest({ root: manifestRoot, include: [], exclusions: [...CONTROL_EXCLUSIONS], declaredArtifacts: [] }),
      buildTreeManifest({ root: manifestRoot, include: [], exclusions: [...CONTROL_EXCLUSIONS] }),
      buildWorkspaceManifest({ root: manifestRoot, include: ["**"], exclusions: [...CONTROL_EXCLUSIONS], declaredArtifacts: [] }),
      buildRuntimeManifest(manifestRoot),
      readProjectPolicyDigest(layout),
      digestEvidenceIndex(layout.evidenceRoot),
    ]);

    return {
      kind: "OBSERVED",
      facts: {
        sourceHeadSha,
        reviewedTreeDigest: treeManifest.digest,
        workspaceDigest: workspaceManifest.digest,
        sourceManifestDigest: sourceManifest.digest,
        runtimeManifestDigest: runtimeManifest.digest,
        projectPolicyDigest,
        h1Digest: snapshot.current_harness_digest,
        loopMarkdownDigest,
        evidenceManifestDigest,
      },
    };
  } catch (error) {
    return {
      kind: "UNKNOWN",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ChildLoopInput {
  workspace: string;
  parentLoopId: LoopId;
  reason: string;
  task: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function nextCheckpointSequence(layout: LoopLayout): Promise<number> {
  await mkdir(layout.checkpointsRoot, { recursive: true });
  let entries: string[];
  try {
    entries = await readdir(layout.checkpointsRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 1;
    throw error;
  }
  let max = 0;
  for (const entry of entries) {
    const match = /^(\d+)\.json$/u.exec(entry);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export async function writeCheckpoint(input: CheckpointInput): Promise<Checkpoint> {
  if (input.resumeEntry.trim() === "") {
    throw new LoopError("SCHEMA_INVALID", "A checkpoint resume entry is required.");
  }
  const layout = resolveLayout(input.workspace, input.loopId);
  const ledger = await openLedger(layout);
  const snapshot = await ledger.snapshot();
  const sequence = await nextCheckpointSequence(layout);
  const status = input.status ?? snapshot.status;
  const phase = input.phase ?? snapshot.phase;
  const committed = await ledger.transact("CHECKPOINT", await ledger.cursor(), async () => {
    const content = {
      schema_version: 1 as const,
      loop_id: input.loopId,
      sequence,
      phase,
      status,
      source_head_sha: input.sourceHeadSha,
      completed_work_item_ids: [...input.completedWorkItemIds],
      evidence_ids: [...input.evidenceIds],
      blocker: input.blocker,
      resume_entry: input.resumeEntry,
    };
    const checkpoint = validateSchema<Checkpoint>("checkpoint", {
      ...content,
      digest: sha256Hex(canonicalJsonBytes(content)),
    });
    await atomicWriteJson(join(layout.checkpointsRoot, `${sequence}.json`), checkpoint);
    return checkpoint;
  });
  return committed.artifact;
}

function openCriticalOrHigh(findings: readonly FindingSummary[]): FindingSummary[] {
  return findings.filter((finding) =>
    (finding.severity === "CRITICAL" || finding.severity === "HIGH")
    && finding.status !== "VERIFIED"
    && finding.status !== "WONT_FIX");
}

function buildHandoffContent(
  input: FinalizeInput,
  snapshot: LoopSnapshot,
  releaseRequiredGates: readonly string[],
): Omit<FinalHandoff, "digest"> {
  return {
    schema_version: 1,
    loop_id: input.loopId,
    markdown_language: snapshot.markdown_language,
    source_head_sha: input.sourceHeadSha,
    reviewed_tree_digest: input.reviewedTreeDigest,
    workspace_digest: input.workspaceDigest,
    source_manifest_digest: input.sourceManifestDigest,
    runtime_manifest_digest: input.runtimeManifestDigest,
    project_policy_digest: input.projectPolicyDigest,
    h0_digest: input.h0.digest,
    h1_revision: input.h1.revision,
    h1_digest: input.h1.digest,
    loop_markdown_digest: input.loopMarkdownDigest,
    agent_bundle_digests: [...input.agentBundleDigests],
    evidence_manifest_digest: input.evidenceManifestDigest,
    review_verdict: "PASS",
    residual_risks: [...input.residualRisks],
    rollback: {
      target: input.rollback.target,
      procedure: [...input.rollback.procedure],
      triggers: [...input.rollback.triggers],
      estimated_recovery_minutes: input.rollback.estimated_recovery_minutes,
    },
    release_required_gates: [...releaseRequiredGates],
    recommended_release_actions: [...input.recommendedReleaseActions],
    finalize_event_sequence: snapshot.last_event_sequence + 2,
  };
}

async function quarantineOrphanedHandoffArtifacts(layout: LoopLayout): Promise<readonly string[]> {
  const quarantineDir = join(layout.loopRoot, "quarantine");
  await mkdir(quarantineDir, { recursive: true });
  const candidates = [layout.handoffJson];
  try {
    for (const entry of await readdir(layout.loopRoot)) {
      if (entry.startsWith("handoff.pending.") && entry.endsWith(".json")) {
        candidates.push(join(layout.loopRoot, entry));
      }
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const quarantined: string[] = [];
  for (const path of candidates) {
    try {
      const destination = join(quarantineDir, `${basename(path)}.quarantine-${randomUUID()}`);
      await rename(path, destination);
      quarantined.push(destination);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
  }
  return quarantined;
}

async function assertFinalizable(input: FinalizeInput, layout: LoopLayout): Promise<{
  snapshot: LoopSnapshot;
  releaseRequiredGates: readonly string[];
}> {
  const ledger = await openLedger(layout);
  const snapshot = await ledger.snapshot();
  // Immutability is bound to the committed ledger pointer, not bare file presence.
  if (snapshot.handoff_digest !== null) {
    throw new LoopError("INVALID_TRANSITION", "Final Handoff is immutable and cannot be overwritten.", {
      handoff_digest: snapshot.handoff_digest,
    });
  }
  if (snapshot.phase !== "FINALIZING" || snapshot.status !== "ACTIVE") {
    throw new LoopError("INVALID_TRANSITION", "Finalize requires an ACTIVE FINALIZING Loop.", {
      phase: snapshot.phase,
      status: snapshot.status,
    });
  }
  // Bare handoff.json / pending files without a ledger pointer are orphans — quarantine and retry.
  await quarantineOrphanedHandoffArtifacts(layout);

  if (snapshot.current_harness_digest !== input.h1.digest) {
    throw new LoopError("HARNESS_DRIFT", "Finalize requires the current sealed H1.", {
      expected: snapshot.current_harness_digest,
      actual: input.h1.digest,
    });
  }
  if (!input.dispatchConsistent) {
    throw new LoopError("HARNESS_DRIFT", "Dispatch state is inconsistent with the sealed Harness.");
  }

  const persistedVerdict = await readPersistedVerdict(input.workspace, input.loopId);
  if (persistedVerdict === null || persistedVerdict.kind !== "PASS") {
    throw new LoopError("AUTHORIZATION_REQUIRED", "Finalize requires a persisted PASS Review verdict.", {
      verdict: persistedVerdict?.kind ?? null,
    });
  }
  const persistedFindings = await listFindings(input.workspace, input.loopId);
  const findingSummaries: FindingSummary[] = persistedFindings.map((finding) => ({
    findingId: finding.findingId,
    status: finding.status,
    severity: finding.severity,
    area: finding.area,
    sourceDigest: finding.sourceDigest,
  }));
  const open = openCriticalOrHigh(findingSummaries);
  if (open.length > 0) {
    throw new LoopError("AUTHORIZATION_REQUIRED", "Finalize requires Critical and High Findings to be closed.", {
      findings: open.map((finding) => finding.findingId),
    });
  }
  assertFinalizeGates(input.h1.environment_gates, input.evidence);
  const gate = evaluateGate({
    harness: input.h1,
    operation: "FINALIZE",
    actorRole: input.actorRole,
    facts: input.harnessFacts,
  });
  if (!gate.allowed) {
    throw new LoopError(gate.code, gate.reason);
  }
  const summary = summarizeEnvironmentGates(input.h1.environment_gates, input.evidence);
  if (input.rollback.procedure.length === 0 || input.rollback.triggers.length === 0) {
    throw new LoopError("SCHEMA_INVALID", "Finalize requires a rollback procedure and triggers.");
  }
  return { snapshot, releaseRequiredGates: summary.releasePending };
}

export async function finalizeHandoff(input: FinalizeInput): Promise<FinalHandoff> {
  const layout = resolveLayout(input.workspace, input.loopId);
  const { snapshot, releaseRequiredGates } = await assertFinalizable(input, layout);
  const ledger = await openLedger(
    layout,
    input.fault === "after-handoff-commit"
      ? {
        fault: (point) => {
          if (point === "after-commit") throw new Error("injected after-handoff-commit");
        },
      }
      : {},
  );

  const content = buildHandoffContent(input, snapshot, releaseRequiredGates);
  // finalize_event_sequence is computed against the live cursor after Intent.
  const committed = await ledger.transact("HANDOFF", await ledger.cursor(), async (transactionId) => {
    const live = await ledger.snapshot();
    const withSequence = {
      ...content,
      finalize_event_sequence: live.last_event_sequence + 2,
    };
    const handoff = validateSchema<FinalHandoff>("handoff", {
      ...withSequence,
      digest: sha256Hex(canonicalJsonBytes(withSequence)),
    });
    const pending = join(layout.loopRoot, `handoff.pending.${transactionId}.json`);
    await mkdir(layout.loopRoot, { recursive: true });
    await writeFile(pending, canonicalJsonBytes(handoff), { flag: "wx" });
    if (input.fault === "after-pending-write") throw new Error("injected after-pending-write");
    await rename(pending, layout.handoffJson);
    if (input.fault === "after-pending-rename") throw new Error("injected after-pending-rename");
    return handoff;
  });

  if (input.fault === "before-phase-transition") throw new Error("injected before-phase-transition");
  await ledger.transition("HANDOFF_READY", "COMPLETE", await ledger.cursor());
  if (input.fault === "after-phase-transition") throw new Error("injected after-phase-transition");
  return committed.artifact;
}

export async function verifyHandoffFreshness(handoff: FinalHandoff, facts: FreshnessFacts): Promise<void> {
  const mismatches: string[] = [];
  if (facts.sourceHeadSha !== handoff.source_head_sha) mismatches.push("source_head_sha");
  if (facts.reviewedTreeDigest !== handoff.reviewed_tree_digest) mismatches.push("reviewed_tree_digest");
  if (facts.workspaceDigest !== handoff.workspace_digest) mismatches.push("workspace_digest");
  if (facts.sourceManifestDigest !== handoff.source_manifest_digest) mismatches.push("source_manifest_digest");
  if (facts.runtimeManifestDigest !== handoff.runtime_manifest_digest) mismatches.push("runtime_manifest_digest");
  if (facts.projectPolicyDigest !== handoff.project_policy_digest) mismatches.push("project_policy_digest");
  if (facts.h1Digest !== handoff.h1_digest) mismatches.push("h1_digest");
  if (facts.loopMarkdownDigest !== handoff.loop_markdown_digest) mismatches.push("loop_markdown_digest");
  if (facts.evidenceManifestDigest !== handoff.evidence_manifest_digest) mismatches.push("evidence_manifest_digest");
  if (mismatches.length > 0) {
    throw new LoopError("STALE_HANDOFF", "STALE_HANDOFF: reviewed facts drifted from the immutable Handoff.", {
      mismatches,
    });
  }
}

function generateChildLoopId(): LoopId {
  const stamp = new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14);
  return parseLoopId(`loop-${stamp}-${randomBytes(5).toString("hex")}`);
}

export async function createChildLoop(input: ChildLoopInput): Promise<LoopSnapshot> {
  if (input.task.trim() === "") {
    throw new LoopError("SCHEMA_INVALID", "A Child Loop task description is required.");
  }
  if (input.reason.trim() === "") {
    throw new LoopError("SCHEMA_INVALID", "A Child Loop reason is required.");
  }
  const parentLayout = resolveLayout(input.workspace, input.parentLoopId);
  const parentLedger = await openLedger(parentLayout);
  const parent = await parentLedger.snapshot();
  if (parent.loop_id !== input.parentLoopId) {
    throw new LoopError("INVALID_LOOP_ID", "Parent Loop identity mismatch.", { loop_id: input.parentLoopId });
  }

  const childId = generateChildLoopId();
  const childLayout = resolveLayout(input.workspace, childId);
  await mkdir(childLayout.loopRoot, { recursive: true });
  await atomicWriteJson(childLayout.loopJson, {
    schema_version: 2,
    loop_id: childId,
    parent_loop_id: input.parentLoopId,
    phase: "NEW",
    status: "ACTIVE",
    markdown_language: parent.markdown_language,
    last_event_sequence: 0,
    last_event_hash: GENESIS_DIGEST,
    current_harness_revision: null,
    current_harness_digest: null,
    handoff_digest: null,
  });

  const childLedger = await openLedger(childLayout);
  const identityRoot = childLayout.workspaceRoot;
  await childLedger.transact("BOOTSTRAP", await childLedger.cursor(), async () => {
    const h0 = await forgeH0({
      loopId: childId,
      repositoryId: sha256Hex(Buffer.from(`pai-loop/repository/v1\0${identityRoot}`, "utf8")),
      repositoryRoot: identityRoot,
      readablePaths: ["**"],
      repositoryRulesDigest: sha256Hex(canonicalJsonBytes({ parent_loop_id: input.parentLoopId, reason: input.reason })),
      exploreCapabilities: ["native-search"],
      networkClass: "DISABLED",
    });
    await mkdir(childLayout.harnessRoot, { recursive: true });
    await atomicWriteJson(join(childLayout.harnessRoot, "h0-discovery.json"), h0);
    return h0;
  });
  return childLedger.transition("ORIENTING", "ACTIVE", await childLedger.cursor());
}

export async function readHandoff(workspace: string, loopId: LoopId): Promise<FinalHandoff | null> {
  const layout = resolveLayout(workspace, loopId);
  try {
    return validateSchema<FinalHandoff>("handoff", JSON.parse(await readFile(layout.handoffJson, "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
