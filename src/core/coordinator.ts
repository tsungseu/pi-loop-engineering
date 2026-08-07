import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LoopError, sha256Hex, type LoopId } from "../contracts/domain.js";
import { atomicWriteJson, canonicalJsonBytes } from "./atomic-json.js";
import { acquireLock, type LockClock } from "./lock.js";
import { resolveCoordinationRoot } from "./paths.js";

export interface LeaseRequest {
  loopId: LoopId;
  kind: "branch" | "path" | "integration" | "external-root";
  resources: readonly string[];
  ttlMs: number;
}

export interface RepositoryLease {
  leaseId: string;
  loopId: LoopId;
  kind: LeaseRequest["kind"];
  resources: readonly string[];
  fencingToken: number;
  expiresAt: string;
}

export interface CoordinatorRecovery {
  outcome: "CLEAN" | "EXPIRED_LEASES_RELEASED" | "STATE_REBUILT";
  releasedLeaseIds: readonly string[];
  quarantinedPaths: readonly string[];
}

export interface RepositoryCoordinator {
  readonly root: string;
  reserve(request: LeaseRequest): Promise<RepositoryLease>;
  release(leaseId: string): Promise<void>;
  reconcile(): Promise<CoordinatorRecovery>;
  activeLeases(): Promise<readonly RepositoryLease[]>;
}

interface StoredLease extends RepositoryLease {
  status: "ACTIVE" | "RELEASED";
  acquiredAt: string;
}

interface RepositoryState {
  schema_version: 1;
  next_fencing_token: number;
  leases: StoredLease[];
}

const systemClock: LockClock = { now: () => new Date() };

function repositoryStatePath(root: string): string {
  return join(root, "repository.json");
}

function repositoryEventsPath(root: string): string {
  return join(root, "events.jsonl");
}

function repositoryLockTarget(root: string): string {
  return join(root, "repository");
}

function loopLockTarget(root: string, loopId: LoopId): string {
  return join(root, "loops", loopId);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function rejected(message: string, details: Readonly<Record<string, unknown>> = {}): LoopError {
  return new LoopError("DISPATCH_REJECTED", message, details);
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

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeRepoPath(left);
  const b = normalizeRepoPath(right);
  if (a === b) return true;
  const aGlob = /[*?]/u.test(a);
  const bGlob = /[*?]/u.test(b);
  if (aGlob && !bGlob) return globToRegExp(a).test(b);
  if (bGlob && !aGlob) return globToRegExp(b).test(a);
  if (aGlob && bGlob) {
    return a === b
      || globToRegExp(a).test(b.replace(/\*\*/gu, "x").replace(/\*/gu, "x"))
      || globToRegExp(b).test(a.replace(/\*\*/gu, "x").replace(/\*/gu, "x"));
  }
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function externalRootsOverlap(left: string, right: string): boolean {
  const a = comparablePath(resolve(left));
  const b = comparablePath(resolve(right));
  if (a === b) return true;
  const rel = relative(a, b);
  const rev = relative(b, a);
  const escaped = (value: string): boolean =>
    value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  return escaped(rel) || escaped(rev);
}

function resourcesConflict(kind: LeaseRequest["kind"], left: readonly string[], right: readonly string[]): boolean {
  if (kind === "integration") return true;
  if (kind === "branch") return left.some((resource) => right.includes(resource));
  if (kind === "external-root") {
    return left.some((a) => right.some((b) => externalRootsOverlap(a, b)));
  }
  return left.some((a) => right.some((b) => pathsOverlap(a, b)));
}

function emptyState(): RepositoryState {
  return { schema_version: 1, next_fencing_token: 1, leases: [] };
}

function isStoredLease(value: unknown): value is StoredLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.leaseId === "string"
    && typeof record.loopId === "string"
    && typeof record.kind === "string"
    && Array.isArray(record.resources)
    && typeof record.fencingToken === "number"
    && typeof record.expiresAt === "string"
    && (record.status === "ACTIVE" || record.status === "RELEASED")
    && typeof record.acquiredAt === "string";
}

function parseState(value: unknown): RepositoryState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== 1
    || typeof record.next_fencing_token !== "number"
    || !Number.isSafeInteger(record.next_fencing_token)
    || record.next_fencing_token < 1
    || !Array.isArray(record.leases)
    || !record.leases.every(isStoredLease)
  ) {
    return null;
  }
  return record as unknown as RepositoryState;
}

