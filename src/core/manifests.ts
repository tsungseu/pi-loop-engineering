import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { WaveInput } from "../contracts/dispatch.js";
import {
  LoopError,
  sha256Hex,
  type Digest,
  type LoopId,
} from "../contracts/domain.js";
import type {
  ContentManifest,
  EvidenceRecord,
  ManifestEntry,
} from "../contracts/harness.js";
import { atomicWriteFile, canonicalJsonBytes } from "./atomic-json.js";
import { assertContained } from "./paths.js";
import { validateSchema } from "./schema.js";

export const CONTROL_EXCLUSIONS = [".git", ".ai-loop", ".codegraph"] as const;
export const SOURCE_INCLUSIONS = [
  "src/**/*.ts",
  "schemas/**/*.json",
  "assets/loop-engineering/workflow-spec.json",
  "package.json",
  "package-lock.json",
] as const;
export const RUNTIME_INCLUSIONS = ["dist/**/*.js", "dist/**/*.js.map"] as const;

export type ArtifactBinding =
  | {
    kind: "file";
    path: string;
    provenance: string;
  }
  | {
    kind: "external";
    uri: string;
    mount: string;
    version: string;
    digest: Digest;
    provenance: string;
    readOnly: true;
  }
  | {
    kind: "secret";
    provider: string;
    handle: string;
    version: string;
  };

export interface ManifestOptions {
  root: string;
  include: readonly string[];
  exclusions: readonly string[];
  declaredArtifacts: readonly ArtifactBinding[];
}

export interface TreeManifestOptions {
  root: string;
  include: readonly string[];
  exclusions: readonly string[];
}

export interface WaveInputOptions {
  root: string;
  loopId: LoopId;
  waveId: string;
  repositoryId: string;
  baseSha: string;
  h1PolicyDigest: Digest;
  sourceInclude?: readonly string[];
  workspaceInclude?: readonly string[];
  exclusions?: readonly string[];
  declaredArtifacts?: readonly ArtifactBinding[];
}

export interface EvidenceBinding {
  loopId: LoopId;
  workItemId: string;
  attempt: number;
  actorRole: string;
  h1Digest: Digest;
  waveInputDigest: Digest;
  outputTreeDigest: Digest;
  argv: readonly string[];
  executablePath: string;
  executableDigest: Digest;
  versionArgv: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  environmentDigest: Digest;
  toolVersions: Readonly<Record<string, string>>;
  artifactManifestDigest: Digest;
}

export interface EvidenceCommandRequest extends Pick<EvidenceBinding,
  "loopId" | "workItemId" | "attempt" | "actorRole" | "h1Digest" | "waveInputDigest" | "outputTreeDigest"
> {
  executable: string;
  versionArgs: readonly string[];
  args: readonly string[];
  cwd: string;
  envAllowlist: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  evidenceDirectory: string;
  declaredArtifacts: readonly ArtifactBinding[];
}

interface GitIndexEntry {
  path: string;
  mode: string;
  objectId: string;
}

interface GitSnapshot {
  root: string;
  index: ReadonlyMap<string, GitIndexEntry>;
  untracked: readonly string[];
  ignored: readonly string[];
  indexBytes: Buffer;
  statusBytes: Buffer;
  indexFileBytes: Buffer;
}

interface CommandCapture {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const ENVIRONMENT_NAME_PATTERN = /^[^=\0]+$/u;
const GIT_CAPTURE_LIMIT_BYTES = 64 * 1024 * 1024;
const VERSION_CAPTURE_LIMIT_BYTES = 64 * 1024;
const EVIDENCE_CAPTURE_HARD_LIMIT_BYTES = 64 * 1024 * 1024;
const SCRATCH_CACHE_NAMES = new Set([
  ".cache", ".coverage", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".test-dist",
  ".tmp", "build", "cache", "caches", "coverage", "htmlcov", "node_modules", "scratch", "temp", "tmp",
]);
const PROTECTED_DIRECTORY_ROOTS = ["src", "schemas", "dist"] as const;
const PROTECTED_FILES = [
  "assets/loop-engineering/workflow-spec.json",
  "package.json",
  "package-lock.json",
] as const;

function schemaError(message: string, details: Readonly<Record<string, unknown>> = {}): LoopError {
  return new LoopError("SCHEMA_INVALID", message, details);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  const segments = normalized.split("/");
  if (
    normalized === ""
    || normalized.includes("\0")
    || isAbsolute(normalized)
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw schemaError("Manifest paths must be normalized repository-relative paths.", { path });
  }
  return normalized;
}

function normalizeExclusions(exclusions: readonly string[]): readonly string[] {
  const normalized = exclusions.map(normalizeRelativePath);
  for (const path of normalized) {
    if (/[*?\[]/u.test(path)) {
      throw schemaError("Manifest exclusions must name exact directory roots.", { path });
    }
    if (CONTROL_EXCLUSIONS.includes(path as (typeof CONTROL_EXCLUSIONS)[number])) continue;
    const leaf = path.split("/").at(-1);
    const overlapsProtected = PROTECTED_DIRECTORY_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
      || PROTECTED_FILES.some((file) => file === path || file.startsWith(`${path}/`) || path.startsWith(`${file}/`));
    if (overlapsProtected) {
      throw schemaError("Manifest exclusions cannot overlap protected product or runtime paths.", { path });
    }
    if (leaf === undefined || !SCRATCH_CACHE_NAMES.has(leaf)) {
      throw schemaError("Manifest exclusions must declare a recognized scratch or cache root.", { path });
    }
  }
  return [...new Set(normalized)].sort(compareText);
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((root) => path === root || path.startsWith(`${root}/`));
}

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function globExpression(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/gu, "/").replace(/^\.\//u, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
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
    } else if (character !== undefined) {
      source += escapeRegularExpression(character);
    }
  }
  return new RegExp(`${source}$`, "u");
}

function inclusionMatcher(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length === 0) throw schemaError("A manifest requires at least one inclusion pattern.");
  const expressions = patterns.map((pattern) => globExpression(pattern));
  return (path) => expressions.some((expression) => expression.test(path));
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

let emptyHooksDirectoryPromise: Promise<string> | undefined;

