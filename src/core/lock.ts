import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { LoopError } from "../contracts/domain.js";
import { atomicWriteFile, atomicWriteJson, canonicalJsonBytes } from "./atomic-json.js";

export interface LockClock {
  now(): Date;
}

export interface LockOwner {
  ownerId: string;
  nonce: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
  fencingToken: number;
}

export interface LockGuardOwner {
  ownerId: string;
  nonce: string;
  pid: number;
  hostId: string | null;
  acquiredAt: string;
  expiresAt: string;
}

export interface AcquireLockOptions {
  target: string;
  ownerId: string;
  ttlMs: number;
  clock?: LockClock;
}

export interface AcquireLockGuardOptions extends AcquireLockOptions {}

export type ReconcileFaultPoint = "after-record" | "after-quarantine";

export interface ReconcileLockOptions {
  target: string;
  expectedNonce: string | null;
  clock?: LockClock;
  fault?: (point: ReconcileFaultPoint) => void | Promise<void>;
}

export interface ReconcileLockGuardOptions extends ReconcileLockOptions {}

export interface ReconcileFencingCounterOptions {
  target: string;
  clock?: LockClock;
}

export type LockReconciliationOutcome = "EXPIRED_OWNER_FENCED" | "MALFORMED_OWNER_QUARANTINED";

export interface LockReconciliation {
  target: string;
  outcome: LockReconciliationOutcome;
  quarantinedPath: string;
  recordPath: string;
  fencingToken: number | null;
  reconciledAt: string;
}

export interface LockGuardReconciliation {
  target: string;
  outcome: "EXPIRED_GUARD_FENCED" | "MALFORMED_GUARD_QUARANTINED";
  quarantinedPath: string;
  recordPath: string;
  reconciledAt: string;
}

export interface FencingCounterReconciliation {
  target: string;
  restoredToken: number;
  quarantinedPath: string | null;
  recordPath: string;
  reconciledAt: string;
}

export interface LockLease {
  readonly target: string;
  readonly owner: LockOwner;
  assertCurrent(): Promise<void>;
  runExclusive<T>(action: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
}

export interface LockGuardLease {
  readonly target: string;
  readonly owner: LockGuardOwner;
  release(): Promise<void>;
}

export interface LockTarget extends AcquireLockOptions {
  kind: "REPOSITORY" | "LOOP";
}

const systemClock: LockClock = { now: () => new Date() };
const PARENT_GUARD_ATTEMPTS = 1_000;
const INTERNAL_GUARD_TTL_MS = 24 * 60 * 60 * 1_000;
const GUARD_OWNER_PUBLICATION_ATTEMPTS = 10;
const localGuardTails = new Map<string, Promise<void>>();
const execFileAsync = promisify(execFile);
let hostIdentityPromise: Promise<string | null> | undefined;

function lockDirectory(target: string): string {
  return `${target}.lock`;
}

function ownerPath(target: string): string {
  return join(lockDirectory(target), "owner.json");
}

function guardDirectory(target: string): string {
  return join(dirname(target), ".pai-loop-fence.lock");
}

function guardOwnerPath(target: string): string {
  return join(guardDirectory(target), "owner.json");
}

function fenceCounterPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.fence.json`);
}

function fenceHistoryPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.fence-history`);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function computeHostIdentity(): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("reg.exe", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ], { windowsHide: true });
      const match = /MachineGuid\s+REG_SZ\s+(?<id>[^\r\n]+)$/imu.exec(stdout);
      return match?.groups?.id === undefined ? null : `windows:${match.groups.id.trim().toLowerCase()}`;
    }
    if (process.platform === "linux") {
      const id = (await readFile("/etc/machine-id", "utf8")).trim().toLowerCase();
      return /^[0-9a-f]{32}$/u.test(id) ? `linux:${id}` : null;
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { windowsHide: true });
      const match = /"IOPlatformUUID"\s*=\s*"(?<id>[^"]+)"/u.exec(stdout);
      return match?.groups?.id === undefined ? null : `darwin:${match.groups.id.toLowerCase()}`;
    }
  } catch {
    // Missing or inaccessible host identity must make reconciliation fail closed.
  }
  return null;
}

