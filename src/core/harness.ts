import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LoopError,
  sha256Hex,
  type Digest,
  type EnforcementClass,
  type EnvironmentNode,
  type LoopId,
} from "../contracts/domain.js";
import type {
  ActorGrant,
  CapabilityGrant,
  EvidenceRecord,
  GateRequirement,
  H0Harness,
  H1Harness,
  HarnessBudgets,
} from "../contracts/harness.js";
import { canonicalJsonBytes } from "./atomic-json.js";
import type { LoopLedger } from "./ledger.js";
import { validateSchema } from "./schema.js";

export interface H0Input {
  loopId: LoopId;
  repositoryId: string;
  repositoryRoot: string;
  readablePaths: readonly string[];
  repositoryRulesDigest: Digest;
  exploreCapabilities: readonly string[];
  networkClass: H0Harness["network_class"];
  deniedActions?: readonly string[];
}

export interface H1Input {
  loopId: LoopId;
  objective: string;
  acceptance: readonly string[];
  outOfScope: readonly string[];
  readablePaths: readonly string[];
  writablePaths: readonly string[];
  waveInputDigest: Digest;
  projectPolicyDigest: Digest;
  planDigest: Digest;
  environmentGates: readonly GateRequirement[];
  actors: readonly ActorGrant[];
  capabilities: readonly CapabilityGrant[];
  budgets: HarnessBudgets;
  stopRules: readonly string[];
  resultSchemas: readonly string[];
  planReview: "PASSED" | "REQUIRED_NOT_PASSED";
}

export interface HarnessFacts {
  harnessDigest: Digest;
  waveInputDigest: Digest;
  projectPolicyDigest: Digest;
  planDigest: Digest;
  attemptsUsed: number;
  /** Forward-looking review budget counter; enforced when Review becomes a Runtime Gate operation. */
  reviewsUsed: number;
  transitionsUsed: number;
  activeWriteWave: boolean;
  evidence: readonly EvidenceRecord[];
  requestedWritablePaths?: readonly string[];
  requestedCapabilities?: readonly string[];
}

export type GateOperation =
  | "SOURCE_WRITE"
  | "EVIDENCE_EXECUTION"
  | "DISPATCH"
  | "TRANSITION"
  | "FINALIZE"
  | "EXTERNAL_ACTION"
  | "PHYSICAL_ACTION";

export interface GateRequest {
  harness: H0Harness | H1Harness | null;
  operation: GateOperation;
  actorRole: string;
  path?: string;
  /** Reserved for Dispatch Broker tool/argv allow-listing against H1 capabilities. */
  argv?: readonly string[];
  facts: HarnessFacts;
}

export type HarnessDrift =
  | { kind: "NONE" }
  | { kind: "FACT_REFRESH"; reason: string; nextPhase: "HARNESSING" }
  | { kind: "PLAN_CHANGE"; reason: string; nextPhase: "PLANNED" }
  | { kind: "AUTHORITY_EXPANSION"; reason: string; childLoopRequired: true };

export type GateDecision =
  | { allowed: true; harnessDigest: Digest; enforcement: EnforcementClass }
  | { allowed: false; code: "HARNESS_REQUIRED" | "HARNESS_DRIFT" | "AUTHORIZATION_REQUIRED"; reason: string };

export interface EnvironmentGateResult {
  loopSatisfied: readonly string[];
  releasePending: readonly string[];
  notApplicable: readonly string[];
}

const DENIED_BY_DEFAULT = ["EXTERNAL_ACTION", "PHYSICAL_ACTION"] as const;

const PHYSICAL_NODES = new Set<EnvironmentNode>(["HIL", "BENCH", "CLOSED_COURSE", "REAL_VEHICLE_ROBOT"]);

const OPERATION_CAPABILITY: Readonly<Record<GateOperation, string>> = {
  SOURCE_WRITE: "source-write",
  EVIDENCE_EXECUTION: "evidence-execution",
  DISPATCH: "dispatch",
  TRANSITION: "transition",
  FINALIZE: "finalize",
  EXTERNAL_ACTION: "external-action",
  PHYSICAL_ACTION: "physical-action",
};

const SATISFYING_EVIDENCE = new Set<EvidenceRecord["result"]>(["PASS", "PRE_EXISTING"]);

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function escapeRegExpCharacter(character: string): string {
  return /[.*+?^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/gu, "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === undefined) continue;
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExpCharacter(character);
    }
  }
  return new RegExp(`${source}$`, "u");
}

