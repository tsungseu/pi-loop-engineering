import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Digest, LoopId } from "../../src/contracts/domain.js";
import { sha256Hex } from "../../src/contracts/domain.js";
import { canonicalJsonBytes } from "../../src/core/atomic-json.js";
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

function waveOptions(root: string, baseSha: string) {
  return {
    root,
    loopId: "loop-001" as LoopId,
    waveId: "wave-001",
    repositoryId: "repository-001",
    baseSha,
    h1PolicyDigest: digest("b"),
    sourceInclude: SOURCE_INCLUSIONS,
    workspaceInclude: ["**/*"],
    exclusions: CONTROL_EXCLUSIONS,
    declaredArtifacts: [],
  } as const;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const override = process.env.PI_LOOP_GIT_PATH;
  const candidates = override !== undefined
    ? [override]
    : process.platform === "win32"
      ? [
        process.env.LOCALAPPDATA === undefined ? "" : join(process.env.LOCALAPPDATA, "Programs", "Git", "mingw64", "bin", "git.exe"),
        process.env.ProgramFiles === undefined ? "" : join(process.env.ProgramFiles, "Git", "mingw64", "bin", "git.exe"),
        "git",
      ]
      : ["git"];
  const executable = candidates.find((candidate) => candidate !== "") ?? "git";
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await execFileAsync(executable, ["-C", root, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
        },
      });
      return result.stdout;
    } catch (error) {
      lastError = error;
      const stderr = String((error as { stderr?: string }).stderr ?? error);
      if (!/error launching git/iu.test(stderr) || attempt === 4) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function repository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-manifest-"));
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
  await git(root, ["-c", "user.name=PI Tests", "-c", "user.email=pi@example.invalid", "commit", "-m", "initial"]);
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

test("WaveInput rejects undeclared ignored inputs and accepts an exact declaration", async (t) => {
  const root = await repository(t);
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "calibration.bin"), "calibration-v1");
  const options = waveOptions(root, (await git(root, ["rev-parse", "HEAD"])).trim());

  await assert.rejects(sealWaveInput(options), /ignored.*declar|declar.*ignored/iu);
  await assert.doesNotReject(sealWaveInput({
    ...options,
    declaredArtifacts: [{ kind: "file", path: "ignored/calibration.bin", provenance: "calibration input" }],
  }));
});

