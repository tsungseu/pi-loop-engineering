import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { LoopError, type LoopId } from "../../src/contracts/domain.js";
import {
  openRepositoryCoordinator,
  type RepositoryCoordinator,
} from "../../src/core/coordinator.js";
import { parseLoopId } from "../../src/core/paths.js";

const execFileAsync = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  const separator = process.platform === "win32" ? ";" : ":";
  const extra = [dirname(process.execPath)];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    extra.push(join(systemRoot, "System32"), systemRoot);
    for (const gitDirectory of [
      process.env.LOCALAPPDATA === undefined ? "" : join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd"),
      process.env.ProgramFiles === undefined ? "" : join(process.env.ProgramFiles, "Git", "cmd"),
    ]) {
      if (gitDirectory !== "") extra.push(gitDirectory);
    }
  }
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(separator), GIT_OPTIONAL_LOCKS: "0" };
}

async function git(args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { env: gitEnv() });
}

async function gitRepository(t: TestContext): Promise<{ repository: string; worktreeA: string; worktreeB: string }> {
  const base = await mkdtemp(join(tmpdir(), "pi-coord-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repository = join(base, "repository");
  const worktreeA = join(base, "worktree-a");
  const worktreeB = join(base, "worktree-b");
  await git(["init", repository]);
  await git([
    "-C", repository, "-c", "user.name=PI Tests", "-c", "user.email=pi@example.invalid",
    "commit", "--allow-empty", "-m", "initial",
  ]);
  await mkdir(join(repository, "src", "control"), { recursive: true });
  await writeFile(join(repository, "src", "control", "gain.ts"), "export const gain = 1;\n", "utf8");
  await git(["-C", repository, "add", "."]);
  await git([
    "-C", repository, "-c", "user.name=PI Tests", "-c", "user.email=pi@example.invalid",
    "commit", "-m", "seed",
  ]);
  await git(["-C", repository, "worktree", "add", "-b", "wt-a", worktreeA]);
  await git(["-C", repository, "worktree", "add", "-b", "wt-b", worktreeB]);
  return { repository, worktreeA, worktreeB };
}

test("two Worktrees share one Git common-dir coordinator", async (t) => {
  const { worktreeA, worktreeB } = await gitRepository(t);
  const loopA = parseLoopId("loop-a");
  const loopB = parseLoopId("loop-b");
  const first = await openRepositoryCoordinator(worktreeA);
  const second = await openRepositoryCoordinator(worktreeB);
  assert.equal(first.root, second.root);
  await first.reserve({ loopId: loopA, kind: "path", resources: ["src/control/**"], ttlMs: 60_000 });
  await assert.rejects(
    second.reserve({ loopId: loopB, kind: "path", resources: ["src/control/gain.ts"], ttlMs: 60_000 }),
    (error: unknown) => error instanceof LoopError && error.code === "DISPATCH_REJECTED",
  );
});

test("Coordinator rejects overlapping branch and integration leases", async (t) => {
  const { repository } = await gitRepository(t);
  const coordinator = await openRepositoryCoordinator(repository);
  const loopA = parseLoopId("loop-branch-a");
  const loopB = parseLoopId("loop-branch-b");
  await coordinator.reserve({ loopId: loopA, kind: "branch", resources: ["feature/x"], ttlMs: 60_000 });
  await assert.rejects(
    coordinator.reserve({ loopId: loopB, kind: "branch", resources: ["feature/x"], ttlMs: 60_000 }),
    /DISPATCH_REJECTED/,
  );
  await coordinator.reserve({ loopId: loopA, kind: "integration", resources: ["tree"], ttlMs: 60_000 });
  await assert.rejects(
    coordinator.reserve({ loopId: loopB, kind: "integration", resources: ["tree"], ttlMs: 60_000 }),
    /DISPATCH_REJECTED/,
  );
});

test("Coordinator fences leases monotonically and refuses expired steal without reconcile", async (t) => {
  const { repository } = await gitRepository(t);
  const coordinator = await openRepositoryCoordinator(repository);
  const loopA = parseLoopId("loop-fence-a");
  const loopB = parseLoopId("loop-fence-b");
  const first = await coordinator.reserve({
    loopId: loopA,
    kind: "path",
    resources: ["src/a.ts"],
    ttlMs: 1,
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  await assert.rejects(
    coordinator.reserve({ loopId: loopB, kind: "path", resources: ["src/a.ts"], ttlMs: 60_000 }),
    /RECONCILE_REQUIRED|DISPATCH_REJECTED/,
  );
  const recovery = await coordinator.reconcile();
  assert.ok(recovery.releasedLeaseIds.includes(first.leaseId));
  const second = await coordinator.reserve({
    loopId: loopB,
    kind: "path",
    resources: ["src/a.ts"],
    ttlMs: 60_000,
  });
  assert.ok(second.fencingToken > first.fencingToken);
});

test("Coordinator external-root leases conflict on overlapping canonical roots", async (t) => {
  const { repository } = await gitRepository(t);
  const external = await mkdtemp(join(tmpdir(), "pi-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const nested = join(external, "models");
  await mkdir(nested, { recursive: true });
  const coordinator = await openRepositoryCoordinator(repository);
  await coordinator.reserve({
    loopId: parseLoopId("loop-ext-a"),
    kind: "external-root",
    resources: [external],
    ttlMs: 60_000,
  });
  await assert.rejects(
    coordinator.reserve({
      loopId: parseLoopId("loop-ext-b"),
      kind: "external-root",
      resources: [nested],
      ttlMs: 60_000,
    }),
    /DISPATCH_REJECTED/,
  );
});

test("Coordinator unknown state requires reconcile before reserve", async (t) => {
  const { repository } = await gitRepository(t);
  const coordinator = await openRepositoryCoordinator(repository);
  await writeFile(join(coordinator.root, "repository.json"), "{not-json", "utf8");
  await assert.rejects(
    coordinator.reserve({
      loopId: parseLoopId("loop-unknown"),
      kind: "path",
      resources: ["src/x.ts"],
      ttlMs: 60_000,
    }),
    /RECONCILE_REQUIRED/,
  );
  const recovery = await coordinator.reconcile();
  assert.equal(recovery.outcome, "STATE_REBUILT");
  await coordinator.reserve({
    loopId: parseLoopId("loop-unknown"),
    kind: "path",
    resources: ["src/x.ts"],
    ttlMs: 60_000,
  });
  const state = JSON.parse(await readFile(join(coordinator.root, "repository.json"), "utf8")) as {
    leases: readonly unknown[];
  };
  assert.equal(state.leases.length, 1);
});

test("Coordinator release clears a lease for later reservation", async (t) => {
  const { repository } = await gitRepository(t);
  const coordinator: RepositoryCoordinator = await openRepositoryCoordinator(repository);
  const loopId = parseLoopId("loop-release") as LoopId;
  const lease = await coordinator.reserve({
    loopId,
    kind: "path",
    resources: ["src/only.ts"],
    ttlMs: 60_000,
  });
  await coordinator.release(lease.leaseId);
  const again = await coordinator.reserve({
    loopId: parseLoopId("loop-release-2"),
    kind: "path",
    resources: ["src/only.ts"],
    ttlMs: 60_000,
  });
  assert.notEqual(again.leaseId, lease.leaseId);
});
