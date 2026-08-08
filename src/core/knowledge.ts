import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LoopError,
  sha256Hex,
  type Digest,
  type LoopId,
  type MarkdownLanguage,
} from "../contracts/domain.js";
import type {
  FinalHandoff,
  KnowledgeProposal,
  KnowledgeProposalStatus,
  ReleasePhase,
  ReleaseRecord,
} from "../contracts/release.js";
import { atomicWriteFile, atomicWriteJson, canonicalJsonBytes } from "./atomic-json.js";
import { readHandoff } from "./handoff.js";
import { openLedger } from "./ledger.js";
import { resolveMarkdownLanguage } from "./markdown.js";
import { parseLoopId, resolveLayout } from "./paths.js";
import { validateSchema } from "./schema.js";

/** Fault injection seam for dual-write crash-safety tests. */
export type ProposalArtifactFaultPoint = "after-markdown";

const ENDED_RELEASE_PHASES = new Set<ReleasePhase>(["RELEASED", "CANCELLED", "BLOCKED"]);

const TRANSITIONS: Readonly<Record<KnowledgeProposalStatus, readonly KnowledgeProposalStatus[]>> = {
  PROVISIONAL: ["REVIEW_PENDING", "REVISE", "REJECTED", "SUPERSEDED"],
  REVIEW_PENDING: ["REVISE", "APPROVED", "REJECTED", "SUPERSEDED"],
  REVISE: ["REVIEW_PENDING", "REJECTED", "SUPERSEDED"],
  APPROVED: ["SUPERSEDED"],
  REJECTED: ["SUPERSEDED"],
  SUPERSEDED: [],
  APPLIED: [],
};

export interface KnowledgeSourceInput {
  workspace: string;
  loopIds: readonly LoopId[];
}

export interface KnowledgeObservation {
  loop_id: LoopId;
  handoff_digest: Digest;
  release_id: string | null;
  release_phase: ReleasePhase | null;
  release_digest: Digest | null;
}

export interface ProposalInput {
  workspace: string;
  observations: readonly KnowledgeObservation[];
  proposal_type: KnowledgeProposal["proposal_type"];
  explicit_user_correction?: boolean;
  correction_provenance?: readonly string[];
  counterexamples?: readonly string[];
  privacy_review: string;
  expected_benefit: string;
  safety_impact: string;
  offline_evaluation: readonly string[];
  canary: readonly string[];
  rollback: readonly string[];
  review_date: string;
  markdown_language?: MarkdownLanguage;
  proposal_id?: string;
  fault?: (point: ProposalArtifactFaultPoint) => void | Promise<void>;
}

export interface ProposalReview {
  privacy_review: string;
  expected_benefit: string;
  safety_impact: string;
  offline_evaluation: readonly string[];
  canary: readonly string[];
  rollback: readonly string[];
  review_date: string;
  counterexamples?: readonly string[];
  correction_provenance?: readonly string[];
  explicit_user_correction?: boolean;
}

export interface ProposalTransition {
  workspace: string;
  proposalId: string;
  to: KnowledgeProposalStatus;
  review: ProposalReview;
  fault?: (point: ProposalArtifactFaultPoint) => void | Promise<void>;
}

export interface AppliedInput {
  workspace: string;
  proposalId: string;
  implementationLoopId: LoopId;
}

function proposalMarkdownPath(workspace: string, proposalId: string): string {
  return join(resolveLayout(workspace).knowledgeProposalsRoot, `${proposalId}.md`);
}

function proposalJsonPath(workspace: string, proposalId: string): string {
  return join(resolveLayout(workspace).knowledgeProposalsRoot, `${proposalId}.json`);
}

function generateProposalId(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14);
  return `proposal-${stamp}-${randomBytes(4).toString("hex")}`;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function list(values: readonly string[], language: MarkdownLanguage): string {
  if (values.length === 0) return language === "zh-CN" ? "- 无。" : "- None.";
  return values.map((value) => `- ${value.replace(/\n/gu, "\n  ")}`).join("\n");
}

function templatePath(language: MarkdownLanguage): string {
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../assets/knowledge", `proposal.${language}.md`),
    resolve(moduleDirectory, "../../../assets/knowledge", `proposal.${language}.md`),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new LoopError("SCHEMA_INVALID", "Knowledge proposal Markdown template was not found.", { language });
  }
  return path;
}

