import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import {
  CONTROL_EXCLUSIONS,
  RUNTIME_INCLUSIONS,
  SOURCE_INCLUSIONS,
  buildRuntimeManifest,
  buildSourceManifest,
  buildTreeManifest,
  buildWorkspaceManifest,
  sealWaveInput,
  type ArtifactBinding,
} from "../../src/core/manifests.js";

const execFileAsync = promisify(execFile);
const digest = (character: string): Digest => character.repeat(64) as Digest;

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function repository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pai-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await git(root, ["init"]);
  await Promise.all([
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(join(root, "schemas"), { recursive: true }),
    mkdir(join(root, "assets", "loop-engineering"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "src", "product.ts"), "export const product = 1;\n"),
    writeFile(join(root, "schemas", "sample.json"), "{}\n"),
    writeFile(join(root, "assets", "loop-engineering", "workflow-spec.json"), "{}\n"),
    writeFile(join(root, "package.json"), "{}\n"),
    writeFile(join(root, "package-lock.json"), "{}\n"),
    writeFile(join(root, "README.md"), "product\n"),
    writeFile(join(root, ".gitignore"), "ignored/\n"),
  ]);
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=PAI Tests", "-c", "user.email=pai@example.invalid", "commit", "-m", "initial"]);
  return root;
}

test("source tree and workspace use one exclusion contract", async (t) => {
  const root = await repository(t);
  await Promise.all([
    mkdir(join(root, ".ai-loop")),
    mkdir(join(root, ".codegraph")),
    mkdir(join(root, "scratch")),
  ]);
  await Promise.all([
    writeFile(join(root, ".ai-loop", "state.json"), "{}"),
    writeFile(join(root, ".codegraph", "index"), "opaque"),
    writeFile(join(root, "scratch", "temporary.txt"), "opaque"),
  ]);

  const exclusions = ["scratch"];
  const source = await buildSourceManifest({ root, include: [], exclusions, declaredArtifacts: [] });
  const tree = await buildTreeManifest({ root, include: ["**/*"], exclusions });
  const workspace = await buildWorkspaceManifest({ root, include: ["**/*"], exclusions, declaredArtifacts: [] });

  for (const manifest of [source, tree, workspace]) {
    assert.equal(manifest.entries.some((entry) => /^(?:\.git|\.ai-loop|\.codegraph|scratch)(?:\/|$)/u.test(entry.path)), false);
  }
  assert.equal(source.entries.some((entry) => entry.path === "src/product.ts"), true);
  assert.equal(source.entries.some((entry) => entry.path === "README.md"), false);
  assert.equal(workspace.entries.some((entry) => entry.path === "README.md"), true);
});

test("dirty and untracked source bytes affect workspace without mutating the Git index", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "src", "product.ts"), "export const product = 2;\n");
  await writeFile(join(root, "src", "untracked.ts"), "export const untracked = true;\n");
  const indexBefore = await git(root, ["diff", "--cached", "--binary"]);

  const tree = await buildTreeManifest({ root, include: SOURCE_INCLUSIONS, exclusions: CONTROL_EXCLUSIONS });
  const workspace = await buildWorkspaceManifest({ root, include: SOURCE_INCLUSIONS, exclusions: CONTROL_EXCLUSIONS, declaredArtifacts: [] });
  const indexAfter = await git(root, ["diff", "--cached", "--binary"]);

  assert.notEqual(tree.digest, workspace.digest);
  assert.equal(tree.entries.some((entry) => entry.path === "src/untracked.ts"), false);
  assert.equal(workspace.entries.some((entry) => entry.path === "src/untracked.ts"), true);
  assert.equal(indexAfter, indexBefore);
});

test("declared ignored, external, and secret inputs are bound without secret bytes", async (t) => {
  const root = await repository(t);
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "calibration.bin"), Buffer.from([0, 1, 2, 255]));
  const externalDigest = digest("a");
  const declaredArtifacts: readonly ArtifactBinding[] = [
    { kind: "file", path: "ignored/calibration.bin", provenance: "repository calibration" },
    { kind: "external", uri: "s3://models/controller", mount: "models/controller", version: "v7", digest: externalDigest, provenance: "model registry", readOnly: true },
    { kind: "secret", provider: "vault", handle: "robot-signing", version: "3" },
  ];

  const first = await buildWorkspaceManifest({ root, include: SOURCE_INCLUSIONS, exclusions: CONTROL_EXCLUSIONS, declaredArtifacts });
  const second = await buildWorkspaceManifest({ root, include: SOURCE_INCLUSIONS, exclusions: CONTROL_EXCLUSIONS, declaredArtifacts });
  assert.equal(first.digest, second.digest);
  assert.equal(first.entries.some((entry) => entry.path === "ignored/calibration.bin"), true);
  assert.equal(first.entries.some((entry) => entry.path === "models/controller" && entry.digest === externalDigest && entry.kind === "external"), true);
  const serialized = JSON.stringify(first);
  assert.match(serialized, /robot-signing/u);
  assert.doesNotMatch(serialized, /secret[_-]?bytes|secret[_-]?value/iu);
});