function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replace(/\\/gu, "/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function recomputeDigest(harness: H0Harness | H1Harness): Digest {
  const { digest: _digest, ...content } = harness;
  return sha256Hex(canonicalJsonBytes(content));
}

export async function forgeH0(input: H0Input): Promise<H0Harness> {
  const repositoryRoot = await realpath(resolve(input.repositoryRoot));
  const content = {
    schema_version: 1 as const,
    kind: "H0" as const,
    loop_id: input.loopId,
    revision: 0 as const,
    repository_id: input.repositoryId,
    repository_root: repositoryRoot,
    readable_paths: uniqueSorted(input.readablePaths),
    repository_rules_digest: input.repositoryRulesDigest,
    explore_capabilities: uniqueSorted(input.exploreCapabilities),
    network_class: input.networkClass,
    denied_actions: uniqueSorted([...(input.deniedActions ?? []), ...DENIED_BY_DEFAULT]),
  };
  const digest = sha256Hex(canonicalJsonBytes(content));
  return validateSchema<H0Harness>("harness", { ...content, digest });
}

function normalizeGate(gate: GateRequirement): GateRequirement {
  const base = {
    gate_id: gate.gate_id,
    node: gate.node,
    owner: gate.owner,
    depends_on: uniqueSorted(gate.depends_on),
    evidence_ids: uniqueSorted(gate.evidence_ids),
    requires_new_action: gate.requires_new_action,
  };
  return gate.not_applicable_reason === undefined
    ? base
    : { ...base, not_applicable_reason: gate.not_applicable_reason };
}

function normalizeActor(actor: ActorGrant): ActorGrant {
  return {
    actor_role: actor.actor_role,
    model_class: actor.model_class,
    capabilities: uniqueSorted(actor.capabilities),
  };
}