async function localHostIdentity(): Promise<string | null> {
  hostIdentityPromise ??= computeHostIdentity();
  return hostIdentityPromise;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function nowMilliseconds(clock: LockClock): number {
  const value = clock.now().getTime();
  if (!Number.isFinite(value)) throw new TypeError("Lock clock returned an invalid time.");
  return value;
}

function validCommonOwner(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort())
    && typeof value.ownerId === "string" && value.ownerId.length > 0
    && typeof value.nonce === "string" && value.nonce.length > 0
    && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid >= 0
    && typeof value.acquiredAt === "string" && Number.isFinite(Date.parse(value.acquiredAt))
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
    && Date.parse(value.expiresAt as string) > Date.parse(value.acquiredAt as string);
}

function parseOwner(value: unknown): LockOwner | null {
  if (!isPlainRecord(value) || !validCommonOwner(value, ["ownerId", "nonce", "pid", "acquiredAt", "expiresAt", "fencingToken"])) return null;
  if (typeof value.fencingToken !== "number" || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) return null;
  return value as unknown as LockOwner;
}

function parseGuardOwner(value: unknown): LockGuardOwner | null {
  if (!isPlainRecord(value)
    || !validCommonOwner(value, ["ownerId", "nonce", "pid", "hostId", "acquiredAt", "expiresAt"])
    || (value.hostId !== null && (typeof value.hostId !== "string" || value.hostId.length === 0))) return null;
  return value as unknown as LockGuardOwner;
}

type OwnerRead<T> = { kind: "VALID"; owner: T } | { kind: "MALFORMED" };

async function readJsonOwner<T>(path: string, parser: (value: unknown) => T | null): Promise<OwnerRead<T>> {
  try {
    const owner = parser(JSON.parse(await readFile(path, "utf8")));
    return owner === null ? { kind: "MALFORMED" } : { kind: "VALID", owner };
  } catch (error) {
    if (error instanceof SyntaxError || ["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) return { kind: "MALFORMED" };
    throw error;
  }
}

function sameGuardOwner(left: LockGuardOwner, right: LockGuardOwner): boolean {
  return left.nonce === right.nonce;
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return left.nonce === right.nonce && left.fencingToken === right.fencingToken;
}

function processLiveness(pid: number): "ALIVE" | "DEAD" | "UNVERIFIABLE" {
  try {
    process.kill(pid, 0);
    return "ALIVE";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "DEAD" : "UNVERIFIABLE";
  }
}

async function writeInternalJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, canonicalJsonBytes(value));
}

class DirectoryGuardLease implements LockGuardLease {
  constructor(readonly target: string, readonly owner: LockGuardOwner) {}

  async release(): Promise<void> {
    const current = await readJsonOwner(guardOwnerPath(this.target), parseGuardOwner);
    if (current.kind !== "VALID" || !sameGuardOwner(current.owner, this.owner)) {
      throw new LoopError("CAS_MISMATCH", "The critical guard owner changed before release.", {
        target: this.target,
      });
    }
    const releasedPath = `${guardDirectory(this.target)}.released-${this.owner.nonce}`;
    try {
      await rename(guardDirectory(this.target), releasedPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new LoopError("CAS_MISMATCH", "The critical guard changed before release.", { target: this.target });
      }
      throw error;
    }
    await rm(releasedPath, { recursive: true, force: false });
  }
}

export async function acquireLockGuard(options: AcquireLockGuardOptions): Promise<LockGuardLease> {
  if (options.ownerId.length === 0) throw new TypeError("Guard owner ID must not be empty.");
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) throw new TypeError("Guard TTL must be a positive integer.");
  const clock = options.clock ?? systemClock;
  const now = nowMilliseconds(clock);
  const hostId = await localHostIdentity();
  await mkdir(dirname(options.target), { recursive: true });
  try {
    await mkdir(guardDirectory(options.target));
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    let current = await readJsonOwner(guardOwnerPath(options.target), parseGuardOwner);
    // mkdir is the guard's atomic claim; owner.json is published immediately
    // afterwards. Give that bounded publication window a chance to close before
    // classifying an actually orphaned directory as malformed.
    for (let attempt = 1; current.kind === "MALFORMED" && attempt < GUARD_OWNER_PUBLICATION_ATTEMPTS; attempt += 1) {
      await delay(1);
      current = await readJsonOwner(guardOwnerPath(options.target), parseGuardOwner);
    }
    if (current.kind === "VALID" && Date.parse(current.owner.expiresAt) > now) {
      throw new LoopError("LOCK_BUSY", "The short critical guard is held by an unexpired owner.", {
        target: options.target,
        owner_id: current.owner.ownerId,
        expires_at: current.owner.expiresAt,
      });
    }
    throw new LoopError("RECONCILE_REQUIRED", "The short critical guard requires explicit reconciliation.", {
      target: options.target,
      expected_nonce: current.kind === "VALID" ? current.owner.nonce : null,
    });
  }
  const owner: LockGuardOwner = {
    ownerId: options.ownerId,
    nonce: randomUUID(),
    pid: process.pid,
    hostId,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + options.ttlMs).toISOString(),
  };
  await atomicWriteJson(guardOwnerPath(options.target), owner);
  return new DirectoryGuardLease(options.target, owner);
}

