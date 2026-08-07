import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireLock,
  reconcileLock,
  withOrderedLocks,
  type LockClock,
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
