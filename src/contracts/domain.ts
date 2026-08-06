import { createHash } from "node:crypto";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type Digest = Brand<string, "Digest">;
export type LoopId = Brand<string, "LoopId">;

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
}

export function sha256Hex(data: Uint8Array | string): Digest {
  return createHash("sha256").update(data).digest("hex") as Digest;
}
