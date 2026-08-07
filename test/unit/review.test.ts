import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import { openLedger } from "../../src/core/ledger.js";
import { parseLoopId, resolveLayout, type LoopLayout } from "../../src/core/paths.js";
import {
  admitReviewer,
  aggregateVerdict,
  classifyRisk,
  recordFindingUpdate,
  requiredReviewGates,
  type FindingUpdate,
  type RequirementContract,
  type ReviewerRequest,
  type VerdictInput,
} from "../../src/core/review.js";

const digest = (character: string): Digest => character.repeat(64) as Digest;
const sourceDigest = digest("a");

async function reviewingLayout(t: TestContext, loopId: LoopId): Promise<LoopLayout> {
  const root = await mkdtemp(join(tmpdir(), "pai-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveLayout(root, loopId);
  const ledger = await openLedger(layout);
  for (const phase of [
    "ORIENTING", "CONTRACTED", "PLANNED", "HARNESSING", "IMPLEMENTING", "VERIFYING", "REVIEWING",
  ] as const) {
    await ledger.transition(phase, "ACTIVE", await ledger.cursor());
  }
  return layout;
}

function contract(domains: RequirementContract["changedDomains"]): RequirementContract {
  return {
    objective: "Ship a bounded change.",
    acceptance: ["Tests pass."],
    outOfScope: ["Unrelated modules."],
    safetyInvariants: ["No physical actuation."],
    changedDomains: domains,
  };
}

function reviewerRequest(layout: LoopLayout, overrides: Partial<ReviewerRequest> = {}): ReviewerRequest {
  return {
    workspace: layout.workspaceRoot,
    loopId: layout.loopId,
    gate: "FINAL_DIFF",
    reviewerActor: "reviewer-a",
    implementerActors: ["implementer-a"],
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sourceDigest,
    diffCoordinates: ["src/core/review.ts"],
    acceptance: ["Tests pass."],
    verificationEvidenceIds: ["E-1"],
    privateOutputRoot: join(layout.loopRoot, "reviewer-private"),
    ...overrides,
  };
}

function findingUpdate(layout: LoopLayout, overrides: Partial<FindingUpdate> = {}): FindingUpdate {
  return {
    workspace: layout.workspaceRoot,
    loopId: layout.loopId,
    findingId: "F-1",
    actorRole: "implementer",
    status: "FIXED",
    sourceDigest,
    area: "src/core/review.ts",
    severity: "HIGH",
    ...overrides,
  };
}

test("risk gates are adaptive but final independent review is universal", () => {
  assert.deepEqual(requiredReviewGates("LOW"), ["FINAL_DIFF"]);
  assert.deepEqual(requiredReviewGates("MEDIUM"), ["PLAN", "FINAL_DIFF"]);
  assert.deepEqual(requiredReviewGates("HIGH"), ["PLAN", "CODE", "SAFETY_ENVIRONMENT"]);
});

test("classifyRisk elevates persistence and safety domains", () => {
  assert.equal(classifyRisk(contract(["LOCAL"])), "LOW");
  assert.equal(classifyRisk(contract(["PERSISTENCE"])), "MEDIUM");
  assert.equal(classifyRisk(contract(["INTERFACE", "CONCURRENCY"])), "MEDIUM");
  assert.equal(classifyRisk(contract(["CONTROL"])), "HIGH");
  assert.equal(classifyRisk(contract(["SAFETY", "HIL"])), "HIGH");
  assert.equal(classifyRisk(contract(["MODEL_RELEASE"])), "HIGH");
});

test("admitReviewer rejects the implementer as the independent Reviewer", async (t) => {
  const layout = await reviewingLayout(t, parseLoopId("loop-review-admit"));
  await assert.rejects(
    admitReviewer(reviewerRequest(layout, {
      reviewerActor: "implementer-a",
      implementerActors: ["implementer-a"],
    })),
    /independent reviewer/i,
  );
});

test("admitReviewer admits a distinct Reviewer with private outputs", async (t) => {
  const layout = await reviewingLayout(t, parseLoopId("loop-review-ok"));
  const assignment = await admitReviewer(reviewerRequest(layout));
  assert.equal(assignment.gate, "FINAL_DIFF");
  assert.equal(assignment.reviewerActor, "reviewer-a");
  assert.equal(assignment.sourceDigest, sourceDigest);
  assert.equal(assignment.readOnlySource, true);
  assert.equal(assignment.privateOutputRoot, join(layout.loopRoot, "reviewer-private"));
});

test("implementer can fix but only current independent reviewer can verify", async (t) => {
  const layout = await reviewingLayout(t, parseLoopId("loop-finding-owner"));
  await recordFindingUpdate(findingUpdate(layout, { status: "OPEN", actorRole: "reviewer" }));
  await recordFindingUpdate(findingUpdate(layout, { status: "FIXED", actorRole: "implementer" }));
  await assert.rejects(
    recordFindingUpdate(findingUpdate(layout, { status: "VERIFIED", actorRole: "implementer" })),
    /independent reviewer/i,
  );
  await admitReviewer(reviewerRequest(layout));
  const verified = await recordFindingUpdate(findingUpdate(layout, {
    status: "VERIFIED",
    actorRole: "reviewer",
    reviewerActor: "reviewer-a",
  }));
  assert.equal(verified.status, "VERIFIED");
});

test("aggregateVerdict blocks open Critical Findings and unmet Review gates", async (t) => {
  const layout = await reviewingLayout(t, parseLoopId("loop-verdict-block"));
  await recordFindingUpdate(findingUpdate(layout, {
    status: "OPEN",
    actorRole: "reviewer",
    severity: "CRITICAL",
  }));
  const blocked: VerdictInput = {
    workspace: layout.workspaceRoot,
    loopId: layout.loopId,
    risk: "MEDIUM",
    completedGates: ["PLAN"],
    findings: [{ findingId: "F-1", status: "OPEN", severity: "CRITICAL", area: "src/a.ts", sourceDigest }],
    evidenceFresh: true,
    oscillation: false,
    budgets: { attemptsUsed: 0, attempts: 3, reviewsUsed: 0, reviews: 2, transitionsUsed: 0, transitions: 10 },
  };
  const verdict = aggregateVerdict(blocked);
  assert.equal(verdict.kind, "BLOCKED");
});

test("aggregateVerdict marks NON_CONVERGENT for exhausted budgets and oscillation", () => {
  const exhausted: VerdictInput = {
    workspace: "/tmp",
    loopId: parseLoopId("loop-non-convergent"),
    risk: "LOW",
    completedGates: ["FINAL_DIFF"],
    findings: [],
    evidenceFresh: true,
    oscillation: true,
    budgets: { attemptsUsed: 3, attempts: 3, reviewsUsed: 2, reviews: 2, transitionsUsed: 10, transitions: 10 },
  };
  const verdict = aggregateVerdict(exhausted);
  assert.equal(verdict.kind, "NON_CONVERGENT");
});

test("aggregateVerdict passes when gates Findings and evidence converge", () => {
  const input: VerdictInput = {
    workspace: "/tmp",
    loopId: parseLoopId("loop-verdict-pass"),
    risk: "LOW",
    completedGates: ["FINAL_DIFF"],
    findings: [{ findingId: "F-1", status: "VERIFIED", severity: "HIGH", area: "src/a.ts", sourceDigest }],
    evidenceFresh: true,
    oscillation: false,
    budgets: { attemptsUsed: 1, attempts: 3, reviewsUsed: 1, reviews: 2, transitionsUsed: 4, transitions: 10 },
  };
  const verdict = aggregateVerdict(input);
  assert.equal(verdict.kind, "PASS");
});