function renderProposalMarkdown(proposal: KnowledgeProposal): string {
  const template = readFileSync(templatePath(proposal.markdown_language), "utf8");
  const language = proposal.markdown_language;
  const replacements: Readonly<Record<string, string>> = {
    proposal_id: proposal.proposal_id,
    status: proposal.status,
    proposal_type: proposal.proposal_type,
    observation_count: String(proposal.observation_count),
    review_date: proposal.review_date,
    source_loop_ids: list(proposal.source_loop_ids, language),
    source_handoff_digests: list(proposal.source_handoff_digests, language),
    correction_provenance: list(proposal.correction_provenance, language),
    counterexamples: list(proposal.counterexamples, language),
    privacy_review: proposal.privacy_review,
    expected_benefit: proposal.expected_benefit,
    safety_impact: proposal.safety_impact,
    offline_evaluation: list(proposal.offline_evaluation, language),
    canary: list(proposal.canary, language),
    rollback: list(proposal.rollback, language),
    implementation_loop_id: proposal.implementation_loop_id ?? (language === "zh-CN" ? "无" : "None"),
  };
  const rendered = template.replace(/\{\{([a-z_]+)\}\}/gu, (placeholder, key: string) => {
    const replacement = replacements[key];
    if (replacement === undefined) {
      throw new LoopError("SCHEMA_INVALID", "Knowledge proposal template contains an unknown placeholder.", {
        placeholder,
      });
    }
    return replacement;
  });
  return `${rendered.replace(/\n*$/u, "")}\n`;
}

function formatFrontMatterValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (/^[A-Za-z0-9._:@/+-]+$/u.test(value) && !value.includes("\n")) return value;
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(value);
}