async function withOsParentGuard<T>(target: string, clock: LockClock, action: () => Promise<T>): Promise<T> {
  let guard: LockGuardLease | undefined;
  for (let attempt = 0; attempt < PARENT_GUARD_ATTEMPTS; attempt += 1) {
    try {
      guard = await acquireLockGuard({
        target,
        ownerId: `critical-${process.pid}-${randomUUID()}`,
        ttlMs: INTERNAL_GUARD_TTL_MS,
        clock,
      });
      break;
    } catch (error) {
      if (!(error instanceof LoopError) || error.code !== "LOCK_BUSY") throw error;
      await delay(1);
    }
  }
  if (guard === undefined) {
    throw new LoopError("LOCK_BUSY", "The short critical guard remained busy.", { target });
  }
  try {
    return await action();
  } finally {
    await guard.release();
  }
}

async function withParentGuard<T>(target: string, clock: LockClock, action: () => Promise<T>): Promise<T> {
  const key = guardDirectory(target);
  const previous = localGuardTails.get(key) ?? Promise.resolve();
  let unlock: (() => void) | undefined;
  const held = new Promise<void>((resolvePromise) => { unlock = resolvePromise; });
  const tail = previous.then(async () => held);
  localGuardTails.set(key, tail);
  await previous;
  try {
    return await withOsParentGuard(target, clock, action);
  } finally {
    unlock?.();
    if (localGuardTails.get(key) === tail) localGuardTails.delete(key);
  }
}

async function historyHighWater(target: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(fenceHistoryPath(target), { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  let highWater = 0;
  for (const entry of entries) {
    const match = /^(?<token>[1-9][0-9]*)\.token$/u.exec(entry.name);
    const token = match?.groups?.token === undefined ? Number.NaN : Number(match.groups.token);
    if (!entry.isFile() || !Number.isSafeInteger(token) || token < 1) {
      throw new LoopError("RECONCILE_REQUIRED", "The immutable fencing history is malformed.", { target });
    }
    highWater = Math.max(highWater, token);
  }
  return highWater;
}

type CounterRead = { kind: "MISSING" } | { kind: "VALID"; token: number } | { kind: "MALFORMED" };

async function readCounter(target: string): Promise<CounterRead> {
  try {
    const value: unknown = JSON.parse(await readFile(fenceCounterPath(target), "utf8"));
    if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.fencingToken) || Number(value.fencingToken) < 0) {
      return { kind: "MALFORMED" };
    }
    return { kind: "VALID", token: Number(value.fencingToken) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "MISSING" };
    if (error instanceof SyntaxError) return { kind: "MALFORMED" };
    throw error;
  }
}