async function emptyHooksDirectory(): Promise<string> {
  if (emptyHooksDirectoryPromise === undefined) {
    emptyHooksDirectoryPromise = (async () => {
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      return mkdtemp(join(tmpdir(), "pai-git-hooks-"));
    })();
  }
  return emptyHooksDirectoryPromise;
}

function gitEnvironment(executable: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_CONFIG_SYSTEM: nullDevice(),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const gitBin = dirname(executable);
  const gitRoot = dirname(dirname(gitBin));
  const pathParts = [gitBin, join(gitRoot, "cmd"), join(gitRoot, "usr", "bin"), join(gitRoot, "mingw64", "bin")]
    .filter((part, index, values) => values.indexOf(part) === index);
  environment.PATH = pathParts.join(process.platform === "win32" ? ";" : ":");
  return environment;
}

interface CaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

function capture(command: string, args: readonly string[], options: CaptureOptions = {}): Promise<CommandCapture> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: "stdout" | "stderr" | undefined;
    const onChunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (overflow !== undefined) return;
      const limit = stream === "stdout"
        ? options.maxStdoutBytes ?? GIT_CAPTURE_LIMIT_BYTES
        : options.maxStderrBytes ?? GIT_CAPTURE_LIMIT_BYTES;
      const next = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
      if (next > limit) {
        overflow = stream;
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.kill("SIGKILL");
        } catch {
          // Best-effort termination after a saturated capture pipe.
        }
        return;
      }
      if (stream === "stdout") {
        stdoutBytes = next;
        stdout.push(chunk);
      } else {
        stderrBytes = next;
        stderr.push(chunk);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (overflow !== undefined) {
        rejectPromise(schemaError(`Process ${overflow} exceeded its capture limit.`, { command, stream: overflow }));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code, signal });
    });
  });
}

let cachedGitExecutable:
  | { override: string | undefined; path: string }
  | undefined;

async function pathLookupAbsoluteGit(): Promise<string | undefined> {
  const pathEnv = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  for (const directory of pathEnv.split(separator)) {
    if (directory === "") continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        const canonical = await realpath(candidate);
        if ((await stat(canonical)).isFile()) return canonical;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return undefined;
}

async function resolveTrustedGitExecutable(): Promise<string> {
  const override = process.env.PAI_LOOP_GIT_PATH;
  if (override !== undefined && !isAbsolute(override)) {
    throw schemaError("The configured Git executable must be an absolute path.");
  }
  if (cachedGitExecutable !== undefined && cachedGitExecutable.override === override) {
    return cachedGitExecutable.path;
  }
  const candidates = override === undefined
    ? process.platform === "win32"
      ? [
        process.env.LOCALAPPDATA === undefined ? "" : join(process.env.LOCALAPPDATA, "Programs", "Git", "mingw64", "bin", "git.exe"),
        process.env.ProgramFiles === undefined ? "" : join(process.env.ProgramFiles, "Git", "mingw64", "bin", "git.exe"),
        process.env.LOCALAPPDATA === undefined ? "" : join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
        process.env.ProgramFiles === undefined ? "" : join(process.env.ProgramFiles, "Git", "cmd", "git.exe"),
      ]
      : process.platform === "darwin"
        ? ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/opt/local/bin/git"]
        : ["/usr/bin/git", "/usr/local/bin/git", "/usr/lib/git-core/git"]
    : [override];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      const canonical = await realpath(candidate);
      if (!(await stat(canonical)).isFile()) continue;
      cachedGitExecutable = { override, path: canonical };
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (override === undefined) {
    const fromPath = await pathLookupAbsoluteGit();
    if (fromPath !== undefined) {
      cachedGitExecutable = { override, path: fromPath };
      return fromPath;
    }
  }
  throw schemaError("A trusted absolute Git executable could not be resolved.", {
    override_configured: override !== undefined,
    platform: process.platform,
  });
}

async function trustedGitExecutable(root: string): Promise<string> {
  const canonical = await resolveTrustedGitExecutable();
  const containment = relative(root, canonical);
  if (containment === "" || (!containment.startsWith("..") && !isAbsolute(containment))) {
    throw schemaError("The Git executable cannot be resolved from inside the repository.", { path: canonical });
  }
  return canonical;
}

async function git(root: string, args: readonly string[]): Promise<Buffer> {
  const executable = await trustedGitExecutable(root);
  const hooksPath = await emptyHooksDirectory();
  const hardenedArgs = [
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", `core.excludesFile=${nullDevice()}`,
    "-c", `core.attributesFile=${nullDevice()}`,
    "-c", `core.hooksPath=${hooksPath}`,
    "-C", root,
    ...args,
  ];
  let lastFailure: CommandCapture | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await capture(executable, hardenedArgs, {
      env: gitEnvironment(executable),
      maxStdoutBytes: GIT_CAPTURE_LIMIT_BYTES,
      maxStderrBytes: GIT_CAPTURE_LIMIT_BYTES,
    });
    if (result.code === 0) return result.stdout;
    lastFailure = result;
    const stderr = result.stderr.toString("utf8");
    const transient = /error launching git|Unknown error|resource temporarily unavailable|EAGAIN/iu.test(stderr)
      || result.code === null;
    if (!transient || attempt === 2) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25 * (attempt + 1)));
  }
  throw schemaError("Git could not build a reproducible manifest.", {
    argv: [executable, ...hardenedArgs],
    exit_code: lastFailure?.code ?? null,
    signal: lastFailure?.signal ?? null,
    stderr: lastFailure?.stderr.toString("utf8").replace(/[\r\n]+$/u, "") ?? "",
  });
}

function nulRecords(bytes: Buffer): readonly string[] {
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index > start) records.push(bytes.subarray(start, index).toString("utf8"));
    start = index + 1;
  }
  if (start !== bytes.length) throw schemaError("Git returned a non-terminated path record.");
  return records;
}