test("ambient global excludes cannot hide an untracked workspace input", async (t) => {
  const root = await repository(t);
  const home = await mkdtemp(join(tmpdir(), "pi-git-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "global-ignore"), "global-hidden.bin\n");
  await writeFile(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${join(home, "global-ignore").replace(/\\/gu, "/")}\n`);
  await writeFile(join(root, "global-hidden.bin"), "behavior-affecting\n");
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  });

  const workspace = await buildWorkspaceManifest({ root, include: ["**/*"], exclusions: [], declaredArtifacts: [] });
  assert.equal(workspace.entries.some((entry) => entry.path === "global-hidden.bin"), true);
});

test("manifest Git discovery is independent of PATH and rejects a relative override", async (t) => {
  const root = await repository(t);
  const emptyPath = await mkdtemp(join(tmpdir(), "pi-empty-path-"));
  t.after(() => rm(emptyPath, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  const oldOverride = process.env.PI_LOOP_GIT_PATH;
  process.env.PATH = emptyPath;
  delete process.env.PI_LOOP_GIT_PATH;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldOverride === undefined) delete process.env.PI_LOOP_GIT_PATH; else process.env.PI_LOOP_GIT_PATH = oldOverride;
  });

  await assert.doesNotReject(buildTreeManifest({ root, include: SOURCE_INCLUSIONS, exclusions: [] }));
  process.env.PI_LOOP_GIT_PATH = "git";
  await assert.rejects(buildTreeManifest({ root, include: SOURCE_INCLUSIONS, exclusions: [] }), /absolute.*Git|Git.*absolute/iu);
});

test("repository fsmonitor configuration cannot execute during manifest capture", async (t) => {
  const root = await repository(t);
  const marker = join(root, "fsmonitor-ran");
  const hook = join(root, process.platform === "win32" ? "fsmonitor.cmd" : "fsmonitor.sh");
  if (process.platform === "win32") {
    await writeFile(hook, `@echo off\r\ntype nul > "${marker}"\r\necho.\r\nexit /b 0\r\n`);
  } else {
    await writeFile(hook, `#!/bin/sh\n: > '${marker.replace(/'/gu, "'\\''")}'\nprintf '\\n'\n`);
    await chmod(hook, 0o700);
  }
  await git(root, ["config", "core.fsmonitor", hook]);
  await buildTreeManifest({ root, include: SOURCE_INCLUSIONS, exclusions: [] });
  assert.equal(await exists(marker), false);
});

test("only declared scratch or cache roots may be excluded and product paths stay protected", async (t) => {
  const root = await repository(t);
  for (const exclusion of ["src", "schemas", "assets", "package.json", "dist", "vendor"]) {
    await assert.rejects(
      buildSourceManifest({ root, include: [], exclusions: [exclusion], declaredArtifacts: [] }),
      /exclusion|protected|scratch|cache/iu,
      exclusion,
    );
  }
  await assert.doesNotReject(buildWorkspaceManifest({ root, include: ["**/*"], exclusions: ["scratch", ".test-dist", "node_modules"], declaredArtifacts: [] }));
});

test("external artifacts require a read-only materialization policy at runtime", async (t) => {
  const root = await repository(t);
  const writable = {
    kind: "external",
    uri: "s3://models/controller",
    mount: "models/controller",
    version: "v7",
    digest: digest("a"),
    provenance: "model registry",
    readOnly: false,
  } as unknown as ArtifactBinding;
  await assert.rejects(
    buildWorkspaceManifest({ root, include: ["**/*"], exclusions: [], declaredArtifacts: [writable] }),
    /read.only/iu,
  );
});

test("symlink targets are bound and symlinks escaping the repository are rejected", async (t) => {
  const root = await repository(t);
  const outside = await mkdtemp(join(tmpdir(), "pi-manifest-outside-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-manifest-"));
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

test("runtime manifest rejects host-specific absolute source-map paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "runtime.js"), "export {};\n");
  await writeFile(join(root, "dist", "runtime.js.map"), JSON.stringify({
    version: 3,
    file: "runtime.js",
    sourceRoot: "",
    sources: [process.platform === "win32" ? "C:/host/repository/src/runtime.ts" : "/host/repository/src/runtime.ts"],
    names: [],
    mappings: "",
  }));
  await assert.rejects(buildRuntimeManifest(root), /source.map.*absolute|absolute.*source.map/iu);
});

test("submodule manifests bind the Gitlink mode and current commit", async (t) => {
  const root = await repository(t);
  const origin = await mkdtemp(join(tmpdir(), "pi-submodule-origin-"));
  t.after(() => rm(origin, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await git(origin, ["init"]);
  await writeFile(join(origin, "controller.ts"), "export const controller = true;\n");
  await git(origin, ["add", "."]);
  await git(origin, ["-c", "user.name=PI Tests", "-c", "user.email=pi@example.invalid", "commit", "-m", "controller"]);
  await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", origin, "modules/controller"]);
  await git(root, ["add", ".gitmodules", "modules/controller"]);

  const tree = await buildTreeManifest({ root, include: ["modules/**"], exclusions: [] });
  const workspace = await buildWorkspaceManifest({ root, include: ["modules/**"], exclusions: [], declaredArtifacts: [] });
  const submodule = tree.entries.find((entry) => entry.path === "modules/controller");
  assert.deepEqual(
    { path: submodule?.path, mode: submodule?.mode, kind: submodule?.kind },
    { path: "modules/controller", mode: "160000", kind: "submodule" },
  );
  assert.deepEqual(
    tree.entries.map((entry) => entry.path),
    [
      "assets/loop-engineering/workflow-spec.json",
      "modules/controller",
      "package-lock.json",
      "package.json",
      "schemas/sample.json",
      "src/product.ts",
    ],
  );
  assert.equal(
    workspace.entries.find((entry) => entry.path === "modules/controller")?.digest,
    submodule?.digest,
  );
});

test("WaveInput rejects dirty, untracked, or ignored submodule content", async (t) => {
  const root = await repository(t);
  const origin = await mkdtemp(join(tmpdir(), "pi-dirty-submodule-origin-"));
  t.after(() => rm(origin, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await git(origin, ["init"]);
  await writeFile(join(origin, ".gitignore"), "ignored.bin\n");
  await writeFile(join(origin, "controller.ts"), "export const controller = true;\n");
  await git(origin, ["add", "."]);
  await git(origin, ["-c", "user.name=PI Tests", "-c", "user.email=pi@example.invalid", "commit", "-m", "controller"]);
  await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", origin, "modules/controller"]);
  await git(root, ["add", ".gitmodules", "modules/controller"]);
  await Promise.all([
    writeFile(join(root, "modules", "controller", "controller.ts"), "export const controller = false;\n"),
    writeFile(join(root, "modules", "controller", "untracked.bin"), "untracked\n"),
    writeFile(join(root, "modules", "controller", "ignored.bin"), "ignored\n"),
  ]);
  await assert.rejects(
    sealWaveInput({
      ...waveOptions(root, (await git(root, ["rev-parse", "HEAD"])).trim()),
      sourceInclude: [...SOURCE_INCLUSIONS, "modules/**"],
    }),
    /submodule.*dirty|dirty.*submodule|submodule.*untracked|submodule.*ignored/iu,
  );
});

test("custom Source inclusions have exact Tree parity", async (t) => {
  const root = await repository(t);
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config", "behavior.yaml"), "mode: safe\n");
  await git(root, ["add", "config/behavior.yaml"]);
  const source = await buildSourceManifest({ root, include: ["config/**/*.yaml"], exclusions: [], declaredArtifacts: [] });
  const tree = await buildTreeManifest({ root, include: ["config/**/*.yaml"], exclusions: [] });
  assert.deepEqual(tree.entries.map((entry) => entry.path), source.entries.map((entry) => entry.path));
});

test("WaveInput rejects index or working-byte mutation during sealing", async (t) => {
  const root = await repository(t);
  const options = waveOptions(root, (await git(root, ["rev-parse", "HEAD"])).trim());
  let stopMutation = false;
  const mutation = (async () => {
    for (let generation = 0; !stopMutation && generation < 40; generation += 1) {
      await writeFile(join(root, "src", "product.ts"), `export const product = ${generation};\n`);
      try {
        await git(root, ["add", "src/product.ts"]);
      } catch {
        // Windows Git launch flakes must not abort the mutation race.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  })();
  try {
    await assert.rejects(
      sealWaveInput(options),
      /mutat|changed.*seal|snapshot|index changed|manifest capture|Git could not|RECONCILE/iu,
    );
  } finally {
    stopMutation = true;
    await mutation;
  }
});

test("WaveInput cannot narrow away an untracked workspace input", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "behavior.bin"), "behavior-v1\n");
  const options = {
    ...waveOptions(root, (await git(root, ["rev-parse", "HEAD"])).trim()),
    workspaceInclude: ["src/**"],
  } as const;
  const first = await sealWaveInput(options);
  await writeFile(join(root, "behavior.bin"), "behavior-v2\n");
  const second = await sealWaveInput(options);
  assert.notEqual(first.workspace_manifest_digest, second.workspace_manifest_digest);
});

test("WaveInput binds repository identity and deterministic manifests without changing the index", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "src", "product.ts"), "export const product = 9;\n");
  const indexBefore = await readFile(join(root, ".git", "index"));
  const options = waveOptions(root, (await git(root, ["rev-parse", "HEAD"])).trim());

  const first = await sealWaveInput(options);
  const second = await sealWaveInput(options);
  const otherRepository = await sealWaveInput({ ...options, repositoryId: "repository-002" });
  assert.deepEqual(second, first);
  assert.notEqual(otherRepository.digest, first.digest);
  const explicitIdentity = (first as unknown as { repository_identity_digest?: Digest }).repository_identity_digest;
  assert.equal(explicitIdentity, sha256Hex("repository-001"));
  const { digest: sealedDigest, ...returnedFields } = first;
  assert.equal(sealedDigest, sha256Hex(canonicalJsonBytes(returnedFields)));
  assert.notEqual(first.source_manifest_digest, first.tree_manifest_digest);
  assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
});