test("symlink targets are bound and symlinks escaping the repository are rejected", async (t) => {
  const root = await repository(t);
  const outside = await mkdtemp(join(tmpdir(), "pai-manifest-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await writeFile(join(outside, "asset.bin"), "outside");

  try {
    await symlink("product.ts", join(root, "src", "alias.ts"), "file");
    await symlink(join(outside, "asset.bin"), join(root, "src", "escape.ts"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Creating a symlink requires unavailable platform privileges.");
      return;
    }
    throw error;
  }

  await assert.rejects(
    buildWorkspaceManifest({ root, include: SOURCE_INCLUSIONS, exclusions: CONTROL_EXCLUSIONS, declaredArtifacts: [] }),
    /outside|contain/u,
  );
  await rm(join(root, "src", "escape.ts"));
  const manifest = await buildWorkspaceManifest({ root, include: SOURCE_INCLUSIONS, exclusions: CONTROL_EXCLUSIONS, declaredArtifacts: [] });
  assert.equal(manifest.entries.find((entry) => entry.path === "src/alias.ts")?.kind, "symlink");
});

test("runtime manifest includes only JavaScript runtime outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pai-runtime-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist", "core"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "dist", "core", "runtime.js"), "export {};\n"),
    writeFile(join(root, "dist", "core", "runtime.js.map"), "{}"),
    writeFile(join(root, "dist", "core", "ignored.json"), "{}"),
  ]);
  const runtime = await buildRuntimeManifest(root);
  assert.deepEqual(runtime.entries.map((entry) => entry.path), ["dist/core/runtime.js", "dist/core/runtime.js.map"]);
  assert.deepEqual(RUNTIME_INCLUSIONS, ["dist/**/*.js", "dist/**/*.js.map"]);
});

test("submodule manifests bind the Gitlink mode and current commit", async (t) => {
  const root = await repository(t);
  const origin = await mkdtemp(join(tmpdir(), "pai-submodule-origin-"));
  t.after(() => rm(origin, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await git(origin, ["init"]);
  await writeFile(join(origin, "controller.ts"), "export const controller = true;\n");
  await git(origin, ["add", "."]);
  await git(origin, ["-c", "user.name=PAI Tests", "-c", "user.email=pai@example.invalid", "commit", "-m", "controller"]);
  await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", origin, "modules/controller"]);
  await git(root, ["add", ".gitmodules", "modules/controller"]);

  const tree = await buildTreeManifest({ root, include: ["modules/**"], exclusions: [] });
  const workspace = await buildWorkspaceManifest({ root, include: ["modules/**"], exclusions: [], declaredArtifacts: [] });
  assert.deepEqual(tree.entries.map(({ path, mode, kind }) => ({ path, mode, kind })), [
    { path: "modules/controller", mode: "160000", kind: "submodule" },
  ]);
  assert.equal(workspace.entries[0]?.digest, tree.entries[0]?.digest);
});

test("WaveInput binds repository identity and deterministic manifests without changing the index", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "src", "product.ts"), "export const product = 9;\n");
  const indexBefore = await readFile(join(root, ".git", "index"));
  const options = {
    root,
    loopId: "loop-001" as LoopId,
    waveId: "wave-001",
    repositoryId: "repository-001",
    baseSha: (await git(root, ["rev-parse", "HEAD"])).trim(),
    h1PolicyDigest: digest("b"),
    sourceInclude: SOURCE_INCLUSIONS,
    workspaceInclude: ["**/*"],
    exclusions: CONTROL_EXCLUSIONS,
    declaredArtifacts: [],
  } as const;

  const first = await sealWaveInput(options);
  const second = await sealWaveInput(options);
  const otherRepository = await sealWaveInput({ ...options, repositoryId: "repository-002" });
  assert.deepEqual(second, first);
  assert.notEqual(otherRepository.digest, first.digest);
  assert.notEqual(first.source_manifest_digest, first.tree_manifest_digest);
  assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
});