function parseIndex(bytes: Buffer): ReadonlyMap<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>();
  for (const record of nulRecords(bytes)) {
    const separator = record.indexOf("\t");
    const header = separator < 0 ? "" : record.slice(0, separator);
    const path = normalizeRelativePath(separator < 0 ? "" : record.slice(separator + 1));
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/u.exec(header);
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] !== "0") {
      throw new LoopError("RECONCILE_REQUIRED", "The Git index contains an unsupported or unmerged entry.", { path, header });
    }
    if (entries.has(path)) throw new LoopError("RECONCILE_REQUIRED", "The Git index contains duplicate normalized paths.", { path });
    entries.set(path, { path, mode: match[1], objectId: match[2] });
  }
  return entries;
}

async function gitSnapshot(root: string): Promise<GitSnapshot> {
  const canonicalRoot = await realpath(resolve(root));
  const indexPathOutput = (await git(canonicalRoot, ["rev-parse", "--git-path", "index"])).toString("utf8").trim();
  if (indexPathOutput === "") throw schemaError("Git returned an empty index path.");
  const indexPath = isAbsolute(indexPathOutput) ? indexPathOutput : resolve(canonicalRoot, indexPathOutput);
  const indexFileBefore = await readFile(indexPath);
  const indexBytes = await git(canonicalRoot, ["ls-files", "-s", "-z"]);
  const untrackedBytes = await git(canonicalRoot, ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z"]);
  const ignoredBytes = await git(canonicalRoot, ["ls-files", "--others", "--ignored", "--exclude-per-directory=.gitignore", "-z"]);
  const statusBytes = await git(canonicalRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching"]);
  const indexFileAfter = await readFile(indexPath);
  if (!indexFileAfter.equals(indexFileBefore)) {
    throw new LoopError("RECONCILE_REQUIRED", "The Git index changed during manifest capture.");
  }
  const untracked = nulRecords(untrackedBytes).map(normalizeRelativePath).sort(compareText);
  const ignored = nulRecords(ignoredBytes).map(normalizeRelativePath).sort(compareText);
  return {
    root: canonicalRoot,
    index: parseIndex(indexBytes),
    untracked,
    ignored,
    indexBytes,
    statusBytes,
    indexFileBytes: indexFileAfter,
  };
}

function parseNameStatusPaths(bytes: Buffer): string[] {
  const paths = new Set<string>();
  const records = nulRecords(bytes);
  for (let index = 0; index < records.length;) {
    const status = records[index];
    if (status === undefined || status.length === 0) {
      throw schemaError("Git name-status output is malformed.", { index });
    }
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = records[index + 1];
      const newPath = records[index + 2];
      if (oldPath === undefined || newPath === undefined) {
        throw schemaError("Git rename/copy name-status is incomplete.", { status });
      }
      paths.add(normalizeRelativePath(oldPath));
      paths.add(normalizeRelativePath(newPath));
      index += 3;
      continue;
    }
    const path = records[index + 1];
    if (path === undefined) {
      throw schemaError("Git name-status path is missing.", { status });
    }
    paths.add(normalizeRelativePath(path));
    index += 2;
  }
  return [...paths];
}

/**
 * Independently enumerate Worktree paths that differ from a WaveInput base SHA:
 * tracked modifications/deletes/renames/symlinks/submodules, untracked, and ignored entries.
 * Control / scratch roots are excluded.
 */
export async function observeWorktreeWrites(options: {
  root: string;
  baseSha: string;
  exclusions?: readonly string[];
}): Promise<readonly string[]> {
  if (!SHA_PATTERN.test(options.baseSha)) {
    throw schemaError("A WaveInput base SHA is required to observe Worktree writes.", { base_sha: options.baseSha });
  }
  const canonicalRoot = await realpath(resolve(options.root));
  const exclusions = normalizeExclusions([...CONTROL_EXCLUSIONS, ...(options.exclusions ?? [])]);
  const nameStatus = await git(canonicalRoot, [
    "diff", "--name-status", "-z", "-M", "--ignore-submodules=dirty", options.baseSha,
  ]);
  const untrackedBytes = await git(canonicalRoot, ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z"]);
  const ignoredBytes = await git(canonicalRoot, [
    "ls-files", "--others", "--ignored", "--exclude-per-directory=.gitignore", "-z",
  ]);
  const paths = new Set<string>([
    ...parseNameStatusPaths(nameStatus),
    ...nulRecords(untrackedBytes).map(normalizeRelativePath),
    ...nulRecords(ignoredBytes).map(normalizeRelativePath),
  ]);
  return [...paths].filter((path) => !isExcluded(path, exclusions)).sort(compareText);
}

export async function digestWorktreePaths(
  root: string,
  paths: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const canonicalRoot = await realpath(resolve(root));
  const digests: Record<string, string> = {};
  for (const path of [...paths].map(normalizeRelativePath).sort(compareText)) {
    const absolute = resolve(canonicalRoot, path);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        digests[path] = sha256Hex(`symlink:${await readlink(absolute)}`);
      } else if (info.isFile()) {
        digests[path] = sha256Hex(await readFile(absolute));
      } else if (info.isDirectory()) {
        digests[path] = sha256Hex(`dir:${path}`);
      } else {
        digests[path] = sha256Hex(`special:${path}:${info.mode}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        digests[path] = sha256Hex("deleted");
        continue;
      }
      throw error;
    }
  }
  return digests;
}

function normalizeAbsolutePath(path: string): string {
  return resolve(path).replace(/\\/gu, "/").replace(/\/+$/u, "");
}

/** Canonical absolute path for external-root leases (realpath when available). */
export async function canonicalizeExternalRoot(root: string): Promise<string> {
  const resolved = resolve(root);
  try {
    return normalizeAbsolutePath(await realpath(resolved));
  } catch {
    return normalizeAbsolutePath(resolved);
  }
}

async function digestAbsolutePath(absolute: string): Promise<string> {
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      return sha256Hex(`symlink:${await readlink(absolute)}`);
    }
    if (info.isFile()) {
      return sha256Hex(await readFile(absolute));
    }
    if (info.isDirectory()) {
      return sha256Hex(`dir:${normalizeAbsolutePath(absolute)}`);
    }
    return sha256Hex(`special:${normalizeAbsolutePath(absolute)}:${info.mode}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return sha256Hex("deleted");
    }
    throw error;
  }
}

async function walkAbsoluteFiles(directory: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walkAbsoluteFiles(absolutePath, output);
      continue;
    }
    output.push(normalizeAbsolutePath(absolutePath));
  }
}