async function recordFenceToken(target: string, token: number): Promise<void> {
  await mkdir(fenceHistoryPath(target), { recursive: true });
  const handle = await open(join(fenceHistoryPath(target), `${token}.token`), "wx", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function allocateFencingToken(target: string): Promise<number> {
  const highWater = await historyHighWater(target);
  const counter = await readCounter(target);
  if (counter.kind === "MALFORMED" || (counter.kind === "MISSING" && highWater !== 0)
    || (counter.kind === "VALID" && counter.token !== highWater)) {
    throw new LoopError("RECONCILE_REQUIRED", "The fencing counter must be reconciled from immutable history.", {
      target,
      history_high_water: highWater,
    });
  }
  if (highWater === Number.MAX_SAFE_INTEGER) {
    throw new LoopError("RECONCILE_REQUIRED", "The fencing counter is exhausted.", { target, terminal: true });
  }
  const next = highWater + 1;
  await recordFenceToken(target, next);
  await atomicWriteJson(fenceCounterPath(target), { fencingToken: next });
  return next;
}

function lockStateError(target: string, ownerRead: OwnerRead<LockOwner>, now: number): LoopError {
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

class DirectoryLockLease implements LockLease {
  constructor(
    readonly target: string,
    readonly owner: LockOwner,
    readonly clock: LockClock,
  ) {}

  async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    return withParentGuard(this.target, this.clock, async () => {
      const current = await readJsonOwner(ownerPath(this.target), parseOwner);
      const now = nowMilliseconds(this.clock);
      if (current.kind !== "VALID" || !sameOwner(current.owner, this.owner) || Date.parse(current.owner.expiresAt) <= now) {
        throw new LoopError("CAS_MISMATCH", "The lock lease is stale or expired.", {
          target: this.target,
          fencing_token: this.owner.fencingToken,
        });
      }
      return action();
    });
  }

  async assertCurrent(): Promise<void> {
    await this.runExclusive(async () => undefined);
  }

  async release(): Promise<void> {
    await withParentGuard(this.target, this.clock, async () => {
      const current = await readJsonOwner(ownerPath(this.target), parseOwner);
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

export async function acquireLock(options: AcquireLockOptions): Promise<LockLease> {
  if (options.ownerId.length === 0) throw new TypeError("Lock owner ID must not be empty.");
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) throw new TypeError("Lock TTL must be a positive integer.");
  const clock = options.clock ?? systemClock;
  // A positive, unexpired owner observation is sufficient for a conservative
  // busy result and avoids waiting behind the current owner's mutation guard.
  const observed = await readJsonOwner(ownerPath(options.target), parseOwner);
  const observedNow = nowMilliseconds(clock);
  if (observed.kind === "VALID" && Date.parse(observed.owner.expiresAt) > observedNow) {
    throw lockStateError(options.target, observed, observedNow);
  }
  return withParentGuard(options.target, clock, async () => {
    const now = nowMilliseconds(clock);
    try {
      await mkdir(lockDirectory(options.target));
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      throw lockStateError(options.target, await readJsonOwner(ownerPath(options.target), parseOwner), now);
    }
    const fencingToken = await allocateFencingToken(options.target);
    const owner: LockOwner = {
      ownerId: options.ownerId,
      nonce: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + options.ttlMs).toISOString(),
      fencingToken,
    };
    await atomicWriteJson(ownerPath(options.target), owner);
    return new DirectoryLockLease(options.target, owner, clock);
  });
}

async function reconcileEntry(
  options: ReconcileLockOptions,
  path: string,
  current: OwnerRead<LockOwner>,
  lockIsDirectory: boolean,
  now: number,
): Promise<LockReconciliation> {
  let outcome: LockReconciliationOutcome;
  let fencingToken: number | null;
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
  } else {
    if (options.expectedNonce !== null) {
      throw new LoopError("CAS_MISMATCH", "Malformed lock reconciliation requires an explicit null nonce.", { target: options.target });
    }
    outcome = "MALFORMED_OWNER_QUARANTINED";
    fencingToken = null;
  }
  const reconciledAt = new Date(now).toISOString();
  const id = randomUUID();
  const quarantinePath = `${path}.quarantine-${id}`;
  const recordPath = `${path}.reconciliation-${id}.json`;
  await writeInternalJson(recordPath, {
    outcome,
    reconciledAt,
    expectedNonce: options.expectedNonce,
    fencingToken,
    quarantinePath,
    entryKind: lockIsDirectory ? "directory" : "non-directory",
  });
  await options.fault?.("after-record");
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new LoopError("CAS_MISMATCH", "The lock changed before reconciliation completed.", { target: options.target });
    }
    throw error;
  }
  await options.fault?.("after-quarantine");
  return { target: options.target, outcome, quarantinedPath: quarantinePath, recordPath, fencingToken, reconciledAt };
}

export async function reconcileLock(options: ReconcileLockOptions): Promise<LockReconciliation> {
  const clock = options.clock ?? systemClock;
  return withParentGuard(options.target, clock, async () => {
    const now = nowMilliseconds(clock);
    let lockIsDirectory: boolean;
    try {
      lockIsDirectory = (await lstat(lockDirectory(options.target))).isDirectory();
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new LoopError("CAS_MISMATCH", "The lock no longer exists for reconciliation.", { target: options.target });
      }
      throw error;
    }
    const current = lockIsDirectory
      ? await readJsonOwner(ownerPath(options.target), parseOwner)
      : { kind: "MALFORMED" } as const;
    return reconcileEntry(options, lockDirectory(options.target), current, lockIsDirectory, now);
  });
}

