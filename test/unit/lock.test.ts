import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireLock,
  acquireLockGuard,
  assessGuardOwnerDeathProof,
  discoverHostIdentity,
  discoverPidNamespaceIdentity,
  reconcileFencingCounter,
  reconcileLock,
  reconcileLockGuard,
  withOrderedLocks,
  type HostIdentityProbe,
  type LockClock,
  type PidNamespaceProbe,
} from "../../src/core/lock.js";

class ManualClock implements LockClock {
  #milliseconds = Date.parse("2026-08-06T00:00:00.000Z");

  now(): Date {
    return new Date(this.#milliseconds);
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }
}

test("expired lock cannot be stolen without reconcile and stale fence cannot write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-expiry-"));
  const target = join(root, "loop-state");
  const clock = new ManualClock();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await acquireLock({ target, ownerId: "one", ttlMs: 1, clock });
  clock.advance(2);
  await assert.rejects(
    acquireLock({ target, ownerId: "two", ttlMs: 100, clock }),
    (error: unknown) => String(error).includes("RECONCILE_REQUIRED"),
  );

  const reconciliation = await reconcileLock({
    target,
    expectedNonce: first.owner.nonce,
    clock,
  });
  const second = await acquireLock({ target, ownerId: "two", ttlMs: 100, clock });

  assert.ok(second.owner.fencingToken > first.owner.fencingToken);
  await assert.rejects(first.assertCurrent(), (error: unknown) => String(error).includes("CAS_MISMATCH"));
  assert.equal(reconciliation.outcome, "EXPIRED_OWNER_FENCED");
  await second.release();
});

test("malformed owners require explicit null-nonce reconciliation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-malformed-"));
  const target = join(root, "repository");
  t.after(() => rm(root, { recursive: true, force: true }));

  const lease = await acquireLock({ target, ownerId: "owner", ttlMs: 10_000 });
  await lease.release();
  await mkdir(`${target}.lock`, { recursive: true });
  await writeFile(join(`${target}.lock`, "owner.json"), "{not-json", "utf8");

  await assert.rejects(
    acquireLock({ target, ownerId: "next", ttlMs: 10_000 }),
    (error: unknown) => String(error).includes("RECONCILE_REQUIRED"),
  );
  await assert.rejects(
    reconcileLock({ target, expectedNonce: "guessed" }),
    (error: unknown) => String(error).includes("CAS_MISMATCH"),
  );
  const result = await reconcileLock({ target, expectedNonce: null });
  assert.equal(result.outcome, "MALFORMED_OWNER_QUARANTINED");
});

test("reconcile rejects a missing lock without creating one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-missing-"));
  const target = join(root, "missing");
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    reconcileLock({ target, expectedNonce: null }),
    (error: unknown) => String(error).includes("CAS_MISMATCH"),
  );
  await assert.rejects(stat(`${target}.lock`), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("release compares both nonce and fencing token before removing a lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-release-"));
  const target = join(root, "loop");
  t.after(() => rm(root, { recursive: true, force: true }));

  const lease = await acquireLock({ target, ownerId: "owner", ttlMs: 10_000 });
  const ownerPath = join(`${target}.lock`, "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
  await import("../../src/core/atomic-json.js").then(({ atomicWriteJson }) => atomicWriteJson(ownerPath, {
    ...owner,
    nonce: "replacement-nonce",
  }));

  await assert.rejects(lease.release(), (error: unknown) => String(error).includes("CAS_MISMATCH"));
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).nonce, "replacement-nonce");
});

test("ordered locks acquire Repository before Loop and reject reversed kinds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = { kind: "REPOSITORY" as const, target: join(root, "repository"), ownerId: "controller", ttlMs: 10_000 };
  const loop = { kind: "LOOP" as const, target: join(root, "loop"), ownerId: "controller", ttlMs: 10_000 };

  const tokens = await withOrderedLocks(repository, loop, async (leases) => {
    assert.deepEqual(leases.map((lease) => lease.target), [repository.target, loop.target]);
    await Promise.all(leases.map((lease) => lease.assertCurrent()));
    return leases.map((lease) => lease.owner.fencingToken);
  });
  assert.equal(tokens.length, 2);

  await assert.rejects(
    withOrderedLocks({ ...loop, kind: "LOOP" }, undefined, async () => undefined),
    /Repository lock must be acquired before Loop lock/i,
  );
});

function waitForMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("message", resolvePromise);
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code !== null && code !== 0) rejectPromise(new Error(`Child exited with code ${code}.`));
      if (signal !== null) rejectPromise(new Error(`Child exited with signal ${signal}.`));
    });
  });
}

async function waitPast(expiresAt: string): Promise<void> {
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining >= 0) await delay(remaining + 25);
}