/** Capture content digests for every file under a permitted external write root. */
export async function captureExternalRootDigests(
  root: string,
): Promise<Readonly<Record<string, string>>> {
  const canonical = await canonicalizeExternalRoot(root);
  const paths: string[] = [];
  await walkAbsoluteFiles(canonical, paths);
  const digests: Record<string, string> = {};
  for (const path of paths.sort(compareText)) {
    digests[path] = await digestAbsolutePath(path);
  }
  return digests;
}

/**
 * Independently enumerate writes under a permitted external root relative to a
 * reservation-time baseline. Paths are absolute, slash-normalized.
 */
export async function observeExternalRootWrites(options: {
  root: string;
  baselineDigests: Readonly<Record<string, string>>;
}): Promise<readonly string[]> {
  const current = await captureExternalRootDigests(options.root);
  const baseline = options.baselineDigests;
  const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const changed: string[] = [];
  const deleted = sha256Hex("deleted");
  for (const path of [...paths].sort(compareText)) {
    const before = baseline[path] ?? deleted;
    const after = current[path] ?? deleted;
    if (before !== after) changed.push(path);
  }
  return changed;
}

function snapshotDigest(snapshot: GitSnapshot): Digest {
  return sha256Hex(canonicalJsonBytes({
    ignored: snapshot.ignored,
    index: snapshot.indexBytes.toString("base64"),
    index_file: snapshot.indexFileBytes.toString("base64"),
    status: snapshot.statusBytes.toString("base64"),
    untracked: snapshot.untracked,
  }));
}

function sameEntry(left: ManifestEntry | undefined, right: ManifestEntry | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.path === right.path
    && left.mode === right.mode
    && left.digest === right.digest
    && left.kind === right.kind;
}

