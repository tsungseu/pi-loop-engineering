import { createHash } from "node:crypto";
export const LOOP_PHASES = [
    "NEW", "ORIENTING", "CONTRACTED", "PLANNED", "PLAN_REVIEW", "HARNESSING",
    "IMPLEMENTING", "VERIFYING", "REVIEWING", "REMEDIATING", "FINALIZING",
    "HANDOFF_READY", "CANCELLED",
];
export const LOOP_STATUSES = [
    "ACTIVE", "DEGRADED", "PAUSED", "BLOCKED", "NON_CONVERGENT", "COMPLETE", "CANCELLED",
];
export const ENVIRONMENT_NODES = [
    "SOURCE_STATIC", "UNIT_COMPONENT", "REPLAY", "SIMULATION", "SIL", "HIL",
    "BENCH", "CLOSED_COURSE", "REAL_VEHICLE_ROBOT",
];
export class LoopError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "LoopError";
    }
    toString() {
        return `${this.name} [${this.code}]: ${this.message}`;
    }
}
export function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
//# sourceMappingURL=domain.js.map