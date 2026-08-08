import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LoopError } from "../contracts/domain.js";
import { atomicWriteJson } from "./atomic-json.js";
import { resolveLayout } from "./paths.js";
const MEDIUM_DOMAINS = new Set([
    "INTERFACE", "PERSISTENCE", "CONCURRENCY", "ROLLBACK",
]);
const HIGH_DOMAINS = new Set([
    "CONTROL", "SAFETY", "ACTUATOR", "REAL_TIME", "HIL", "REAL_ROBOT", "MODEL_RELEASE",
]);
function findingsPath(layout) {
    return join(layout.loopRoot, "findings.json");
}
function assignmentsPath(layout) {
    return join(layout.loopRoot, "review-assignments.json");
}
function riskPath(layout) {
    return join(layout.loopRoot, "risk.json");
}
function verdictPath(layout) {
    return join(layout.loopRoot, "verdict.json");
}
async function readFindings(layout) {
    try {
        return JSON.parse(await readFile(findingsPath(layout), "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { schema_version: 1, findings: {} };
        }
        throw error;
    }
}
async function writeFindings(layout, store) {
    await mkdir(layout.loopRoot, { recursive: true });
    await atomicWriteJson(findingsPath(layout), store);
}
async function readAssignments(layout) {
    try {
        return JSON.parse(await readFile(assignmentsPath(layout), "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { schema_version: 1, assignments: [] };
        }
        throw error;
    }
}
async function writeAssignments(layout, store) {
    await mkdir(layout.loopRoot, { recursive: true });
    await atomicWriteJson(assignmentsPath(layout), store);
}
export async function recordRisk(workspace, loopId, risk, source = "verdict") {
    if (risk !== "LOW" && risk !== "MEDIUM" && risk !== "HIGH") {
        throw new LoopError("SCHEMA_INVALID", "Risk must be LOW, MEDIUM, or HIGH.", { risk });
    }
    const layout = resolveLayout(workspace, loopId);
    await mkdir(layout.loopRoot, { recursive: true });
    const store = {
        schema_version: 1,
        risk,
        source,
        classified_at: new Date().toISOString(),
    };
    await atomicWriteJson(riskPath(layout), store);
    return risk;
}
export async function readPersistedRisk(workspace, loopId) {
    try {
        const store = JSON.parse(await readFile(riskPath(resolveLayout(workspace, loopId)), "utf8"));
        if (store.risk === "LOW" || store.risk === "MEDIUM" || store.risk === "HIGH")
            return store.risk;
        return null;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
export async function recordVerdict(workspace, loopId, verdict) {
    const layout = resolveLayout(workspace, loopId);
    await mkdir(layout.loopRoot, { recursive: true });
    const store = {
        schema_version: 1,
        verdict,
        recorded_at: new Date().toISOString(),
    };
    await atomicWriteJson(verdictPath(layout), store);
    return verdict;
}
export async function readPersistedVerdict(workspace, loopId) {
    try {
        const store = JSON.parse(await readFile(verdictPath(resolveLayout(workspace, loopId)), "utf8"));
        if (store.verdict === undefined || store.verdict === null || typeof store.verdict !== "object")
            return null;
        const kind = store.verdict.kind;
        if (kind !== "PASS" && kind !== "BLOCKED" && kind !== "NON_CONVERGENT")
            return null;
        return store.verdict;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
export function classifyRisk(contract) {
    let level = "LOW";
    for (const domain of contract.changedDomains) {
        if (HIGH_DOMAINS.has(domain))
            return "HIGH";
        if (MEDIUM_DOMAINS.has(domain))
            level = "MEDIUM";
    }
    return level;
}
export function requiredReviewGates(risk) {
    switch (risk) {
        case "LOW":
            return ["FINAL_DIFF"];
        case "MEDIUM":
            return ["PLAN", "FINAL_DIFF"];
        case "HIGH":
            return ["PLAN", "CODE", "SAFETY_ENVIRONMENT"];
    }
}
function assertIndependentReviewer(request) {
    if (request.reviewerActor.trim() === "") {
        throw new LoopError("AUTHORIZATION_REQUIRED", "An independent reviewer actor is required.");
    }
    if (request.implementerActors.includes(request.reviewerActor)) {
        throw new LoopError("AUTHORIZATION_REQUIRED", "Only a distinct independent reviewer may be admitted for Review.", { reviewer_actor: request.reviewerActor, implementer_actors: request.implementerActors });
    }
}
export async function admitReviewer(request) {
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
    const assignment = {
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
            ...store.assignments.filter((entry) => !(entry.gate === assignment.gate && entry.reviewerActor === assignment.reviewerActor)),
            assignment,
        ],
    });
    return assignment;
}
export async function recordFindingUpdate(update) {
    const layout = resolveLayout(update.workspace, update.loopId);
    const store = await readFindings(layout);
    const existing = store.findings[update.findingId];
    if (update.status === "VERIFIED") {
        if (update.actorRole === "implementer" || update.actorRole.startsWith("implementer")) {
            throw new LoopError("AUTHORIZATION_REQUIRED", "Only the current independent reviewer can mark a Finding VERIFIED.", { finding_id: update.findingId, actor_role: update.actorRole });
        }
        const assignments = await readAssignments(layout);
        const reviewerActor = update.reviewerActor ?? update.actorRole;
        const current = assignments.assignments.find((entry) => entry.reviewerActor === reviewerActor
            && entry.sourceDigest === update.sourceDigest
            && !entry.implementerActors.includes(reviewerActor));
        if (current === undefined) {
            throw new LoopError("AUTHORIZATION_REQUIRED", "Only the current independent reviewer on the source digest can mark a Finding VERIFIED.", { finding_id: update.findingId, reviewer_actor: reviewerActor, source_digest: update.sourceDigest });
        }
        if (existing === undefined) {
            throw new LoopError("SCHEMA_INVALID", "A Finding must exist before it can be verified.", {
                finding_id: update.findingId,
            });
        }
    }
    const finding = {
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
export async function listFindings(workspace, loopId) {
    const store = await readFindings(resolveLayout(workspace, loopId));
    return Object.values(store.findings).sort((left, right) => left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0);
}
export async function listReviewAssignments(workspace, loopId) {
    return (await readAssignments(resolveLayout(workspace, loopId))).assignments;
}
function budgetsExhausted(budgets) {
    return budgets.attemptsUsed >= budgets.attempts
        || budgets.reviewsUsed >= budgets.reviews
        || budgets.transitionsUsed >= budgets.transitions;
}
export function aggregateVerdict(input) {
    const nonConvergentReasons = [];
    if (input.oscillation)
        nonConvergentReasons.push("Verification results are oscillating.");
    if (input.repeatedSameArea)
        nonConvergentReasons.push("Repeated Findings remain in the same area.");
    if (input.newCriticalAfterFix)
        nonConvergentReasons.push("New Critical Findings appeared after fixes.");
    if (input.alternatingVerification)
        nonConvergentReasons.push("Verification is alternating without convergence.");
    if (budgetsExhausted(input.budgets))
        nonConvergentReasons.push("Attempt, review, or transition budgets are exhausted.");
    if (nonConvergentReasons.length > 0) {
        return { kind: "NON_CONVERGENT", reasons: nonConvergentReasons, checkpointRequired: true };
    }
    const blocked = [];
    const required = requiredReviewGates(input.risk);
    for (const gate of required) {
        if (!input.completedGates.includes(gate)) {
            blocked.push(`Required Review gate ${gate} is unmet.`);
        }
    }
    if (!input.evidenceFresh)
        blocked.push("Evidence is stale relative to the reviewed Source.");
    for (const finding of input.findings) {
        if ((finding.severity === "CRITICAL" || finding.severity === "HIGH")
            && finding.status !== "VERIFIED"
            && finding.status !== "WONT_FIX") {
            blocked.push(`Open ${finding.severity} Finding ${finding.findingId} blocks the verdict.`);
        }
    }
    if (blocked.length > 0)
        return { kind: "BLOCKED", reasons: blocked };
    return { kind: "PASS" };
}
//# sourceMappingURL=review.js.map