function serializeFrontMatter(proposal: KnowledgeProposal): string {
  const order: readonly (keyof KnowledgeProposal)[] = [
    "schema_version",
    "proposal_id",
    "proposal_type",
    "status",
    "markdown_language",
    "source_loop_ids",
    "source_handoff_digests",
    "observation_count",
    "explicit_user_correction",
    "correction_provenance",
    "counterexamples",
    "privacy_review",
    "expected_benefit",
    "safety_impact",
    "offline_evaluation",
    "canary",
    "rollback",
    "review_date",
    "implementation_loop_id",
    "digest",
  ];
  const lines = order.map((key) => `${key}: ${formatFrontMatterValue(proposal[key])}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

function parseFrontMatterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith("\"")) {
    return JSON.parse(trimmed);
  }
  return trimmed;
}

function parseProposalMarkdown(text: string): KnowledgeProposal {
  if (!text.startsWith("---\n")) {
    throw new LoopError("SCHEMA_INVALID", "Knowledge proposal Markdown is missing English front-matter.");
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new LoopError("SCHEMA_INVALID", "Knowledge proposal Markdown front-matter is not closed.");
  }
  const body = text.slice(4, end);
  const record: Record<string, unknown> = {};
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(": ");
    if (separator < 0) {
      throw new LoopError("SCHEMA_INVALID", "Knowledge proposal front-matter line is malformed.", { line });
    }
    const key = line.slice(0, separator);
    record[key] = parseFrontMatterValue(line.slice(separator + 2));
  }
  return validateSchema<KnowledgeProposal>("knowledge-proposal", record);
}

function withDigest(content: Omit<KnowledgeProposal, "digest">): KnowledgeProposal {
  return validateSchema<KnowledgeProposal>("knowledge-proposal", {
    ...content,
    digest: sha256Hex(canonicalJsonBytes(content)),
  });
}

async function quarantineProposalArtifact(path: string): Promise<void> {
  try {
    await rename(path, `${path}.quarantine-${randomUUID()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Crash-safe dual-write: Markdown first (primary), then JSON companion.
 * On JSON failure after Markdown lands, restore the previous Markdown (update)
 * or quarantine the new Markdown (create) so preferred JSON reads cannot surface
 * an advanced status without a matching Markdown artifact.
 */
async function writeProposalArtifacts(
  workspace: string,
  proposal: KnowledgeProposal,
  fault?: (point: ProposalArtifactFaultPoint) => void | Promise<void>,
): Promise<void> {
  const root = resolveLayout(workspace).knowledgeProposalsRoot;
  await mkdir(root, { recursive: true });
  const mdPath = proposalMarkdownPath(workspace, proposal.proposal_id);
  const jsonPath = proposalJsonPath(workspace, proposal.proposal_id);
  const markdown = `${serializeFrontMatter(proposal)}${renderProposalMarkdown(proposal)}`;
  const markdownBytes = new TextEncoder().encode(markdown);

  let previousMarkdown: Uint8Array | null = null;
  try {
    previousMarkdown = await readFile(mdPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await atomicWriteFile(mdPath, markdownBytes);
  try {
    await fault?.("after-markdown");
    await atomicWriteJson(jsonPath, proposal);
  } catch (error) {
    if (previousMarkdown !== null) {
      await atomicWriteFile(mdPath, previousMarkdown);
    } else {
      await quarantineProposalArtifact(mdPath);
    }
    throw error;
  }
}

export async function readProposal(workspace: string, proposalId: string): Promise<KnowledgeProposal> {
  const jsonPath = proposalJsonPath(workspace, proposalId);
  const mdPath = proposalMarkdownPath(workspace, proposalId);
  let jsonRaw: string | undefined;
  let mdRaw: string | undefined;
  try {
    jsonRaw = await readFile(jsonPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    mdRaw = await readFile(mdPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (jsonRaw === undefined && mdRaw === undefined) {
    throw new LoopError("SCHEMA_INVALID", "Knowledge proposal was not found.", { proposal_id: proposalId });
  }
  if (jsonRaw === undefined || mdRaw === undefined) {
    throw new LoopError("SCHEMA_INVALID", "Knowledge proposal artifacts are incomplete.", {
      proposal_id: proposalId,
      json_present: jsonRaw !== undefined,
      markdown_present: mdRaw !== undefined,
    });
  }
  // Prefer the machine JSON companion; still parse Markdown so a corrupt pair fails closed.
  parseProposalMarkdown(mdRaw);
  return validateSchema<KnowledgeProposal>("knowledge-proposal", JSON.parse(jsonRaw));
}

async function readEndedReleaseForLoop(
  workspace: string,
  loopId: LoopId,
  handoffDigest: Digest,
): Promise<{ release_id: string; release_phase: ReleasePhase; release_digest: Digest } | null> {
  const releasesRoot = resolveLayout(workspace).releasesRoot;
  let entries: string[];
  try {
    entries = await readdir(releasesRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let match: { release_id: string; release_phase: ReleasePhase; release_digest: Digest } | null = null;
  for (const entry of entries) {
    const path = join(releasesRoot, entry, "release.json");
    let release: ReleaseRecord;
    try {
      release = validateSchema<ReleaseRecord>("release", JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (release.loop_id !== loopId) continue;
    if (release.handoff_digest !== handoffDigest) continue;
    if (!ENDED_RELEASE_PHASES.has(release.phase)) continue;
    if (match === null || release.release_id.localeCompare(match.release_id) < 0) {
      match = {
        release_id: release.release_id,
        release_phase: release.phase,
        release_digest: release.digest,
      };
    }
  }
  return match;
}

export async function collectKnowledgeSources(input: KnowledgeSourceInput): Promise<KnowledgeObservation[]> {
  if (input.loopIds.length === 0) {
    throw new LoopError("SCHEMA_INVALID", "At least one completed Loop ID is required for Knowledge Evolution.");
  }
  const observations: KnowledgeObservation[] = [];
  for (const rawId of input.loopIds) {
    const loopId = parseLoopId(rawId);
    const layout = resolveLayout(input.workspace, loopId);
    const ledger = await openLedger(layout);
    const snapshot = await ledger.snapshot();
    if (snapshot.phase !== "HANDOFF_READY" || snapshot.status !== "COMPLETE") {
      throw new LoopError(
        "INVALID_TRANSITION",
        "Knowledge Evolution sources must be a completed Loop (HANDOFF_READY + COMPLETE).",
        { loop_id: loopId, phase: snapshot.phase, status: snapshot.status },
      );
    }
    const handoff = await readHandoff(input.workspace, loopId);
    if (handoff === null || snapshot.handoff_digest === null) {
      throw new LoopError(
        "INVALID_TRANSITION",
        "Knowledge Evolution sources must bind an immutable completed Loop Handoff.",
        { loop_id: loopId },
      );
    }
    if (handoff.digest !== snapshot.handoff_digest) {
      throw new LoopError("STALE_HANDOFF", "Loop Handoff digest drifted from the completed snapshot.", {
        loop_id: loopId,
      });
    }
    const ended = await readEndedReleaseForLoop(input.workspace, loopId, handoff.digest);
    observations.push({
      loop_id: loopId,
      handoff_digest: handoff.digest,
      release_id: ended?.release_id ?? null,
      release_phase: ended?.release_phase ?? null,
      release_digest: ended?.release_digest ?? null,
    });
  }
  return observations;
}

function initialStatus(input: ProposalInput): KnowledgeProposalStatus {
  // Status keys off unique source Loops, not raw observation rows (duplicate Loop IDs stay PROVISIONAL).
  const uniqueLoopCount = uniqueSorted(input.observations.map((observation) => observation.loop_id)).length;
  if (uniqueLoopCount > 1) return "REVIEW_PENDING";
  if (input.explicit_user_correction === true) return "REVIEW_PENDING";
  return "PROVISIONAL";
}

export async function buildProposal(input: ProposalInput): Promise<KnowledgeProposal> {
  if (input.observations.length === 0) {
    throw new LoopError("SCHEMA_INVALID", "A Knowledge proposal requires at least one observation.");
  }
  // Rebind digests/ids from verified completed Handoffs so callers cannot persist fabricated digests.
  const observations = await collectKnowledgeSources({
    workspace: input.workspace,
    loopIds: input.observations.map((observation) => observation.loop_id),
  });
  const rebound: ProposalInput = { ...input, observations };

  const language = await resolveMarkdownLanguage({
    workspace: input.workspace,
    ...(input.markdown_language === undefined ? {} : { explicit: input.markdown_language }),
  });
  const content: Omit<KnowledgeProposal, "digest"> = {
    schema_version: 1,
    proposal_id: input.proposal_id ?? generateProposalId(),
    proposal_type: input.proposal_type,
    status: initialStatus(rebound),
    markdown_language: language,
    source_loop_ids: uniqueSorted(observations.map((observation) => observation.loop_id)) as LoopId[],
    source_handoff_digests: uniqueSorted(
      observations.map((observation) => observation.handoff_digest),
    ) as Digest[],
    // Same unique-Loop keying as initialStatus (duplicate loop-id rows count once).
    observation_count: uniqueSorted(observations.map((observation) => observation.loop_id)).length,
    explicit_user_correction: input.explicit_user_correction === true,
    correction_provenance: uniqueSorted(input.correction_provenance ?? []),
    counterexamples: uniqueSorted(input.counterexamples ?? []),
    privacy_review: input.privacy_review,
    expected_benefit: input.expected_benefit,
    safety_impact: input.safety_impact,
    offline_evaluation: uniqueSorted(input.offline_evaluation),
    canary: uniqueSorted(input.canary),
    rollback: uniqueSorted(input.rollback),
    review_date: input.review_date,
    implementation_loop_id: null,
  };
  const proposal = withDigest(content);
  await writeProposalArtifacts(input.workspace, proposal, input.fault);
  return proposal;
}

export async function transitionProposal(input: ProposalTransition): Promise<KnowledgeProposal> {
  if (input.to === "APPLIED") {
    throw new LoopError(
      "INVALID_TRANSITION",
      "APPLIED requires markProposalApplied with a completed implementation Loop.",
      { proposal_id: input.proposalId },
    );
  }
  const current = await readProposal(input.workspace, input.proposalId);
  const allowed = TRANSITIONS[current.status];
  if (!allowed.includes(input.to)) {
    throw new LoopError("INVALID_TRANSITION", "Knowledge proposal transition is not allowed.", {
      proposal_id: input.proposalId,
      from: current.status,
      to: input.to,
    });
  }

  const content: Omit<KnowledgeProposal, "digest"> = {
    schema_version: 1,
    proposal_id: current.proposal_id,
    proposal_type: current.proposal_type,
    status: input.to,
    markdown_language: current.markdown_language,
    source_loop_ids: current.source_loop_ids,
    source_handoff_digests: current.source_handoff_digests,
    observation_count: current.observation_count,
    explicit_user_correction: input.review.explicit_user_correction ?? current.explicit_user_correction,
    correction_provenance: uniqueSorted(input.review.correction_provenance ?? current.correction_provenance),
    counterexamples: uniqueSorted(input.review.counterexamples ?? current.counterexamples),
    privacy_review: input.review.privacy_review,
    expected_benefit: input.review.expected_benefit,
    safety_impact: input.review.safety_impact,
    offline_evaluation: uniqueSorted(input.review.offline_evaluation),
    canary: uniqueSorted(input.review.canary),
    rollback: uniqueSorted(input.review.rollback),
    review_date: input.review.review_date,
    implementation_loop_id: current.implementation_loop_id,
  };
  const proposal = withDigest(content);
  await writeProposalArtifacts(input.workspace, proposal, input.fault);
  return proposal;
}

/**
 * Citation check (substring, not a structured field): the proposal_id must appear in the
 * implementation Loop Handoff residual_risks or in loop.md. Absence rejects APPLIED.
 * Caller must already bind handoff.digest to the completed ledger snapshot.
 */
async function assertCitesProposal(
  workspace: string,
  loopId: LoopId,
  proposalId: string,
  handoff: FinalHandoff,
): Promise<void> {
  const layout = resolveLayout(workspace, loopId);
  const residual = handoff.residual_risks.join("\n");
  let markdown = "";
  try {
    markdown = await readFile(layout.loopMarkdown, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!residual.includes(proposalId) && !markdown.includes(proposalId)) {
    throw new LoopError(
      "INVALID_TRANSITION",
      "APPLIED requires a completed implementation Loop whose contract cites the proposal.",
      { loop_id: loopId, proposal_id: proposalId },
    );
  }
}

export async function markProposalApplied(input: AppliedInput): Promise<KnowledgeProposal> {
  const proposal = await readProposal(input.workspace, input.proposalId);
  const implementationLoopId = parseLoopId(input.implementationLoopId);
  const layout = resolveLayout(input.workspace, implementationLoopId);
  const ledger = await openLedger(layout);
  const snapshot = await ledger.snapshot();
  if (snapshot.phase !== "HANDOFF_READY" || snapshot.status !== "COMPLETE") {
    throw new LoopError(
      "INVALID_TRANSITION",
      "APPLIED requires a completed implementation Loop (HANDOFF_READY + COMPLETE).",
      { implementation_loop_id: implementationLoopId, phase: snapshot.phase, status: snapshot.status },
    );
  }
  // Mirror collectKnowledgeSources: bind immutable Handoff to the completed ledger digest first.
  const handoff = await readHandoff(input.workspace, implementationLoopId);
  if (handoff === null || snapshot.handoff_digest === null) {
    throw new LoopError(
      "INVALID_TRANSITION",
      "APPLIED requires a completed implementation Loop Handoff that cites the proposal.",
      { loop_id: implementationLoopId, proposal_id: proposal.proposal_id },
    );
  }
  if (handoff.digest !== snapshot.handoff_digest) {
    throw new LoopError("STALE_HANDOFF", "Loop Handoff digest drifted from the completed snapshot.", {
      loop_id: implementationLoopId,
    });
  }
  if (proposal.status !== "APPROVED") {
    throw new LoopError(
      "INVALID_TRANSITION",
      "Only an APPROVED Knowledge proposal can be marked APPLIED after a separate implementation Loop.",
      { proposal_id: input.proposalId, status: proposal.status },
    );
  }
  if (proposal.source_loop_ids.includes(implementationLoopId)) {
    throw new LoopError(
      "INVALID_TRANSITION",
      "APPLIED requires a separate completed implementation Loop that cites the proposal.",
      { proposal_id: input.proposalId, implementation_loop_id: implementationLoopId },
    );
  }
  await assertCitesProposal(input.workspace, implementationLoopId, proposal.proposal_id, handoff);

  const content: Omit<KnowledgeProposal, "digest"> = {
    schema_version: 1,
    proposal_id: proposal.proposal_id,
    proposal_type: proposal.proposal_type,
    status: "APPLIED",
    markdown_language: proposal.markdown_language,
    source_loop_ids: proposal.source_loop_ids,
    source_handoff_digests: proposal.source_handoff_digests,
    observation_count: proposal.observation_count,
    explicit_user_correction: proposal.explicit_user_correction,
    correction_provenance: proposal.correction_provenance,
    counterexamples: proposal.counterexamples,
    privacy_review: proposal.privacy_review,
    expected_benefit: proposal.expected_benefit,
    safety_impact: proposal.safety_impact,
    offline_evaluation: proposal.offline_evaluation,
    canary: proposal.canary,
    rollback: proposal.rollback,
    review_date: proposal.review_date,
    implementation_loop_id: implementationLoopId,
  };
  const applied = withDigest(content);
  await writeProposalArtifacts(input.workspace, applied);
  return applied;
}

/** Default English review fields for CLI propose (machine contract stays English-only). */
export function defaultProposalReview(): ProposalReview {
  return {
    privacy_review: "No sensitive content is included.",
    expected_benefit: "Reduce repeated review work.",
    safety_impact: "No safety boundary changes.",
    offline_evaluation: ["Replay prior cases."],
    canary: ["Use in one child Loop."],
    rollback: ["Supersede the proposal."],
    review_date: new Date().toISOString().slice(0, 10),
    counterexamples: ["One-off project accident."],
  };
}
