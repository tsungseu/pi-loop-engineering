import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LoopError } from "../contracts/domain.js";
import { atomicWriteJson } from "./atomic-json.js";
const systemClock = { now: () => new Date() };
const PARENT_GUARD_ATTEMPTS = 1_000;
function lockDirectory(target) {
    return `${target}.lock`;
}
function ownerPath(target) {
    return join(lockDirectory(target), "owner.json");
}
function parentGuardPath(target) {
    return join(dirname(target), ".pai-loop-fence.lock");
}
function fenceCounterPath(target) {
    return join(dirname(target), `.${basename(target)}.fence.json`);
}
function errorCode(error) {
    return error.code;
}
function delay(milliseconds) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
async function withParentGuard(target, action) {
    const parent = dirname(target);
    const guard = parentGuardPath(target);
    await mkdir(parent, { recursive: true });
    let acquired = false;
    for (let attempt = 0; attempt < PARENT_GUARD_ATTEMPTS; attempt += 1) {
        try {
            await mkdir(guard);
            acquired = true;
            break;
        }
        catch (error) {
            if (errorCode(error) !== "EEXIST")
                throw error;
            await delay(1);
        }
    }
    if (!acquired) {
        throw new LoopError("RECONCILE_REQUIRED", "The parent fencing lock requires reconciliation.", {
            target,
            guard,
        });
    }
    try {
        return await action();
    }
    finally {
        await rmdir(guard);
    }
}
function isPlainRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function parseOwner(value) {
    if (!isPlainRecord(value))
        return null;
    const keys = Object.keys(value).sort();
    const expectedKeys = ["acquiredAt", "expiresAt", "fencingToken", "nonce", "ownerId", "pid"];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys))
        return null;
    if (typeof value.ownerId !== "string" || value.ownerId.length === 0
        || typeof value.nonce !== "string" || value.nonce.length === 0
        || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 0
        || typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt))
        || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
        || typeof value.fencingToken !== "number" || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1)
        return null;
    if (Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt))
        return null;
    return value;
}
async function readOwner(target) {
    try {
        const value = JSON.parse(await readFile(ownerPath(target), "utf8"));
        const owner = parseOwner(value);
        return owner === null ? { kind: "MALFORMED" } : { kind: "VALID", owner };
    }
    catch (error) {
        if (error instanceof SyntaxError || errorCode(error) === "ENOENT")
            return { kind: "MALFORMED" };
        throw error;
    }
}
function nowMilliseconds(clock) {
    const value = clock.now().getTime();
    if (!Number.isFinite(value))
        throw new TypeError("Lock clock returned an invalid time.");
    return value;
}
function lockStateError(target, ownerRead, now) {
    if (ownerRead.kind === "VALID" && Date.parse(ownerRead.owner.expiresAt) > now) {
        return new LoopError("LOCK_BUSY", "The lock is held by an unexpired owner.", {
            target,
            owner_id: ownerRead.owner.ownerId,
            expires_at: ownerRead.owner.expiresAt,
            fencing_token: ownerRead.owner.fencingToken,
        });
    }
    return new LoopError("RECONCILE_REQUIRED", "The existing lock must be reconciled before acquisition.", {
        target,
        owner_state: ownerRead.kind,
    });
}
async function allocateFencingToken(target) {
    const counterPath = fenceCounterPath(target);
    let current = 0;
    try {
        const value = JSON.parse(await readFile(counterPath, "utf8"));
        if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.fencingToken) || Number(value.fencingToken) < 0) {
            throw new LoopError("RECONCILE_REQUIRED", "The fencing counter is malformed.", { target });
        }
        current = Number(value.fencingToken);
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT")
            throw error;
    }
    if (current === Number.MAX_SAFE_INTEGER) {
        throw new LoopError("RECONCILE_REQUIRED", "The fencing counter is exhausted.", { target });
    }
    const next = current + 1;
    await atomicWriteJson(counterPath, { fencingToken: next });
    return next;
}
function sameOwner(left, right) {
    return left.nonce === right.nonce && left.fencingToken === right.fencingToken;
}
class DirectoryLockLease {
    target;
    owner;
    constructor(target, owner) {
        this.target = target;
        this.owner = owner;
    }
    async assertCurrent() {
        await withParentGuard(this.target, async () => {
            const current = await readOwner(this.target);
            if (current.kind !== "VALID" || !sameOwner(current.owner, this.owner)) {
                throw new LoopError("CAS_MISMATCH", "The lock lease is no longer current.", {
                    target: this.target,
                    fencing_token: this.owner.fencingToken,
                });
            }
        });
    }
    async release() {
        await withParentGuard(this.target, async () => {
            const current = await readOwner(this.target);
            if (current.kind !== "VALID" || !sameOwner(current.owner, this.owner)) {
                throw new LoopError("CAS_MISMATCH", "The lock owner changed before release.", {
                    target: this.target,
                    fencing_token: this.owner.fencingToken,
                });
            }
            const releasedPath = `${lockDirectory(this.target)}.released-${this.owner.fencingToken}-${randomUUID()}`;
            await rename(lockDirectory(this.target), releasedPath);
            await rm(releasedPath, { recursive: true, force: false });
        });
    }
}
export async function acquireLock(options) {
    if (options.ownerId.length === 0)
        throw new TypeError("Lock owner ID must not be empty.");
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0)
        throw new TypeError("Lock TTL must be a positive integer.");
    const clock = options.clock ?? systemClock;
    return withParentGuard(options.target, async () => {
        const now = nowMilliseconds(clock);
        try {
            await mkdir(lockDirectory(options.target));
        }
        catch (error) {
            if (errorCode(error) !== "EEXIST")
                throw error;
            throw lockStateError(options.target, await readOwner(options.target), now);
        }
        const fencingToken = await allocateFencingToken(options.target);
        const owner = {
            ownerId: options.ownerId,
            nonce: randomUUID(),
            pid: process.pid,
            acquiredAt: new Date(now).toISOString(),
            expiresAt: new Date(now + options.ttlMs).toISOString(),
            fencingToken,
        };
        await atomicWriteJson(ownerPath(options.target), owner);
        return new DirectoryLockLease(options.target, owner);
    });
}
export async function reconcileLock(options) {
    const clock = options.clock ?? systemClock;
    return withParentGuard(options.target, async () => {
        const now = nowMilliseconds(clock);
        let lockIsDirectory;
        try {
            lockIsDirectory = (await lstat(lockDirectory(options.target))).isDirectory();
        }
        catch (error) {
            if (errorCode(error) === "ENOENT") {
                throw new LoopError("CAS_MISMATCH", "The lock no longer exists for reconciliation.", {
                    target: options.target,
                });
            }
            throw error;
        }
        const current = lockIsDirectory ? await readOwner(options.target) : { kind: "MALFORMED" };
        let outcome;
        let fencingToken;
        if (current.kind === "VALID") {
            if (Date.parse(current.owner.expiresAt) > now) {
                throw new LoopError("LOCK_BUSY", "An unexpired lock cannot be reconciled.", {
                    target: options.target,
                    expires_at: current.owner.expiresAt,
                });
            }
            if (options.expectedNonce !== current.owner.nonce) {
                throw new LoopError("CAS_MISMATCH", "The lock nonce changed before reconciliation.", { target: options.target });
            }
            outcome = "EXPIRED_OWNER_FENCED";
            fencingToken = current.owner.fencingToken;
        }
        else {
            if (options.expectedNonce !== null) {
                throw new LoopError("CAS_MISMATCH", "Malformed lock reconciliation requires an explicit null nonce.", {
                    target: options.target,
                });
            }
            outcome = "MALFORMED_OWNER_QUARANTINED";
            fencingToken = null;
        }
        const reconciledAt = new Date(now).toISOString();
        const quarantinePath = `${lockDirectory(options.target)}.quarantine-${randomUUID()}`;
        const reconciliationRecord = {
            outcome,
            reconciledAt,
            expectedNonce: options.expectedNonce,
            fencingToken,
        };
        if (lockIsDirectory) {
            await atomicWriteJson(join(lockDirectory(options.target), "reconciliation.json"), reconciliationRecord);
        }
        try {
            await rename(lockDirectory(options.target), quarantinePath);
        }
        catch (error) {
            if (errorCode(error) === "ENOENT") {
                throw new LoopError("CAS_MISMATCH", "The lock changed before reconciliation completed.", {
                    target: options.target,
                });
            }
            throw error;
        }
        if (!lockIsDirectory) {
            await atomicWriteJson(`${quarantinePath}.reconciliation.json`, reconciliationRecord);
        }
        return {
            target: options.target,
            outcome,
            quarantinedPath: quarantinePath,
            fencingToken,
            reconciledAt,
        };
    });
}
export async function withOrderedLocks(repository, loop, action) {
    if (repository.kind !== "REPOSITORY" || (loop !== undefined && loop.kind !== "LOOP")) {
        throw new LoopError("RECONCILE_REQUIRED", "Repository lock must be acquired before Loop lock.");
    }
    const leases = [];
    try {
        leases.push(await acquireLock(repository));
        if (loop !== undefined)
            leases.push(await acquireLock(loop));
        return await action(leases);
    }
    finally {
        for (const lease of [...leases].reverse()) {
            await lease.release();
        }
    }
}
//# sourceMappingURL=lock.js.map