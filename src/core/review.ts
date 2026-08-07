import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LoopError, type Digest, type LoopId } from "../contracts/domain.js";
import { atomicWriteJson } from "./atomic-json.js";
import { resolveLayout, type LoopLayout } from "./paths.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type ReviewGate = "PLAN" | "FINAL_DIFF" | "CODE" | "SAFETY_ENVIRONMENT";
export type FindingStatus = "OPEN" | "FIXED" | "VERIFIED" | "WONT_FIX" | "REOPENED";
export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ChangedDomain =
  | "LOCAL"
  | "INTERFACE"
  | "PERSISTENCE"
  | "CONCURRENCY"
  | "ROLLBACK"
  | "CONTROL"
  | "SAFETY"
  | "ACTUATOR"
  | "REAL_TIME"
  | "HIL"
  | "REAL_ROBOT"
  | "MODEL_RELEASE";

const MEDIUM_DOMAINS = new Set<ChangedDomain>([
  "INTERFACE", "PERSISTENCE", "CONCURRENCY", "ROLLBACK",
]);
const HIGH_DOMAINS = new Set<ChangedDomain>([
  "CONTROL", "SAFETY", "ACTUATOR", "REAL_TIME", "HIL", "REAL_ROBOT", "MODEL_RELEASE",
]);

export interface RequirementContract {
  objective: string;
  acceptance: readonly string[];
  outOfScope: readonly string[];
  safetyInvariants: readonly string[];
  changedDomains: readonly ChangedDomain[];
}

export interface ReviewerRequest {
  workspace: string;
  loopId: LoopId;
  gate: ReviewGate;
  reviewerActor: string;
  implementerActors: readonly string[];
  baseSha: string;
  headSha: string;
  sourceDigest: Digest;
  diffCoordinates: readonly string[];
  acceptance: readonly string[];
  verificationEvidenceIds: readonly string[];
  privateOutputRoot: string;
}

export interface ReviewAssignment {
  loopId: LoopId;
  gate: ReviewGate;
  reviewerActor: string;
  implementerActors: readonly string[];
  baseSha: string;
  headSha: string;
  sourceDigest: Digest;
  diffCoordinates: readonly string[];
  acceptance: readonly string[];
  verificationEvidenceIds: readonly string[];
  privateOutputRoot: string;
  readOnlySource: true;
  requiresWorktreeForMutatingCommands: true;
}

export interface FindingUpdate {
  workspace: string;
  loopId: LoopId;
  findingId: string;
  actorRole: string;
  status: FindingStatus;
  sourceDigest: Digest;
  area?: string;
  severity?: FindingSeverity;
  reviewerActor?: string;
}

export interface Finding {
  findingId: string;
  status: FindingStatus;
  severity: FindingSeverity;
  area: string;
  sourceDigest: Digest;
  updatedBy: string;
  updatedAt: string;
}

export interface FindingSummary {
  findingId: string;
  status: FindingStatus;
  severity: FindingSeverity;
  area: string;
  sourceDigest: Digest;
}

export interface VerdictBudgets {
  attemptsUsed: number;
  attempts: number;
  reviewsUsed: number;
  reviews: number;
  transitionsUsed: number;
  transitions: number;
}

export interface VerdictInput {
  workspace: string;
  loopId: LoopId;
  risk: RiskLevel;
  completedGates: readonly ReviewGate[];
  findings: readonly FindingSummary[];
  evidenceFresh: boolean;
  oscillation: boolean;
  budgets: VerdictBudgets;
  repeatedSameArea?: boolean;
  newCriticalAfterFix?: boolean;
  alternatingVerification?: boolean;
}

export type ReviewVerdict =
  | { kind: "PASS" }
  | { kind: "BLOCKED"; reasons: readonly string[] }
  | { kind: "NON_CONVERGENT"; reasons: readonly string[]; checkpointRequired: true };

interface FindingStore {
  schema_version: 1;
  findings: Record<string, Finding>;
}

interface AssignmentStore {
  schema_version: 1;
  assignments: readonly ReviewAssignment[];
}

function findingsPath(layout: LoopLayout): string {
  return join(layout.loopRoot, "findings.json");
}

