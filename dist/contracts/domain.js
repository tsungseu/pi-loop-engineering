import { createHash } from "node:crypto";
export class LoopError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "LoopError";
    }
}
export function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
//# sourceMappingURL=domain.js.map