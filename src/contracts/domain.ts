import { createHash } from "node:crypto";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type Digest = Brand<string, "Digest">;
export type LoopId = Brand<string, "LoopId">;

export const LOOP_PHASES = [
  "NEW", "ORIENTING", "CONTRACTED", "PLANNED", "PLAN_REVIEW", "HARNESSING",
  "IMPLEMENTING", "VERIFYING", "REVIEWING", "REMEDIATING", "FINALIZING",
  "HANDOFF_READY", "CANCELLED",
] as const;
export type LoopPhase = (typeof LOOP_PHASES)[number];

export const LOOP_STATUSES = [
  "ACTIVE", "DEGRADED", "PAUSED", "BLOCKED", "NON_CONVERGENT", "COMPLETE", "CANCELLED",
] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export const ENVIRONMENT_NODES = [
  "SOURCE_STATIC", "UNIT_COMPONENT", "REPLAY", "SIMULATION", "SIL", "HIL",
  "BENCH", "CLOSED_COURSE", "REAL_VEHICLE_ROBOT",
] as const;
export type EnvironmentNode = (typeof ENVIRONMENT_NODES)[number];
export type GateOwner = "LOOP_REQUIRED" | "RELEASE_REQUIRED" | "NOT_APPLICABLE";
export type EnforcementClass = "HOST_ENFORCED" | "RUNTIME_ENFORCED" | "ORCHESTRATION_ONLY";
export type MarkdownLanguage = "en-US" | "zh-CN";

export interface LoopRecord {
  schema_version: 2;
  loop_id: LoopId;
  parent_loop_id: LoopId | null;
  phase: LoopPhase;
  status: LoopStatus;
  markdown_language: MarkdownLanguage;
  last_event_sequence: number;
  last_event_hash: Digest;
  current_harness_revision: number | null;
  current_harness_digest: Digest | null;
  handoff_digest: Digest | null;
}

export interface EventRecord {
  schema_version: 1;
  sequence: number;
  event_id: string;
  loop_id: LoopId;
  type: string;
  actor_role: string;
  timestamp: string;
  previous_hash: Digest;
  payload: Readonly<{ kind: string; data_digest: Digest }>;
  hash: Digest;
}

export type LoopErrorCode =
  | "INVALID_LOOP_ID"
  | "INVALID_MARKDOWN_LANGUAGE"
  | "SCHEMA_INVALID"
  | "LOCK_BUSY"
  | "RECONCILE_REQUIRED"
  | "CAS_MISMATCH"
  | "INVALID_TRANSITION"
  | "HARNESS_REQUIRED"
  | "HARNESS_DRIFT"
  | "DISPATCH_REJECTED"
  | "STALE_AGENT_RESULT"
  | "STALE_HANDOFF"
  | "AUTHORIZATION_REQUIRED"
  | "NON_CONVERGENT";

export class LoopError extends Error {
  constructor(
    readonly code: LoopErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "LoopError";
  }

  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

export function sha256Hex(data: Uint8Array | string): Digest {
  return createHash("sha256").update(data).digest("hex") as Digest;
}