async function readState(
  root: string,
): Promise<{ kind: "MISSING" } | { kind: "VALID"; state: RepositoryState } | { kind: "MALFORMED" }> {
  try {
    const parsed = parseState(JSON.parse(await readFile(repositoryStatePath(root), "utf8")));
    return parsed === null ? { kind: "MALFORMED" } : { kind: "VALID", state: parsed };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "MISSING" };
    if (error instanceof SyntaxError) return { kind: "MALFORMED" };
    throw error;
  }
}

async function appendCoordinatorEvent(
  root: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  const line = `${JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    payload,
  })}\n`;
  await mkdir(root, { recursive: true });
  await appendFile(repositoryEventsPath(root), line, "utf8");
}

function publicLease(lease: StoredLease): RepositoryLease {
  return {
    leaseId: lease.leaseId,
    loopId: lease.loopId,
    kind: lease.kind,
    resources: [...lease.resources],
    fencingToken: lease.fencingToken,
    expiresAt: lease.expiresAt,
  };
}

class Coordinator implements RepositoryCoordinator {
  constructor(
    readonly root: string,
    private readonly clock: LockClock,
  ) {}

  async activeLeases(): Promise<readonly RepositoryLease[]> {
    const read = await readState(this.root);
    if (read.kind !== "VALID") {
      throw new LoopError("RECONCILE_REQUIRED", "Repository coordinator state must be reconciled before use.", {
        root: this.root,
      });
    }
    const now = this.clock.now().getTime();
    return read.state.leases
      .filter((lease) => lease.status === "ACTIVE" && Date.parse(lease.expiresAt) > now)
      .map(publicLease);
  }

  async reserve(request: LeaseRequest): Promise<RepositoryLease> {
    if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0) {
      throw new LoopError("SCHEMA_INVALID", "Lease TTL must be a positive integer.", { ttl_ms: request.ttlMs });
    }
    if (request.resources.length === 0) {
      throw new LoopError("SCHEMA_INVALID", "A lease requires at least one resource.");
    }
    const normalizedResources = request.kind === "external-root"
      ? await Promise.all(request.resources.map(async (resource) => {
        try {
          return await realpath(resolve(resource));
        } catch {
          return resolve(resource);
        }
      }))
      : request.resources.map((resource) => (request.kind === "path" ? normalizeRepoPath(resource) : resource));

