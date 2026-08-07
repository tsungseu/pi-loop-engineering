import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LoopError } from "../../src/contracts/domain.js";
import { resolveCoordinationRoot } from "../../src/core/paths.js";

function isClosedGitResolution(error: unknown): boolean {
  return error instanceof LoopError && error.code === "RECONCILE_REQUIRED";
}

test("coordination resolution fails closed when Git cannot be spawned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-git-missing-"));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  });

  process.env.PATH = "";
  await assert.rejects(resolveCoordinationRoot(root), isClosedGitResolution);
});

test("coordination resolution does not disguise a broken Git marker as a non-Git workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-git-broken-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".git"), "gitdir: missing-git-directory\n", "utf8");

  await assert.rejects(resolveCoordinationRoot(root), isClosedGitResolution);
});