async function assertSymlinkContained(root: string, path: string, target: string): Promise<void> {
  const candidate = isAbsolute(target)
    ? target
    : resolve(dirname(resolve(root, path)), target);
  try {
    await assertContained(root, candidate);
  } catch (error) {
    throw schemaError("Manifest symlink target is outside the repository containment boundary.", {
      path,
      target,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function indexEntry(root: string, entry: GitIndexEntry): Promise<ManifestEntry> {
  if (entry.mode === "160000") {
    return { path: entry.path, mode: entry.mode, digest: sha256Hex(entry.objectId), kind: "submodule" };
  }
  const bytes = await git(root, ["cat-file", "blob", entry.objectId]);
  if (entry.mode === "120000") {
    const target = bytes.toString("utf8");
    await assertSymlinkContained(root, entry.path, target);
    return { path: entry.path, mode: entry.mode, digest: sha256Hex(bytes), kind: "symlink" };
  }
  return { path: entry.path, mode: entry.mode, digest: sha256Hex(bytes), kind: "file" };
}

async function currentSubmoduleEntry(root: string, entry: GitIndexEntry): Promise<ManifestEntry> {
  const submoduleRoot = await assertContained(root, resolve(root, entry.path));
  const commit = (await git(submoduleRoot, ["rev-parse", "HEAD"])).toString("utf8").trim();
  if (!SHA_PATTERN.test(commit)) {
    throw new LoopError("RECONCILE_REQUIRED", "A submodule did not resolve to a commit.", { path: entry.path });
  }
  return { path: entry.path, mode: "160000", digest: sha256Hex(commit), kind: "submodule" };
}

async function assertCleanSubmodules(snapshot: GitSnapshot): Promise<void> {
  for (const entry of snapshot.index.values()) {
    if (entry.mode !== "160000") continue;
    const submoduleRoot = await assertContained(snapshot.root, resolve(snapshot.root, entry.path));
    const statusBytes = await git(submoduleRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching"]);
    if (statusBytes.byteLength > 0) {
      throw new LoopError("RECONCILE_REQUIRED", "A submodule contains dirty, untracked, or ignored content that is not fully bound.", {
        path: entry.path,
      });
    }
  }
}

async function filesystemEntry(root: string, path: string, tracked?: GitIndexEntry): Promise<ManifestEntry | undefined> {
  const absolutePath = resolve(root, path);
  await assertContained(root, absolutePath);
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (tracked?.mode === "160000") return currentSubmoduleEntry(root, tracked);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    const after = await lstat(absolutePath);
    if (after.mtimeMs !== metadata.mtimeMs || after.ino !== metadata.ino || after.mode !== metadata.mode) {
      throw new LoopError("RECONCILE_REQUIRED", "A symlink changed during manifest capture.", { path });
    }
    await assertSymlinkContained(root, path, target);
    return { path, mode: "120000", digest: sha256Hex(Buffer.from(target)), kind: "symlink" };
  }
  if (!metadata.isFile()) {
    throw schemaError("Manifest inputs must be files, symlinks, or Git submodules.", { path });
  }
  const mode = tracked?.mode ?? ((metadata.mode & 0o111) === 0 ? "100644" : "100755");
  const digest = await sha256File(absolutePath);
  const after = await lstat(absolutePath);
  if (
    after.size !== metadata.size
    || after.mtimeMs !== metadata.mtimeMs
    || after.ino !== metadata.ino
    || after.mode !== metadata.mode
  ) {
    throw new LoopError("RECONCILE_REQUIRED", "A file changed during manifest capture.", { path });
  }
  return { path, mode, digest, kind: "file" };
}

function externalEntry(binding: Extract<ArtifactBinding, { kind: "external" }>): ManifestEntry {
  if (binding.readOnly !== true) throw schemaError("External artifact materialization must be read-only.");
  if (!DIGEST_PATTERN.test(binding.digest) || binding.uri === "" || binding.version === "" || binding.provenance === "") {
    throw schemaError("External artifacts require URI, version, digest, and provenance.");
  }
  const path = normalizeRelativePath(binding.mount);
  return {
    path,
    mode: "external-readonly",
    digest: binding.digest,
    kind: "external",
    provenance: JSON.stringify({
      provenance: binding.provenance,
      read_only: binding.readOnly,
      uri: binding.uri,
      version: binding.version,
    }),
  };
}

function secretEntry(binding: Extract<ArtifactBinding, { kind: "secret" }>): ManifestEntry {
  if (binding.provider === "" || binding.handle === "" || binding.version === "") {
    throw schemaError("Secret artifacts require provider, handle, and version metadata.");
  }
  const metadata = { provider: binding.provider, handle: binding.handle, version: binding.version };
  return {
    path: `secret://${binding.provider}/${binding.handle}`,
    mode: "secret-metadata",
    digest: sha256Hex(canonicalJsonBytes(metadata)),
    kind: "external",
    provenance: JSON.stringify(metadata),
  };
}

type FilesystemEntryCache = Map<string, Promise<ManifestEntry | undefined>>;

function cachedFilesystemEntry(
  cache: FilesystemEntryCache | undefined,
  root: string,
  path: string,
  tracked?: GitIndexEntry,
): Promise<ManifestEntry | undefined> {
  if (cache === undefined) return filesystemEntry(root, path, tracked);
  const existing = cache.get(path);
  if (existing !== undefined) return existing;
  const captured = filesystemEntry(root, path, tracked);
  cache.set(path, captured);
  return captured;
}

async function artifactEntries(
  root: string,
  bindings: readonly ArtifactBinding[],
  cache?: FilesystemEntryCache,
  index?: ReadonlyMap<string, GitIndexEntry>,
): Promise<readonly ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const binding of bindings) {
    if (binding.kind === "external") {
      entries.push(externalEntry(binding));
    } else if (binding.kind === "secret") {
      entries.push(secretEntry(binding));
    } else {
      const path = normalizeRelativePath(binding.path);
      const entry = await cachedFilesystemEntry(cache, root, path, index?.get(path));
      if (entry === undefined) throw schemaError("A declared file artifact does not exist.", { path });
      entries.push({ ...entry, provenance: binding.provenance });
    }
  }
  return entries;
}

function contentManifest(kind: ContentManifest["kind"], entries: readonly ManifestEntry[]): ContentManifest {
  const sortedEntries = [...entries].sort((left, right) => compareText(left.path, right.path));
  for (let index = 1; index < sortedEntries.length; index += 1) {
    if (sortedEntries[index - 1]?.path === sortedEntries[index]?.path) {
      throw schemaError("Manifest entries must have unique normalized paths.", { path: sortedEntries[index]?.path });
    }
  }
  const content = { schema_version: 1 as const, kind, entries: sortedEntries };
  return validateSchema<ContentManifest>("manifest", { ...content, digest: sha256Hex(canonicalJsonBytes(content)) });
}

async function buildGitManifest(
  kind: "source" | "tree" | "workspace",
  options: TreeManifestOptions | ManifestOptions,
  sealedSnapshot?: GitSnapshot,
  filesystemCache?: FilesystemEntryCache,
): Promise<ContentManifest> {
  const snapshot = sealedSnapshot ?? await gitSnapshot(options.root);
  const exclusions = normalizeExclusions([...CONTROL_EXCLUSIONS, ...options.exclusions]);
  const includes = inclusionMatcher(options.include);
  const entries: ManifestEntry[] = [];
  const paths = new Set<string>();
  for (const path of snapshot.index.keys()) paths.add(path);
  if (kind !== "tree") for (const path of snapshot.untracked) paths.add(path);

  for (const path of [...paths].sort(compareText)) {
    if (isExcluded(path, exclusions) || !includes(path)) continue;
    const tracked = snapshot.index.get(path);
    const entry = kind === "tree"
      ? tracked === undefined ? undefined : await indexEntry(snapshot.root, tracked)
      : await cachedFilesystemEntry(filesystemCache, snapshot.root, path, tracked);
    if (entry !== undefined) entries.push(entry);
  }

  if (kind === "workspace" && "declaredArtifacts" in options) {
    for (const entry of await artifactEntries(snapshot.root, options.declaredArtifacts, filesystemCache, snapshot.index)) {
      if (!isExcluded(entry.path, exclusions)) entries.push(entry);
    }
  }
  return contentManifest(kind, entries);
}

export function buildSourceManifest(options: ManifestOptions): Promise<ContentManifest> {
  return buildGitManifest("source", {
    ...options,
    include: [...SOURCE_INCLUSIONS, ...options.include],
  });
}

export function buildTreeManifest(options: TreeManifestOptions): Promise<ContentManifest> {
  return buildGitManifest("tree", { ...options, include: [...SOURCE_INCLUSIONS, ...options.include] });
}

export function buildWorkspaceManifest(options: ManifestOptions): Promise<ContentManifest> {
  return buildGitManifest("workspace", options);
}

async function walkFiles(root: string, directory: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = normalizeRelativePath(relative(root, absolutePath));
    if (entry.isDirectory()) await walkFiles(root, absolutePath, output);
    else output.push(relativePath);
  }
}

function isHostAbsoluteSourceMapPath(path: string): boolean {
  return isAbsolute(path)
    || /^[A-Za-z]:[\\/]/u.test(path)
    || /^\\\\/u.test(path)
    || /^file:\/\//iu.test(path);
}

async function validateRuntimeSourceMap(root: string, path: string): Promise<void> {
  if (!path.endsWith(".js.map")) return;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(root, path), "utf8"));
  } catch (error) {
    throw schemaError("Runtime source-map JSON is invalid.", { path, cause: error instanceof Error ? error.message : String(error) });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw schemaError("Runtime source-map JSON must be an object.", { path });
  }
  const record = value as Readonly<Record<string, unknown>>;
  const candidates = [record.sourceRoot, ...(Array.isArray(record.sources) ? record.sources : [])];
  if (candidates.some((candidate) => typeof candidate === "string" && isHostAbsoluteSourceMapPath(candidate))) {
    throw schemaError("Runtime source-map paths cannot contain host-specific absolute paths.", { path });
  }
}