test("Windows identity trusts SystemRoot instead of the Node drive, repo cwd, or PATH", async () => {
  const executions: Array<{ executable: string; cwd: string }> = [];
  let plantedNodeDriveMarker = false;
  const probe = (platform: "win32" | "darwin"): HostIdentityProbe & { environment: Readonly<Record<string, string | undefined>> } => ({
    platform,
    nodeExecutablePath: platform === "win32" ? "D:\\Program Files\\nodejs\\node.exe" : "/opt/node/bin/node",
    environment: platform === "win32"
      ? { SystemRoot: "C:\\Windows", WinDir: "c:\\windows", PATH: "D:\\repo\\bin" }
      : { PATH: "/attacker/repo/bin" },
    canonicalPath: async (path) => path.toLowerCase() === "c:\\windows" ? "C:\\Windows" : path,
    readText: async () => { throw new Error("unexpected file read"); },
    execute: async (executable, _arguments, options) => {
      if (executable.toLowerCase().startsWith("d:\\windows\\")) plantedNodeDriveMarker = true;
      executions.push({ executable, cwd: options.cwd });
      return platform === "win32"
        ? "MachineGuid    REG_SZ    11111111-2222-3333-4444-555555555555"
        : '"IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"';
    },
  });

  const windowsIdentity = await discoverHostIdentity(probe("win32"));
  const macIdentity = await discoverHostIdentity(probe("darwin"));

  assert.equal(plantedNodeDriveMarker, false, "a portable Node drive must not become an OS trust root");
  assert.deepEqual(executions, [
    { executable: "C:\\Windows\\System32\\reg.exe", cwd: "C:\\Windows\\System32" },
    { executable: "/usr/sbin/ioreg", cwd: "/usr/sbin" },
  ]);
  assert.match(windowsIdentity ?? "", /^host-v1:[0-9a-f]{64}$/u);
  assert.match(macIdentity ?? "", /^host-v1:[0-9a-f]{64}$/u);
  assert.equal(windowsIdentity?.includes("11111111-2222-3333-4444-555555555555"), false);
  assert.equal(macIdentity?.includes("11111111-2222-3333-4444-555555555555"), false);
});

test("Windows identity fails closed for missing, conflicting, relative, or noncanonical OS roots", async () => {
  const discover = async (
    environment: Readonly<Record<string, string | undefined>>,
    canonicalPath: (path: string) => Promise<string> = async (path) => path,
  ): Promise<string | null> => discoverHostIdentity({
    platform: "win32",
    nodeExecutablePath: "D:\\Portable\\node.exe",
    environment,
    canonicalPath,
    readText: async () => { throw new Error("unexpected file read"); },
    execute: async () => "MachineGuid    REG_SZ    11111111-2222-3333-4444-555555555555",
  } as HostIdentityProbe & { environment: Readonly<Record<string, string | undefined>> });

  assert.equal(await discover({}), null);
  assert.equal(await discover({ SystemRoot: "Windows" }), null);
  assert.equal(await discover({ SystemRoot: "C:\\" }), null);
  assert.equal(await discover({ SystemRoot: "C:\\Windows", WinDir: "E:\\Windows" }), null);
  assert.equal(await discover({ SystemRoot: "C:\\Windows\\..\\repo" }), null);
  assert.equal(await discover(
    { SystemRoot: "C:\\Windows" },
    async (path) => path === "C:\\Windows" ? "C:\\RedirectedWindows" : path,
  ), null);
  assert.equal(await discover(
    { SystemRoot: "C:\\Windows" },
    async (path) => path.endsWith("reg.exe") ? "C:\\attacker\\reg.exe" : path,
  ), null);
  assert.equal(await discover(
    { SystemRoot: "C:\\Windows" },
    async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  ), null);
});

test("noncanonical host tools and unreadable PID namespaces are unverifiable", async () => {
  let executed = false;
  const host = await discoverHostIdentity({
    platform: "darwin",
    nodeExecutablePath: "/opt/node/bin/node",
    environment: {},
    canonicalPath: async () => "/attacker/ioreg",
    readText: async () => { throw new Error("unexpected file read"); },
    execute: async () => { executed = true; return "unexpected"; },
  });
  const namespace = await discoverPidNamespaceIdentity({
    platform: "linux",
    readLink: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
  });

  assert.equal(host, null);
  assert.equal(executed, false);
  assert.equal(namespace, null);
});

