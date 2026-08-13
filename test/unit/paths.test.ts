import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertContained,
  parseLoopId,
  resolveCoordinationRoot,
  resolveLayout,
} from "../../src/core/paths.js";

const execFileAsync = promisify(execFile);

test("layout uses complete Loop paths and rejects traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const id = parseLoopId("loop-001");
  const layout = resolveLayout(root, id);
  assert.match(layout.loopJson, /\.ai-loop[\\/]loop[\\/]loop-001[\\/]LOOP\.json$/);
  assert.equal(layout.loopMarkdown, join(root, ".ai-loop", "loop", "loop-001", "LOOP.md"));
  assert.equal(layout.eventsJsonl, join(root, ".ai-loop", "loop", "loop-001", "events.jsonl"));
  assert.equal(layout.harnessRoot, join(root, ".ai-loop", "loop", "loop-001", "harness"));
  assert.equal(layout.evidenceRoot, join(root, ".ai-loop", "loop", "loop-001", "evidence"));
  assert.equal(layout.checkpointsRoot, join(root, ".ai-loop", "loop", "loop-001", "checkpoints"));
  assert.equal(layout.handoffJson, join(root, ".ai-loop", "loop", "loop-001", "handoff.json"));
  assert.throws(() => parseLoopId("../escape"), /INVALID_LOOP_ID/);
  assert.throws(() => parseLoopId(`a${"b".repeat(96)}`), /INVALID_LOOP_ID/);
});

test("containment resolves missing descendants and rejects lexical traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-containment-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const contained = await assertContained(root, join(root, "future", "state.json"));
  assert.equal(contained, join(await realpath(root), "future", "state.json"));
  await assert.rejects(assertContained(root, resolve(root, "..", "escape.json")), /outside/i);
});

test("containment rejects a symlinked parent that escapes the root", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-symlink-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  t.after(() => rm(base, { recursive: true, force: true }));

  try {
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Creating a symlink requires unavailable platform privileges.");
      return;
    }
    throw error;
  }

  await assert.rejects(assertContained(root, join(root, "linked", "state.json")), /outside/i);
});

test("Git worktrees share the canonical common-directory coordination root", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-common-dir-"));
  const repository = join(base, "repository");
  const worktree = join(base, "worktree");
  t.after(() => rm(base, { recursive: true, force: true }));

  await execFileAsync("git", ["init", repository]);
  await execFileAsync("git", ["-C", repository, "-c", "user.name=PI Tests", "-c", "user.email=pi@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
  await execFileAsync("git", ["-C", repository, "worktree", "add", "-b", "test-worktree", worktree]);

  const [repositoryRoot, worktreeRoot] = await Promise.all([
    resolveCoordinationRoot(repository),
    resolveCoordinationRoot(worktree),
  ]);
  assert.equal(worktreeRoot, repositoryRoot);
  assert.match(repositoryRoot, /[\\/]\.git[\\/]pi-loop-engineering[\\/]coordination$/);
});

test("non-Git workspaces coordinate below their canonical workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-non-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    await resolveCoordinationRoot(root),
    join(await realpath(root), ".ai-loop", "coordination"),
  );
});