export async function buildRuntimeManifest(root: string): Promise<ContentManifest> {
  const canonicalRoot = await realpath(resolve(root));
  const paths: string[] = [];
  try {
    await walkFiles(canonicalRoot, resolve(canonicalRoot, "dist"), paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const includes = inclusionMatcher(RUNTIME_INCLUSIONS);
  const entries: ManifestEntry[] = [];
  for (const path of paths.filter(includes).sort(compareText)) {
    await validateRuntimeSourceMap(canonicalRoot, path);
    const entry = await filesystemEntry(canonicalRoot, path);
    if (entry !== undefined) entries.push(entry);
  }
  return contentManifest("runtime", entries);
}

async function buildArtifactManifest(
  root: string,
  bindings: readonly ArtifactBinding[],
  cache?: FilesystemEntryCache,
  index?: ReadonlyMap<string, GitIndexEntry>,
): Promise<ContentManifest> {
  return contentManifest("artifact", await artifactEntries(await realpath(resolve(root)), bindings, cache, index));
}

function assertIgnoredInputsBound(
  snapshot: GitSnapshot,
  exclusions: readonly string[],
  declaredArtifacts: readonly ArtifactBinding[],
): void {
  const declaredFiles = new Set(
    declaredArtifacts
      .filter((binding): binding is Extract<ArtifactBinding, { kind: "file" }> => binding.kind === "file")
      .map((binding) => normalizeRelativePath(binding.path)),
  );
  for (const path of snapshot.ignored) {
    if (isExcluded(path, exclusions) || declaredFiles.has(path)) continue;
    throw new LoopError("RECONCILE_REQUIRED", "An ignored input must be explicitly declared or placed below a declared scratch/cache root.", { path });
  }
}

async function assertSealedSnapshotStable(
  initial: GitSnapshot,
  cache: FilesystemEntryCache,
): Promise<void> {
  const afterManifest = await gitSnapshot(initial.root);
  if (snapshotDigest(afterManifest) !== snapshotDigest(initial)) {
    throw new LoopError("RECONCILE_REQUIRED", "Repository state changed during WaveInput snapshot sealing.");
  }
  await assertCleanSubmodules(afterManifest);
  for (const [path, capturedPromise] of cache) {
    const captured = await capturedPromise;
    const current = await filesystemEntry(initial.root, path, initial.index.get(path));
    if (!sameEntry(captured, current)) {
      throw new LoopError("RECONCILE_REQUIRED", "Working bytes changed during WaveInput snapshot sealing.", { path });
    }
  }
  const afterValidation = await gitSnapshot(initial.root);
  if (snapshotDigest(afterValidation) !== snapshotDigest(initial)) {
    throw new LoopError("RECONCILE_REQUIRED", "Repository state changed while validating the sealed WaveInput snapshot.");
  }
}

async function captureWorkspaceEntries(
  snapshot: GitSnapshot,
  declaredArtifacts: readonly ArtifactBinding[],
  exclusions: readonly string[],
): Promise<FilesystemEntryCache> {
  const paths = new Set<string>(
    [...snapshot.index.keys(), ...snapshot.untracked].filter((path) => !isExcluded(path, exclusions)),
  );
  for (const binding of declaredArtifacts) {
    if (binding.kind === "file") paths.add(normalizeRelativePath(binding.path));
  }
  const cache: FilesystemEntryCache = new Map();
  for (const path of [...paths].sort(compareText)) {
    await cachedFilesystemEntry(cache, snapshot.root, path, snapshot.index.get(path));
  }
  return cache;
}

export async function sealWaveInput(options: WaveInputOptions): Promise<WaveInput> {
  if (options.waveId === "" || options.repositoryId === "" || !SHA_PATTERN.test(options.baseSha) || !DIGEST_PATTERN.test(options.h1PolicyDigest)) {
    throw schemaError("WaveInput identifiers and digests are invalid.");
  }
  const requestedExclusions = options.exclusions ?? [];
  const exclusions = normalizeExclusions([...CONTROL_EXCLUSIONS, ...requestedExclusions]);
  const declaredArtifacts = options.declaredArtifacts ?? [];
  const snapshot = await gitSnapshot(options.root);
  assertIgnoredInputsBound(snapshot, exclusions, declaredArtifacts);
  await assertCleanSubmodules(snapshot);
  const filesystemCache = await captureWorkspaceEntries(snapshot, declaredArtifacts, exclusions);
  const sourceIncludes = [...SOURCE_INCLUSIONS, ...(options.sourceInclude ?? [])];
  const source = await buildGitManifest("source", {
    root: options.root,
    include: sourceIncludes,
    exclusions,
    declaredArtifacts,
  }, snapshot, filesystemCache);
  const tree = await buildGitManifest("tree", { root: options.root, include: sourceIncludes, exclusions }, snapshot);
  const workspace = await buildGitManifest(
    "workspace",
    { root: options.root, include: ["**/*"], exclusions, declaredArtifacts },
    snapshot,
    filesystemCache,
  );
  const artifacts = await buildArtifactManifest(snapshot.root, declaredArtifacts, filesystemCache, snapshot.index);
  await assertSealedSnapshotStable(snapshot, filesystemCache);
  const content = {
    schema_version: 1 as const,
    loop_id: options.loopId,
    wave_id: options.waveId,
    base_sha: options.baseSha,
    repository_identity_digest: sha256Hex(options.repositoryId),
    source_manifest_digest: source.digest,
    tree_manifest_digest: tree.digest,
    workspace_manifest_digest: workspace.digest,
    artifact_manifest_digest: artifacts.digest,
    h1_policy_digest: options.h1PolicyDigest,
  };
  return validateSchema<WaveInput>("wave-input", { ...content, digest: sha256Hex(canonicalJsonBytes(content)) });
}

function evidenceEnvironment(allowlist: readonly string[]): { env: NodeJS.ProcessEnv; digest: Digest } {
  const environment: NodeJS.ProcessEnv = {};
  const values: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const name of allowlist) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) throw schemaError("Evidence environment names are invalid.", { name });
    const identity = process.platform === "win32" ? name.toUpperCase() : name;
    if (seen.has(identity)) throw schemaError("Evidence environment allowlist contains a duplicate name.", { name });
    seen.add(identity);
    const actualName = process.platform === "win32"
      ? Object.keys(process.env).find((candidate) => candidate.toUpperCase() === identity) ?? name
      : name;
    const value = process.env[actualName];
    values[identity] = value ?? null;
    if (value !== undefined) environment[actualName] = value;
  }
  return { env: environment, digest: sha256Hex(canonicalJsonBytes(values)) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function processGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (processGroupAlive(processGroupId) && Date.now() < deadline) await delay(20);
  if (processGroupAlive(processGroupId)) {
    throw new LoopError("RECONCILE_REQUIRED", "A timed-out POSIX process group survived forced termination.", { process_group_id: processGroupId });
  }
}