test("Linux death proof requires an equal verified PID namespace", async () => {
  const namespaceProbe: PidNamespaceProbe = {
    platform: "linux",
    readLink: async () => "pid:[4026531836]",
  };
  const namespace = await discoverPidNamespaceIdentity(namespaceProbe);
  assert.match(namespace ?? "", /^pidns-v1:[0-9a-f]{64}$/u);
  assert.equal(namespace?.includes("4026531836"), false);

  const common = {
    platform: "linux" as const,
    ownerHostId: "host-v1:owner",
    localHostId: "host-v1:owner",
    ownerPidNamespaceId: namespace,
    localPidNamespaceId: namespace,
  };
  assert.equal(assessGuardOwnerDeathProof({ ...common, liveness: () => "DEAD" }), "DEAD");
  assert.equal(assessGuardOwnerDeathProof({ ...common, liveness: () => "ALIVE" }), "ALIVE");
  let crossNamespacePidProbed = false;
  assert.equal(assessGuardOwnerDeathProof({
    ...common,
    ownerPidNamespaceId: "pidns-v1:different",
    liveness: () => { crossNamespacePidProbed = true; return "DEAD"; },
  }), "UNVERIFIABLE");
  assert.equal(crossNamespacePidProbed, false, "a PID in another namespace must never be used as death proof");
  assert.equal(assessGuardOwnerDeathProof({ ...common, localPidNamespaceId: null, liveness: () => "DEAD" }), "UNVERIFIABLE");
  assert.equal(assessGuardOwnerDeathProof({
    ...common,
    platform: "win32",
    ownerPidNamespaceId: null,
    localPidNamespaceId: null,
    liveness: () => "DEAD",
  }), "DEAD");
});

test("lock directories serialize real process contention", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-process-"));
  const target = join(root, "shared");
  const moduleUrl = new URL("../../src/core/lock.js", import.meta.url).href;
  t.after(() => rm(root, { recursive: true, force: true }));

  const holderScript = `
    const { acquireLock } = await import(process.env.PAI_LOCK_MODULE);
    const lease = await acquireLock({ target: process.env.PAI_LOCK_TARGET, ownerId: "holder", ttlMs: 60000 });
    process.send({ status: "ACQUIRED", token: lease.owner.fencingToken });
    process.on("message", async () => { await lease.release(); process.exit(0); });
  `;
  const contenderScript = `
    const { acquireLock } = await import(process.env.PAI_LOCK_MODULE);
    try {
      await acquireLock({ target: process.env.PAI_LOCK_TARGET, ownerId: "contender", ttlMs: 60000 });
      process.send({ status: "UNEXPECTED_ACQUIRE" });
    } catch (error) {
      process.send({ status: error.code ?? "UNKNOWN" });
    }
  `;
  const environment = { ...process.env, PAI_LOCK_MODULE: moduleUrl, PAI_LOCK_TARGET: target };
  const holder = spawn(process.execPath, ["--input-type=module", "--eval", holderScript], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  assert.deepEqual((await waitForMessage(holder) as { status: string }).status, "ACQUIRED");

  const contender = spawn(process.execPath, ["--input-type=module", "--eval", contenderScript], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const contenderExit = once(contender, "exit");
  assert.deepEqual((await waitForMessage(contender) as { status: string }).status, "LOCK_BUSY");
  await contenderExit;
  const holderExit = once(holder, "exit");
  holder.send("release");
  await holderExit;
});

test("an expired guard cannot be reconciled while its real owner process can resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-guard-active-process-"));
  const target = join(root, "resource");
  const marker = join(root, "owner-resumed.txt");
  const moduleUrl = new URL("../../src/core/lock.js", import.meta.url).href;
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `
    const { writeFile } = await import("node:fs/promises");
    const { acquireLockGuard } = await import(process.env.PAI_LOCK_MODULE);
    const guard = await acquireLockGuard({ target: process.env.PAI_LOCK_TARGET, ownerId: "active-child", ttlMs: 50 });
    process.send({ status: "ACTIVE", owner: guard.owner });
    process.on("message", async () => {
      await writeFile(process.env.PAI_LOCK_MARKER, "resumed", "utf8");
      await guard.release();
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, PAI_LOCK_MODULE: moduleUrl, PAI_LOCK_TARGET: target, PAI_LOCK_MARKER: marker },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const message = await waitForMessage(child) as { status: string; owner: { nonce: string; expiresAt: string } };
  assert.equal(message.status, "ACTIVE");
  await waitPast(message.owner.expiresAt);
  await assert.rejects(
    reconcileLockGuard({ target, expectedNonce: message.owner.nonce }),
    (error: unknown) => String(error).includes("LOCK_BUSY"),
  );
  const exit = once(child, "exit");
  child.send("resume");
  await exit;
  assert.equal(await readFile(marker, "utf8"), "resumed");
});

test("an expired guard can be explicitly reconciled after its real owner process is killed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-guard-dead-process-"));
  const target = join(root, "resource");
  const moduleUrl = new URL("../../src/core/lock.js", import.meta.url).href;
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `
    const { acquireLockGuard } = await import(process.env.PAI_LOCK_MODULE);
    const guard = await acquireLockGuard({ target: process.env.PAI_LOCK_TARGET, ownerId: "crashed-child", ttlMs: 50 });
    process.send({ status: "ACTIVE", owner: guard.owner });
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, PAI_LOCK_MODULE: moduleUrl, PAI_LOCK_TARGET: target },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const message = await waitForMessage(child) as { status: string; owner: { nonce: string; expiresAt: string } };
  assert.equal(message.status, "ACTIVE");
  child.kill();
  await once(child, "exit");
  await waitPast(message.owner.expiresAt);
  const reconciled = await reconcileLockGuard({ target, expectedNonce: message.owner.nonce });
  assert.equal(reconciled.outcome, "EXPIRED_GUARD_FENCED");
  const successor = await acquireLockGuard({ target, ownerId: "successor", ttlMs: 1_000 });
  await successor.release();
});