    const ttlMs = Math.max(request.ttlMs, 5_000);
    const repositoryLock = await acquireLock({
      target: repositoryLockTarget(this.root),
      ownerId: `coordinator:${request.loopId}`,
      ttlMs,
      clock: this.clock,
    });
    await mkdir(dirname(loopLockTarget(this.root, request.loopId)), { recursive: true });
    const loopLock = await acquireLock({
      target: loopLockTarget(this.root, request.loopId),
      ownerId: `coordinator:${request.loopId}`,
      ttlMs,
      clock: this.clock,
    });
    try {
      return await repositoryLock.runExclusive(async () => {
        const read = await readState(this.root);
        if (read.kind === "MALFORMED") {
          throw new LoopError("RECONCILE_REQUIRED", "Repository coordinator state is malformed and must be reconciled.", {
            root: this.root,
          });
        }
        const state = read.kind === "MISSING" ? emptyState() : read.state;
        const now = this.clock.now().getTime();
        for (const lease of state.leases) {
          if (lease.status !== "ACTIVE") continue;
          if (Date.parse(lease.expiresAt) <= now) {
            throw new LoopError("RECONCILE_REQUIRED", "An expired repository lease requires explicit reconcile before reservation.", {
              lease_id: lease.leaseId,
            });
          }
          if (lease.kind === request.kind && resourcesConflict(request.kind, lease.resources, normalizedResources)) {
            throw rejected("The requested repository lease conflicts with an active lease.", {
              lease_id: lease.leaseId,
              kind: request.kind,
              resources: normalizedResources,
            });
          }
        }

        const fencingToken = state.next_fencing_token;
        const lease: StoredLease = {
          leaseId: randomUUID(),
          loopId: request.loopId,
          kind: request.kind,
          resources: [...normalizedResources],
          fencingToken,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + request.ttlMs).toISOString(),
          status: "ACTIVE",
        };
        await appendCoordinatorEvent(this.root, "LEASE_INTENT", {
          lease_id: lease.leaseId,
          loop_id: lease.loopId,
          kind: lease.kind,
          resources: lease.resources,
          fencing_token: lease.fencingToken,
        });
        const next: RepositoryState = {
          schema_version: 1,
          next_fencing_token: fencingToken + 1,
          leases: [...state.leases, lease],
        };
        await atomicWriteJson(repositoryStatePath(this.root), next);
        await appendCoordinatorEvent(this.root, "LEASE_COMMIT", {
          lease_id: lease.leaseId,
          fencing_token: lease.fencingToken,
          state_digest: sha256Hex(canonicalJsonBytes(next)),
        });
        return publicLease(lease);
      });
    } finally {
      await loopLock.release();
      await repositoryLock.release();
    }
  }

  async release(leaseId: string): Promise<void> {
    const repositoryLock = await acquireLock({
      target: repositoryLockTarget(this.root),
      ownerId: `coordinator-release:${leaseId}`,
      ttlMs: 30_000,
      clock: this.clock,
    });
    try {
      await repositoryLock.runExclusive(async () => {
        const read = await readState(this.root);
        if (read.kind !== "VALID") {
          throw new LoopError("RECONCILE_REQUIRED", "Repository coordinator state must be reconciled before release.", {
            root: this.root,
          });
        }
        const index = read.state.leases.findIndex((lease) => lease.leaseId === leaseId && lease.status === "ACTIVE");
        if (index < 0) {
          throw rejected("The lease is not active and cannot be released.", { lease_id: leaseId });
        }
        const leases = read.state.leases.map((lease, leaseIndex) => (
          leaseIndex === index ? { ...lease, status: "RELEASED" as const } : lease
        ));
        const next: RepositoryState = { ...read.state, leases };
        await appendCoordinatorEvent(this.root, "LEASE_RELEASE_INTENT", { lease_id: leaseId });
        await atomicWriteJson(repositoryStatePath(this.root), next);
        await appendCoordinatorEvent(this.root, "LEASE_RELEASE_COMMIT", { lease_id: leaseId });
      });
    } finally {
      await repositoryLock.release();
    }
  }

  async reconcile(): Promise<CoordinatorRecovery> {
    const repositoryLock = await acquireLock({
      target: repositoryLockTarget(this.root),
      ownerId: "coordinator-reconcile",
      ttlMs: 30_000,
      clock: this.clock,
    });
    try {
      return await repositoryLock.runExclusive(async () => {
        const read = await readState(this.root);
        const quarantinedPaths: string[] = [];
        const releasedLeaseIds: string[] = [];
        const now = this.clock.now().getTime();

        if (read.kind === "MALFORMED") {
          const quarantine = `${repositoryStatePath(this.root)}.quarantine-${randomUUID()}`;
          try {
            await rename(repositoryStatePath(this.root), quarantine);
            quarantinedPaths.push(quarantine);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
          await atomicWriteJson(repositoryStatePath(this.root), emptyState());
          await appendCoordinatorEvent(this.root, "COORDINATOR_RECONCILE", {
            outcome: "STATE_REBUILT",
            quarantined_paths: quarantinedPaths,
          });
          return { outcome: "STATE_REBUILT", releasedLeaseIds, quarantinedPaths };
        }

        if (read.kind === "MISSING") {
          await mkdir(this.root, { recursive: true });
          await atomicWriteJson(repositoryStatePath(this.root), emptyState());
          return { outcome: "CLEAN", releasedLeaseIds, quarantinedPaths };
        }

        const leases = read.state.leases.map((lease) => {
          if (lease.status === "ACTIVE" && Date.parse(lease.expiresAt) <= now) {
            releasedLeaseIds.push(lease.leaseId);
            return { ...lease, status: "RELEASED" as const };
          }
          return lease;
        });
        if (releasedLeaseIds.length === 0) {
          return { outcome: "CLEAN", releasedLeaseIds, quarantinedPaths };
        }
        const next: RepositoryState = { ...read.state, leases };
        await atomicWriteJson(repositoryStatePath(this.root), next);
        await appendCoordinatorEvent(this.root, "COORDINATOR_RECONCILE", {
          outcome: "EXPIRED_LEASES_RELEASED",
          released_lease_ids: releasedLeaseIds,
        });
        return { outcome: "EXPIRED_LEASES_RELEASED", releasedLeaseIds, quarantinedPaths };
      });
    } finally {
      await repositoryLock.release();
    }
  }
}

export async function openRepositoryCoordinator(
  workspace: string,
  options: { clock?: LockClock } = {},
): Promise<RepositoryCoordinator> {
  const root = await resolveCoordinationRoot(workspace);
  await mkdir(root, { recursive: true });
  return new Coordinator(root, options.clock ?? systemClock);
}