function windowsTaskkillExecutable(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return join(root, "System32", "taskkill.exe");
}

function trustedOsEnvironment(executable: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "ComSpec", "PATHEXT"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.PATH = dirname(executable);
  return environment;
}

async function taskkill(pid: number): Promise<void> {
  try {
    const executable = windowsTaskkillExecutable();
    await capture(executable, ["/PID", String(pid), "/T", "/F"], {
      env: trustedOsEnvironment(executable),
    });
  } catch {
    // Windows cleanup is best-effort; the evidence records the attempted path.
  }
}

function destroyChildPipes(child: ChildProcess): void {
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try {
      stream?.destroy();
    } catch {
      // Best-effort unblocking of a saturated pipe before forced termination.
    }
  }
}

async function terminateTree(child: ChildProcess): Promise<string> {
  const pid = child.pid;
  if (pid === undefined) return "PROCESS_NOT_STARTED";
  destroyChildPipes(child);
  if (process.platform === "win32") {
    await taskkill(pid);
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already be exiting after taskkill.
    }
    return "WINDOWS_TASKKILL_BEST_EFFORT";
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await delay(250);
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process group kill may already have reaped the direct child.
  }
  await waitForProcessGroupExit(pid);
  return "POSIX_PROCESS_GROUP_SIGTERM_SIGKILL";
}

interface EvidenceExecution {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  terminationPath: string;
}

function executeBoundedProcess(options: {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}): Promise<EvidenceExecution> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let terminationPath = "NATURAL_EXIT";
    let termination: Promise<void> = Promise.resolve();
    let overflow: "stdout" | "stderr" | undefined;
    let spawnError: Error | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      action();
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      void termination.then(
        () => {
          settle(() => {
            if (overflow !== undefined) {
              rejectPromise(schemaError(`Evidence ${overflow} exceeded its explicit byte limit.`, { stream: overflow }));
              return;
            }
            resolvePromise({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              exitCode,
              signal,
              timedOut,
              terminationPath: spawnError === undefined ? terminationPath : "SPAWN_ERROR",
            });
          });
        },
        (error) => settle(() => rejectPromise(error)),
      );
    };
    const terminateOnce = (): void => {
      if (terminationPath !== "NATURAL_EXIT") return;
      terminationPath = overflow === undefined ? "TIMEOUT_TERMINATION_PENDING" : `${overflow.toUpperCase()}_LIMIT_TERMINATION_PENDING`;
      termination = terminateTree(child).then((path) => { terminationPath = path; });
    };
    const onChunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (overflow !== undefined) return;
      const next = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
      const limit = stream === "stdout" ? options.maxStdoutBytes : options.maxStderrBytes;
      if (next > limit) {
        overflow = stream;
        terminateOnce();
        return;
      }
      if (stream === "stdout") {
        stdoutBytes = next;
        stdout.push(chunk);
      } else {
        stderrBytes = next;
        stderr.push(chunk);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));
    child.on("error", (error) => {
      spawnError = error;
      const bytes = Buffer.from(error.message);
      if (bytes.byteLength <= options.maxStderrBytes) stderr.push(bytes);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateOnce();
    }, options.timeoutMs);
    const forceTimer = setTimeout(() => {
      terminateOnce();
      finish(null, null);
    }, options.timeoutMs + 5_000);
    child.on("close", (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
}

function sha256File(path: string): Promise<Digest> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => { hash.update(chunk); });
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex") as Digest));
  });
}

async function resolvedExecutable(path: string, cwd: string): Promise<{ path: string; digest: Digest }> {
  if (!isAbsolute(path)) throw schemaError("Evidence executables must be absolute paths.", { path });
  const canonical = await realpath(resolve(cwd, path));
  if (!(await stat(canonical)).isFile()) throw schemaError("Evidence executable identity must resolve to a file.", { path: canonical });
  return { path: canonical, digest: await sha256File(canonical) };
}