export async function reconcileLockGuard(options: ReconcileLockGuardOptions): Promise<LockGuardReconciliation> {
  const clock = options.clock ?? systemClock;
  const now = nowMilliseconds(clock);
  let isDirectory: boolean;
  try {
    isDirectory = (await lstat(guardDirectory(options.target))).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new LoopError("CAS_MISMATCH", "The critical guard no longer exists.", { target: options.target });
    }
    throw error;
  }
  const current = isDirectory
    ? await readJsonOwner(guardOwnerPath(options.target), parseGuardOwner)
    : { kind: "MALFORMED" } as const;
  let outcome: LockGuardReconciliation["outcome"];
  if (current.kind === "VALID") {
    if (Date.parse(current.owner.expiresAt) > now) {
      throw new LoopError("LOCK_BUSY", "An unexpired critical guard cannot be reconciled.", { target: options.target });
    }
    if (options.expectedNonce !== current.owner.nonce) {
      throw new LoopError("CAS_MISMATCH", "The critical guard nonce changed before reconciliation.", { target: options.target });
    }
    const localHostId = await localHostIdentity();
    if (localHostId === null || current.owner.hostId === null || current.owner.hostId !== localHostId) {
      throw new LoopError("RECONCILE_REQUIRED", "The expired critical guard owner host cannot be verified as local.", {
        target: options.target,
        owner_pid: current.owner.pid,
      });
    }
    const liveness = processLiveness(current.owner.pid);
    if (liveness === "ALIVE") {
      throw new LoopError("LOCK_BUSY", "The expired critical guard owner process can still resume.", {
        target: options.target,
        owner_pid: current.owner.pid,
      });
    }
    if (liveness === "UNVERIFIABLE") {
      throw new LoopError("RECONCILE_REQUIRED", "The expired critical guard owner process liveness is unverifiable.", {
        target: options.target,
        owner_pid: current.owner.pid,
      });
    }
    outcome = "EXPIRED_GUARD_FENCED";
  } else {
    throw new LoopError("RECONCILE_REQUIRED", "A malformed critical guard has no reliable process-death proof.", {
      target: options.target,
    });
  }
  const reconciledAt = new Date(now).toISOString();
  const id = randomUUID();
  const quarantinePath = `${guardDirectory(options.target)}.quarantine-${id}`;
  const recordPath = `${guardDirectory(options.target)}.reconciliation-${id}.json`;
  await writeInternalJson(recordPath, { outcome, reconciledAt, expectedNonce: options.expectedNonce, quarantinePath });
  await options.fault?.("after-record");
  await rename(guardDirectory(options.target), quarantinePath);
  await options.fault?.("after-quarantine");
  return { target: options.target, outcome, quarantinedPath: quarantinePath, recordPath, reconciledAt };
}

export async function reconcileFencingCounter(options: ReconcileFencingCounterOptions): Promise<FencingCounterReconciliation> {
  const clock = options.clock ?? systemClock;
  return withParentGuard(options.target, clock, async () => {
    const highWater = await historyHighWater(options.target);
    if (highWater === Number.MAX_SAFE_INTEGER) {
      throw new LoopError("RECONCILE_REQUIRED", "The fencing counter is exhausted.", { target: options.target, terminal: true });
    }
    const reconciledAt = new Date(nowMilliseconds(clock)).toISOString();
    const id = randomUUID();
    const counterPath = fenceCounterPath(options.target);
    const recordPath = `${counterPath}.reconciliation-${id}.json`;
    let quarantinedPath: string | null = null;
    const counter = await readCounter(options.target);
    if (counter.kind !== "MISSING") quarantinedPath = `${counterPath}.quarantine-${id}`;
    await writeInternalJson(recordPath, { restoredToken: highWater, reconciledAt, quarantinedPath });
    if (quarantinedPath !== null) await rename(counterPath, quarantinedPath);
    await atomicWriteJson(counterPath, { fencingToken: highWater });
    return { target: options.target, restoredToken: highWater, quarantinedPath, recordPath, reconciledAt };
  });
}

export async function withOrderedLocks<T>(
  repository: LockTarget,
  loop: LockTarget | undefined,
  action: (leases: readonly LockLease[]) => Promise<T>,
): Promise<T> {
  if (repository.kind !== "REPOSITORY" || (loop !== undefined && loop.kind !== "LOOP")) {
    throw new LoopError("RECONCILE_REQUIRED", "Repository lock must be acquired before Loop lock.");
  }
  const leases: LockLease[] = [];
  try {
    leases.push(await acquireLock(repository));
    if (loop !== undefined) leases.push(await acquireLock(loop));
    return await action(leases);
  } finally {
    for (const lease of [...leases].reverse()) await lease.release();
  }
}