test("foreign and malformed expired guard owners fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-guard-unverifiable-"));
  const target = join(root, "resource");
  const clock = new ManualClock();
  t.after(() => rm(root, { recursive: true, force: true }));
  const guard = await acquireLockGuard({ target, ownerId: "owner", ttlMs: 1, clock });
  clock.advance(2);
  const path = join(root, ".pai-loop-fence.lock", "owner.json");
  const owner = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await import("../../src/core/atomic-json.js").then(({ atomicWriteJson }) => atomicWriteJson(path, {
    ...owner,
    hostId: "foreign-host",
  }));
  await assert.rejects(
    reconcileLockGuard({ target, expectedNonce: guard.owner.nonce, clock }),
    (error: unknown) => String(error).includes("RECONCILE_REQUIRED"),
  );
  await import("../../src/core/atomic-json.js").then(({ atomicWriteJson }) => atomicWriteJson(path, { broken: true }));
  await assert.rejects(
    reconcileLockGuard({ target, expectedNonce: null, clock }),
    (error: unknown) => String(error).includes("RECONCILE_REQUIRED"),
  );
});

test("malformed fencing counter recovers from immutable high-water history without regression", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-counter-recovery-"));
  const target = join(root, "resource");
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await acquireLock({ target, ownerId: "first", ttlMs: 10_000 });
  await first.release();
  await writeFile(join(root, ".resource.fence.json"), "{corrupt", "utf8");
  await assert.rejects(
    acquireLock({ target, ownerId: "blocked", ttlMs: 10_000 }),
    (error: unknown) => String(error).includes("RECONCILE_REQUIRED"),
  );
  await reconcileLock({ target, expectedNonce: null });
  const counter = await reconcileFencingCounter({ target });
  assert.equal(counter.restoredToken, first.owner.fencingToken);
  const successor = await acquireLock({ target, ownerId: "successor", ttlMs: 10_000 });
  assert.ok(successor.owner.fencingToken > first.owner.fencingToken);
  await successor.release();
});

test("true fencing-token exhaustion remains a stable terminal condition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-counter-exhausted-"));
  const target = join(root, "resource");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".resource.fence-history"), { recursive: true });
  await writeFile(join(root, ".resource.fence-history", `${Number.MAX_SAFE_INTEGER}.token`), "", "utf8");
  await import("../../src/core/atomic-json.js").then(({ atomicWriteJson }) => atomicWriteJson(
    join(root, ".resource.fence.json"),
    { fencingToken: Number.MAX_SAFE_INTEGER },
  ));

  await assert.rejects(
    acquireLock({ target, ownerId: "blocked", ttlMs: 10_000 }),
    (error: unknown) => String(error).includes("RECONCILE_REQUIRED"),
  );
  await reconcileLock({ target, expectedNonce: null });
  await assert.rejects(
    reconcileFencingCounter({ target }),
    (error: unknown) => String(error).includes("RECONCILE_REQUIRED"),
  );
});

test("file-lock reconciliation persists its record before quarantine rename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-lock-file-record-"));
  const target = join(root, "resource");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(`${target}.lock`, "malformed", "utf8");
  const options = {
    target,
    expectedNonce: null,
    fault: (point: string) => {
      if (point === "after-quarantine") throw new Error("injected after-quarantine");
    },
  };

  await assert.rejects(reconcileLock(options), /injected after-quarantine/);
  const names = await readdir(root);
  const recordName = names.find((name) => name.startsWith("resource.lock.reconciliation-"));
  assert.ok(recordName !== undefined, "the durable reconciliation record must precede quarantine rename");
  const record = JSON.parse(await readFile(join(root, recordName), "utf8"));
  assert.equal(record.outcome, "MALFORMED_OWNER_QUARANTINED");
  assert.equal((await stat(record.quarantinePath)).isFile(), true);
});