async function captureExecutableVersion(
  executablePath: string,
  versionArgs: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const result = await executeBoundedProcess({
    executable: executablePath,
    args: versionArgs,
    cwd,
    environment,
    timeoutMs: Math.min(timeoutMs, 5_000),
    maxStdoutBytes: VERSION_CAPTURE_LIMIT_BYTES,
    maxStderrBytes: VERSION_CAPTURE_LIMIT_BYTES,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw schemaError("Evidence executable version probe failed.", {
      exit_code: result.exitCode,
      exit_signal: result.signal,
      timed_out: result.timedOut,
    });
  }
  const version = (result.stdout.byteLength > 0 ? result.stdout : result.stderr).toString("utf8").trim();
  if (version === "") throw schemaError("Evidence executable version probe returned no version metadata.");
  return version;
}

function validateEvidenceRequest(request: EvidenceCommandRequest): void {
  if (
    request.workItemId === ""
    || request.actorRole === ""
    || request.executable === ""
    || !Number.isSafeInteger(request.attempt)
    || request.attempt < 1
    || !Number.isSafeInteger(request.timeoutMs)
    || request.timeoutMs < 1
    || !Number.isSafeInteger(request.maxStdoutBytes)
    || request.maxStdoutBytes < 0
    || request.maxStdoutBytes > EVIDENCE_CAPTURE_HARD_LIMIT_BYTES
    || !Number.isSafeInteger(request.maxStderrBytes)
    || request.maxStderrBytes < 0
    || request.maxStderrBytes > EVIDENCE_CAPTURE_HARD_LIMIT_BYTES
    || request.versionArgs.length === 0
    || !DIGEST_PATTERN.test(request.h1Digest)
    || !DIGEST_PATTERN.test(request.waveInputDigest)
    || !DIGEST_PATTERN.test(request.outputTreeDigest)
  ) throw schemaError("Evidence command input is invalid.");
}

export async function runEvidenceCommand(request: EvidenceCommandRequest): Promise<EvidenceRecord> {
  validateEvidenceRequest(request);
  const cwd = await realpath(resolve(request.cwd));
  const evidenceDirectory = await assertContained(
    cwd,
    isAbsolute(request.evidenceDirectory) ? request.evidenceDirectory : resolve(cwd, request.evidenceDirectory),
  );
  const environment = evidenceEnvironment(request.envAllowlist);
  const executable = await resolvedExecutable(request.executable, cwd);
  const executableVersion = await captureExecutableVersion(
    executable.path,
    request.versionArgs,
    cwd,
    environment.env,
    request.timeoutMs,
  );
  const startedAt = new Date().toISOString();
  const execution = await executeBoundedProcess({
    executable: executable.path,
    args: request.args,
    cwd,
    environment: environment.env,
    timeoutMs: request.timeoutMs,
    maxStdoutBytes: request.maxStdoutBytes,
    maxStderrBytes: request.maxStderrBytes,
  });
  const endedAt = new Date().toISOString();
  const evidenceId = `evidence-${sha256Hex(canonicalJsonBytes({
    actor_role: request.actorRole,
    attempt: request.attempt,
    ended_at: endedAt,
    loop_id: request.loopId,
    nonce: randomBytes(16).toString("hex"),
    work_item_id: request.workItemId,
  })).slice(0, 32)}`;
  const stdoutPath = resolve(evidenceDirectory, `${evidenceId}.stdout.bin`);
  const stderrPath = resolve(evidenceDirectory, `${evidenceId}.stderr.bin`);
  await Promise.all([
    atomicWriteFile(stdoutPath, execution.stdout),
    atomicWriteFile(stderrPath, execution.stderr),
  ]);
  const stdoutDigest = sha256Hex(execution.stdout);
  const stderrDigest = sha256Hex(execution.stderr);
  const streamEntries: readonly ManifestEntry[] = [
    {
      path: normalizeRelativePath(relative(cwd, stdoutPath)),
      mode: "evidence-stream",
      digest: stdoutDigest,
      kind: "file",
      provenance: "verbatim stdout",
    },
    {
      path: normalizeRelativePath(relative(cwd, stderrPath)),
      mode: "evidence-stream",
      digest: stderrDigest,
      kind: "file",
      provenance: "verbatim stderr",
    },
  ];
  const artifactManifest = contentManifest("artifact", [
    ...await artifactEntries(cwd, request.declaredArtifacts),
    ...streamEntries,
  ]);
  const toolVersions = { [executable.path]: executableVersion };
  const record = {
    schema_version: 1 as const,
    evidence_id: evidenceId,
    loop_id: request.loopId,
    work_item_id: request.workItemId,
    attempt: request.attempt,
    actor_role: request.actorRole,
    h1_digest: request.h1Digest,
    wave_input_digest: request.waveInputDigest,
    output_tree_digest: request.outputTreeDigest,
    argv: [executable.path, ...request.args],
    executable_path: executable.path,
    executable_digest: executable.digest,
    version_argv: [executable.path, ...request.versionArgs],
    cwd,
    timeout_ms: request.timeoutMs,
    stdout_limit_bytes: request.maxStdoutBytes,
    stderr_limit_bytes: request.maxStderrBytes,
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: execution.timedOut ? null : execution.exitCode,
    exit_signal: execution.signal,
    termination_path: execution.terminationPath,
    environment_digest: environment.digest,
    tool_versions: toolVersions,
    stdout_path: stdoutPath,
    stdout_digest: stdoutDigest,
    stderr_path: stderrPath,
    stderr_digest: stderrDigest,
    artifact_manifest_digest: artifactManifest.digest,
    result: !execution.timedOut && execution.exitCode === 0 ? "PASS" as const : "FAIL" as const,
  };
  return validateSchema<EvidenceRecord>("evidence", record);
}

export function verifyEvidenceBinding(record: EvidenceRecord, expected: EvidenceBinding): void {
  validateSchema<EvidenceRecord>("evidence", record);
  const mismatches: string[] = [];
  if (record.loop_id !== expected.loopId) mismatches.push("loop_id");
  if (record.work_item_id !== expected.workItemId) mismatches.push("work_item_id");
  if (record.attempt !== expected.attempt) mismatches.push("attempt");
  if (record.actor_role !== expected.actorRole) mismatches.push("actor_role");
  if (record.h1_digest !== expected.h1Digest) mismatches.push("h1_digest");
  if (record.wave_input_digest !== expected.waveInputDigest) mismatches.push("wave_input_digest");
  if (record.output_tree_digest !== expected.outputTreeDigest) mismatches.push("output_tree_digest");
  if (JSON.stringify(record.argv) !== JSON.stringify(expected.argv)) mismatches.push("argv");
  if (record.executable_path !== expected.executablePath) mismatches.push("executable_path");
  if (record.executable_digest !== expected.executableDigest) mismatches.push("executable_digest");
  if (JSON.stringify(record.version_argv) !== JSON.stringify(expected.versionArgv)) mismatches.push("version_argv");
  if (record.cwd !== expected.cwd) mismatches.push("cwd");
  if (record.timeout_ms !== expected.timeoutMs) mismatches.push("timeout_ms");
  if (record.stdout_limit_bytes !== expected.maxStdoutBytes) mismatches.push("stdout_limit_bytes");
  if (record.stderr_limit_bytes !== expected.maxStderrBytes) mismatches.push("stderr_limit_bytes");
  if (record.environment_digest !== expected.environmentDigest) mismatches.push("environment_digest");
  if (Buffer.compare(canonicalJsonBytes(record.tool_versions), canonicalJsonBytes(expected.toolVersions)) !== 0) mismatches.push("tool_versions");
  if (record.artifact_manifest_digest !== expected.artifactManifestDigest) mismatches.push("artifact_manifest_digest");
  if (mismatches.length > 0) {
    throw schemaError("Evidence input binding does not match the expected execution.", { fields: mismatches });
  }
}