function assignmentsPath(layout: LoopLayout): string {
  return join(layout.loopRoot, "review-assignments.json");
}

async function readFindings(layout: LoopLayout): Promise<FindingStore> {
  try {
    return JSON.parse(await readFile(findingsPath(layout), "utf8")) as FindingStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: 1, findings: {} };
    }
    throw error;
  }
}

async function writeFindings(layout: LoopLayout, store: FindingStore): Promise<void> {
  await mkdir(layout.loopRoot, { recursive: true });
  await atomicWriteJson(findingsPath(layout), store);
}

async function readAssignments(layout: LoopLayout): Promise<AssignmentStore> {
  try {
    return JSON.parse(await readFile(assignmentsPath(layout), "utf8")) as AssignmentStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: 1, assignments: [] };
    }
    throw error;
  }
}

async function writeAssignments(layout: LoopLayout, store: AssignmentStore): Promise<void> {
  await mkdir(layout.loopRoot, { recursive: true });
  await atomicWriteJson(assignmentsPath(layout), store);
}

export function classifyRisk(contract: RequirementContract): RiskLevel {
  let level: RiskLevel = "LOW";
  for (const domain of contract.changedDomains) {
    if (HIGH_DOMAINS.has(domain)) return "HIGH";
    if (MEDIUM_DOMAINS.has(domain)) level = "MEDIUM";
  }
  return level;
}

export function requiredReviewGates(risk: RiskLevel): readonly ReviewGate[] {
  switch (risk) {
    case "LOW":
      return ["FINAL_DIFF"];
    case "MEDIUM":
      return ["PLAN", "FINAL_DIFF"];
    case "HIGH":
      return ["PLAN", "CODE", "SAFETY_ENVIRONMENT"];
  }
}

function assertIndependentReviewer(request: ReviewerRequest): void {
  if (request.reviewerActor.trim() === "") {
    throw new LoopError("AUTHORIZATION_REQUIRED", "An independent reviewer actor is required.");
  }
  if (request.implementerActors.includes(request.reviewerActor)) {
    throw new LoopError(
      "AUTHORIZATION_REQUIRED",
      "Only a distinct independent reviewer may be admitted for Review.",
      { reviewer_actor: request.reviewerActor, implementer_actors: request.implementerActors },
    );
  }
}

export async function admitReviewer(request: ReviewerRequest): Promise<ReviewAssignment> {
  assertIndependentReviewer(request);
  if (request.acceptance.length === 0) {
    throw new LoopError("SCHEMA_INVALID", "Reviewer input must include acceptance criteria.");
  }
  if (request.diffCoordinates.length === 0) {
    throw new LoopError("SCHEMA_INVALID", "Reviewer input must include Diff coordinates.");
  }
  if (request.privateOutputRoot.trim() === "") {
    throw new LoopError("SCHEMA_INVALID", "Reviewer private output root is required.");
  }
  const assignment: ReviewAssignment = {
    loopId: request.loopId,
    gate: request.gate,
    reviewerActor: request.reviewerActor,
    implementerActors: [...request.implementerActors],
    baseSha: request.baseSha,
    headSha: request.headSha,
    sourceDigest: request.sourceDigest,
    diffCoordinates: [...request.diffCoordinates],
    acceptance: [...request.acceptance],
    verificationEvidenceIds: [...request.verificationEvidenceIds],
    privateOutputRoot: request.privateOutputRoot,
    readOnlySource: true,
    requiresWorktreeForMutatingCommands: true,
  };
  const layout = resolveLayout(request.workspace, request.loopId);
  const store = await readAssignments(layout);
  await writeAssignments(layout, {
    schema_version: 1,
    assignments: [
      ...store.assignments.filter((entry) => !(
        entry.gate === assignment.gate && entry.reviewerActor === assignment.reviewerActor
      )),
      assignment,
    ],
  });
  return assignment;
}