function byField<T>(select: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => {
    const a = select(left);
    const b = select(right);
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

export async function sealH1(input: H1Input, ledger: LoopLedger): Promise<H1Harness> {
  if (input.planReview !== "PASSED") {
    throw new LoopError("HARNESS_REQUIRED", "An execution Harness requires a passed Plan Review before sealing.", {
      plan_review: input.planReview,
    });
  }
  validateEnvironmentDag(input.environmentGates);

  const expected = await ledger.cursor();
  const committed = await ledger.transact("HARNESS", expected, async () => {
    const snapshot = await ledger.snapshot();
    if (snapshot.phase !== "HARNESSING") {
      throw new LoopError("HARNESS_REQUIRED", "An execution Harness can be sealed only from the HARNESSING phase.", {
        phase: snapshot.phase,
      });
    }
    const revision = (snapshot.current_harness_revision ?? 0) + 1;
    const content = {
      schema_version: 1 as const,
      kind: "H1" as const,
      loop_id: input.loopId,
      revision,
      objective: input.objective,
      acceptance: [...input.acceptance],
      out_of_scope: [...input.outOfScope],
      readable_paths: uniqueSorted(input.readablePaths),
      writable_paths: uniqueSorted(input.writablePaths),
      wave_input_digest: input.waveInputDigest,
      project_policy_digest: input.projectPolicyDigest,
      plan_digest: input.planDigest,
      environment_gates: input.environmentGates.map(normalizeGate).sort(byField((gate) => gate.gate_id)),
      actors: input.actors.map(normalizeActor).sort(byField((actor) => actor.actor_role)),
      capabilities: input.capabilities
        .map((grant) => ({ capability: grant.capability, enforcement: grant.enforcement }))
        .sort(byField((grant) => grant.capability)),
      budgets: {
        attempts: input.budgets.attempts,
        reviews: input.budgets.reviews,
        transitions: input.budgets.transitions,
      },
      stop_rules: [...input.stopRules],
      result_schemas: uniqueSorted(input.resultSchemas),
    };
    const digest = sha256Hex(canonicalJsonBytes(content));
    return validateSchema<H1Harness>("harness", { ...content, digest });
  });
  return committed.artifact;
}

export function classifyHarnessDrift(current: H1Harness, facts: HarnessFacts): HarnessDrift {
  const extraPaths = (facts.requestedWritablePaths ?? []).filter((path) => !matchesAnyGlob(path, current.writable_paths));
  const extraCapabilities = (facts.requestedCapabilities ?? []).filter(
    (capability) => !current.capabilities.some((grant) => grant.capability === capability),
  );
  if (extraPaths.length > 0 || extraCapabilities.length > 0) {
    return {
      kind: "AUTHORITY_EXPANSION",
      reason: `The requested authority exceeds the sealed Harness: ${[...extraPaths, ...extraCapabilities].join(", ")}.`,
      childLoopRequired: true,
    };
  }
  if (facts.planDigest !== current.plan_digest) {
    return { kind: "PLAN_CHANGE", reason: "The plan changed since the Harness was sealed.", nextPhase: "PLANNED" };
  }
  if (facts.waveInputDigest !== current.wave_input_digest || facts.projectPolicyDigest !== current.project_policy_digest) {
    return {
      kind: "FACT_REFRESH",
      reason: "The WaveInput or project policy changed since the Harness was sealed.",
      nextPhase: "HARNESSING",
    };
  }
  return { kind: "NONE" };
}

function denied(code: "HARNESS_REQUIRED" | "HARNESS_DRIFT" | "AUTHORIZATION_REQUIRED", reason: string): GateDecision {
  return { allowed: false, code, reason };
}

function enforcementFor(harness: H1Harness, operation: GateOperation): EnforcementClass {
  const capability = OPERATION_CAPABILITY[operation];
  return harness.capabilities.find((grant) => grant.capability === capability)?.enforcement ?? "ORCHESTRATION_ONLY";
}

function evaluateH0Gate(harness: H0Harness, operation: GateOperation): GateDecision {
  switch (operation) {
    case "TRANSITION":
      return { allowed: true, harnessDigest: harness.digest, enforcement: "ORCHESTRATION_ONLY" };
    case "EXTERNAL_ACTION":
    case "PHYSICAL_ACTION":
      return denied("AUTHORIZATION_REQUIRED", "External and physical actions require scoped authorization outside discovery.");
    default:
      return denied("HARNESS_REQUIRED", "A sealed execution Harness (H1) is required for this operation.");
  }
}

function evaluateH1Gate(harness: H1Harness, request: GateRequest): GateDecision {
  const { operation, actorRole, path, facts } = request;
  if (facts.harnessDigest !== harness.digest) {
    return denied("HARNESS_DRIFT", "The runtime Harness digest no longer matches the sealed Harness.");
  }
  if (facts.waveInputDigest !== harness.wave_input_digest) {
    return denied("HARNESS_DRIFT", "The WaveInput drifted from the sealed Harness.");
  }
  if (facts.projectPolicyDigest !== harness.project_policy_digest) {
    return denied("HARNESS_DRIFT", "The project policy drifted from the sealed Harness.");
  }
  if (facts.planDigest !== harness.plan_digest) {
    return denied("HARNESS_DRIFT", "The plan drifted from the sealed Harness.");
  }
  if (operation === "EXTERNAL_ACTION" || operation === "PHYSICAL_ACTION") {
    return denied("AUTHORIZATION_REQUIRED", "External and physical actions require a scoped authorization envelope.");
  }

  const actor = harness.actors.find((grant) => grant.actor_role === actorRole);
  if (actor === undefined) {
    return denied("AUTHORIZATION_REQUIRED", `The actor role ${actorRole} is not granted by the Harness.`);
  }
  const capability = OPERATION_CAPABILITY[operation];
  if (!actor.capabilities.includes(capability)) {
    return denied("AUTHORIZATION_REQUIRED", `The actor role ${actorRole} lacks the ${capability} capability.`);
  }

  if (operation === "SOURCE_WRITE") {
    if (facts.activeWriteWave) {
      return denied("AUTHORIZATION_REQUIRED", "A write Wave is active; direct source writes are blocked.");
    }
    if (facts.attemptsUsed >= harness.budgets.attempts) {
      return denied("AUTHORIZATION_REQUIRED", "The attempt budget is exhausted.");
    }
    if (path === undefined || !matchesAnyGlob(path, harness.writable_paths)) {
      return denied("AUTHORIZATION_REQUIRED", `The path ${path ?? "<none>"} is outside the writable scope.`);
    }
  }
  if (operation === "TRANSITION" && facts.transitionsUsed >= harness.budgets.transitions) {
    return denied("AUTHORIZATION_REQUIRED", "The transition budget is exhausted.");
  }
  if (operation === "FINALIZE") {
    try {
      assertFinalizeGates(harness.environment_gates, facts.evidence);
    } catch (error) {
      return denied("HARNESS_DRIFT", error instanceof Error ? error.message : "Finalize gates are unsatisfied.");
    }
  }
  return { allowed: true, harnessDigest: harness.digest, enforcement: enforcementFor(harness, operation) };
}

export function evaluateGate(request: GateRequest): GateDecision {
  const { harness, operation } = request;
  if (harness === null) {
    return denied("HARNESS_REQUIRED", "No Harness governs this operation.");
  }
  if (recomputeDigest(harness) !== harness.digest) {
    return denied("HARNESS_DRIFT", "The Harness digest does not match its content.");
  }
  return harness.kind === "H0" ? evaluateH0Gate(harness, operation) : evaluateH1Gate(harness, request);
}

function assertAcyclic(gates: readonly GateRequirement[], byId: ReadonlyMap<string, GateRequirement>): void {
  const state = new Map<string, "VISITING" | "DONE">();
  const visit = (id: string, stack: readonly string[]): void => {
    const status = state.get(id);
    if (status === "DONE") return;
    if (status === "VISITING") {
      throw new LoopError("SCHEMA_INVALID", "The environment gate graph contains a cycle.", { cycle: [...stack, id] });
    }
    state.set(id, "VISITING");
    for (const dependency of byId.get(id)?.depends_on ?? []) {
      visit(dependency, [...stack, id]);
    }
    state.set(id, "DONE");
  };
  for (const gate of gates) visit(gate.gate_id, []);
}

export function validateEnvironmentDag(gates: readonly GateRequirement[]): void {
  const byId = new Map<string, GateRequirement>();
  for (const gate of gates) {
    if (byId.has(gate.gate_id)) {
      throw new LoopError("SCHEMA_INVALID", "Environment gate identifiers must be unique.", { gate_id: gate.gate_id });
    }
    byId.set(gate.gate_id, gate);
  }
  for (const gate of gates) {
    if (gate.owner === "NOT_APPLICABLE" && (gate.not_applicable_reason === undefined || gate.not_applicable_reason === "")) {
      throw new LoopError("SCHEMA_INVALID", "A NOT_APPLICABLE gate requires a documented reason.", { gate_id: gate.gate_id });
    }
    for (const dependency of gate.depends_on) {
      if (!byId.has(dependency)) {
        throw new LoopError("SCHEMA_INVALID", "An environment gate depends on a missing gate.", {
          gate_id: gate.gate_id,
          dependency,
        });
      }
    }
    if (PHYSICAL_NODES.has(gate.node) && gate.owner === "LOOP_REQUIRED") {
      if (gate.requires_new_action) {
        throw new LoopError("SCHEMA_INVALID", "A new physical action cannot be owned by the Loop; it must be RELEASE_REQUIRED.", {
          gate_id: gate.gate_id,
          node: gate.node,
        });
      }
      if (gate.evidence_ids.length === 0) {
        throw new LoopError("SCHEMA_INVALID", "A Loop-owned physical gate must reference existing immutable evidence.", {
          gate_id: gate.gate_id,
          node: gate.node,
        });
      }
    }
  }
  assertAcyclic(gates, byId);
}

export function summarizeEnvironmentGates(
  gates: readonly GateRequirement[],
  evidence: readonly EvidenceRecord[],
): EnvironmentGateResult {
  validateEnvironmentDag(gates);
  const satisfying = new Set(evidence.filter((record) => SATISFYING_EVIDENCE.has(record.result)).map((record) => record.evidence_id));
  const loopSatisfied: string[] = [];
  const releasePending: string[] = [];
  const notApplicable: string[] = [];
  for (const gate of gates) {
    if (gate.owner === "NOT_APPLICABLE") {
      notApplicable.push(gate.gate_id);
    } else if (gate.owner === "RELEASE_REQUIRED") {
      releasePending.push(gate.gate_id);
    } else if (gate.evidence_ids.length > 0 && gate.evidence_ids.every((id) => satisfying.has(id))) {
      loopSatisfied.push(gate.gate_id);
    }
  }
  return {
    loopSatisfied: loopSatisfied.sort(),
    releasePending: releasePending.sort(),
    notApplicable: notApplicable.sort(),
  };
}

export function assertFinalizeGates(gates: readonly GateRequirement[], evidence: readonly EvidenceRecord[]): void {
  validateEnvironmentDag(gates);
  const satisfying = new Set(evidence.filter((record) => SATISFYING_EVIDENCE.has(record.result)).map((record) => record.evidence_id));
  for (const gate of gates) {
    if (gate.owner !== "LOOP_REQUIRED") continue;
    if (gate.evidence_ids.length === 0) {
      throw new LoopError("HARNESS_DRIFT", "A LOOP_REQUIRED gate has no evidence at Finalize.", { gate_id: gate.gate_id });
    }
    for (const id of gate.evidence_ids) {
      if (!satisfying.has(id)) {
        throw new LoopError("HARNESS_DRIFT", "A LOOP_REQUIRED gate is missing current passing evidence at Finalize.", {
          gate_id: gate.gate_id,
          evidence_id: id,
        });
      }
    }
  }
}