export async function recordFindingUpdate(update: FindingUpdate): Promise<Finding> {
  const layout = resolveLayout(update.workspace, update.loopId);
  const store = await readFindings(layout);
  const existing = store.findings[update.findingId];

  if (update.status === "VERIFIED") {
    if (update.actorRole === "implementer" || update.actorRole.startsWith("implementer")) {
      throw new LoopError(
        "AUTHORIZATION_REQUIRED",
        "Only the current independent reviewer can mark a Finding VERIFIED.",
        { finding_id: update.findingId, actor_role: update.actorRole },
      );
    }
    const assignments = await readAssignments(layout);
    const reviewerActor = update.reviewerActor ?? update.actorRole;
    const current = assignments.assignments.find((entry) =>
      entry.reviewerActor === reviewerActor
      && entry.sourceDigest === update.sourceDigest
      && !entry.implementerActors.includes(reviewerActor));
    if (current === undefined) {
      throw new LoopError(
        "AUTHORIZATION_REQUIRED",
        "Only the current independent reviewer on the source digest can mark a Finding VERIFIED.",
        { finding_id: update.findingId, reviewer_actor: reviewerActor, source_digest: update.sourceDigest },
      );
    }
    if (existing === undefined) {
      throw new LoopError("SCHEMA_INVALID", "A Finding must exist before it can be verified.", {
        finding_id: update.findingId,
      });
    }
  }

  if (update.status === "FIXED" && update.actorRole !== "implementer" && !update.actorRole.startsWith("implementer")) {
    // Implementers fix; reviewers may also record FIXED during remediation orchestration.
  }

  const finding: Finding = {
    findingId: update.findingId,
    status: update.status,
    severity: update.severity ?? existing?.severity ?? "MEDIUM",
    area: update.area ?? existing?.area ?? "unspecified",
    sourceDigest: update.sourceDigest,
    updatedBy: update.actorRole,
    updatedAt: new Date().toISOString(),
  };
  store.findings[update.findingId] = finding;
  await writeFindings(layout, store);
  return finding;
}

export async function listFindings(workspace: string, loopId: LoopId): Promise<readonly Finding[]> {
  const store = await readFindings(resolveLayout(workspace, loopId));
  return Object.values(store.findings).sort((left, right) =>
    left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0);
}

export async function listReviewAssignments(
  workspace: string,
  loopId: LoopId,
): Promise<readonly ReviewAssignment[]> {
  return (await readAssignments(resolveLayout(workspace, loopId))).assignments;
}

function budgetsExhausted(budgets: VerdictBudgets): boolean {
  return budgets.attemptsUsed >= budgets.attempts
    || budgets.reviewsUsed >= budgets.reviews
    || budgets.transitionsUsed >= budgets.transitions;
}

export function aggregateVerdict(input: VerdictInput): ReviewVerdict {
  const nonConvergentReasons: string[] = [];
  if (input.oscillation) nonConvergentReasons.push("Verification results are oscillating.");
  if (input.repeatedSameArea) nonConvergentReasons.push("Repeated Findings remain in the same area.");
  if (input.newCriticalAfterFix) nonConvergentReasons.push("New Critical Findings appeared after fixes.");
  if (input.alternatingVerification) nonConvergentReasons.push("Verification is alternating without convergence.");
  if (budgetsExhausted(input.budgets)) nonConvergentReasons.push("Attempt, review, or transition budgets are exhausted.");
  if (nonConvergentReasons.length > 0) {
    return { kind: "NON_CONVERGENT", reasons: nonConvergentReasons, checkpointRequired: true };
  }

  const blocked: string[] = [];
  const required = requiredReviewGates(input.risk);
  for (const gate of required) {
    if (!input.completedGates.includes(gate)) {
      blocked.push(`Required Review gate ${gate} is unmet.`);
    }
  }
  if (!input.evidenceFresh) blocked.push("Evidence is stale relative to the reviewed Source.");
  for (const finding of input.findings) {
    if (
      (finding.severity === "CRITICAL" || finding.severity === "HIGH")
      && finding.status !== "VERIFIED"
      && finding.status !== "WONT_FIX"
    ) {
      blocked.push(`Open ${finding.severity} Finding ${finding.findingId} blocks the verdict.`);
    }
  }
  if (blocked.length > 0) return { kind: "BLOCKED", reasons: blocked };
  return { kind: "PASS" };
}
