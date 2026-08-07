import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, stat, } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { LoopError, sha256Hex, } from "../contracts/domain.js";
import { atomicWriteFile, canonicalJsonBytes } from "./atomic-json.js";
import { assertContained } from "./paths.js";
import { validateSchema } from "./schema.js";
export const CONTROL_EXCLUSIONS = [".git", ".ai-loop", ".codegraph"];
export const SOURCE_INCLUSIONS = [
    "src/**/*.ts",
    "schemas/**/*.json",
    "assets/loop-engineering/workflow-spec.json",
    "package.json",
    "package-lock.json",
];
export const RUNTIME_INCLUSIONS = ["dist/**/*.js", "dist/**/*.js.map"];
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const ENVIRONMENT_NAME_PATTERN = /^[^=\0]+$/u;
function schemaError(message, details = {}) {
    return new LoopError("SCHEMA_INVALID", message, details);
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function normalizeRelativePath(path) {
    const normalized = path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
    const segments = normalized.split("/");
    if (normalized === ""
        || normalized.includes("\0")
        || isAbsolute(normalized)
        || /^[A-Za-z]:\//u.test(normalized)
        || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw schemaError("Manifest paths must be normalized repository-relative paths.", { path });
    }
    return normalized;
}
function normalizeExclusions(exclusions) {
    const normalized = exclusions.map(normalizeRelativePath);
    for (const path of normalized) {
        if (/[*?\[]/u.test(path)) {
            throw schemaError("Manifest exclusions must name exact directory roots.", { path });
        }
    }
    return [...new Set(normalized)].sort(compareText);
}
function isExcluded(path, exclusions) {
    return exclusions.some((root) => path === root || path.startsWith(`${root}/`));
}
function escapeRegularExpression(character) {
    return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
function globExpression(pattern) {
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
                }
                else {
                    source += ".*";
                }
            }
            else {
                source += "[^/]*";
            }
        }
        else if (character === "?") {
            source += "[^/]";
        }
        else if (character !== undefined) {
            source += escapeRegularExpression(character);
        }
    }
    return new RegExp(`${source}$`, "u");
}
function inclusionMatcher(patterns) {
    if (patterns.length === 0)
        throw schemaError("A manifest requires at least one inclusion pattern.");
    const expressions = patterns.map((pattern) => globExpression(pattern));
    return (path) => expressions.some((expression) => expression.test(path));
}
function gitEnvironment() {
    const blocked = new Set([
        "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_GRAFT_FILE",
        "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_QUARANTINE_PATH",
        "GIT_SHALLOW_FILE", "GIT_SUPER_PREFIX", "GIT_INTERNAL_SUPER_PREFIX",
    ]);
    const environment = {};
    for (const [key, value] of Object.entries(process.env)) {
        const normalized = key.toUpperCase();
        if (!blocked.has(normalized) && normalized !== "LANG" && normalized !== "LC_ALL")
            environment[key] = value;
    }
    environment.LANG = "C";
    environment.LC_ALL = "C";
    environment.GIT_OPTIONAL_LOCKS = "0";
    return environment;
}
function capture(command, args, options = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", rejectPromise);
        child.on("close", (code, signal) => resolvePromise({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            code,
            signal,
        }));
    });
}
async function git(root, args) {
    const result = await capture("git", ["-C", root, ...args], { env: gitEnvironment() });
    if (result.code !== 0) {
        throw schemaError("Git could not build a reproducible manifest.", {
            argv: ["git", "-C", root, ...args],
            exit_code: result.code,
            signal: result.signal,
            stderr: result.stderr.toString("utf8").replace(/[\r\n]+$/u, ""),
        });
    }
    return result.stdout;
}
function nulRecords(bytes) {
    const records = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0)
            continue;
        if (index > start)
            records.push(bytes.subarray(start, index).toString("utf8"));
        start = index + 1;
    }
    if (start !== bytes.length)
        throw schemaError("Git returned a non-terminated path record.");
    return records;
}
function parseIndex(bytes) {
    const entries = new Map();
    for (const record of nulRecords(bytes)) {
        const separator = record.indexOf("\t");
        const header = separator < 0 ? "" : record.slice(0, separator);
        const path = normalizeRelativePath(separator < 0 ? "" : record.slice(separator + 1));
        const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/u.exec(header);
        if (match === null || match[1] === undefined || match[2] === undefined || match[3] !== "0") {
            throw new LoopError("RECONCILE_REQUIRED", "The Git index contains an unsupported or unmerged entry.", { path, header });
        }
        if (entries.has(path))
            throw new LoopError("RECONCILE_REQUIRED", "The Git index contains duplicate normalized paths.", { path });
        entries.set(path, { path, mode: match[1], objectId: match[2] });
    }
    return entries;
}
async function gitSnapshot(root) {
    const canonicalRoot = await realpath(resolve(root));
    const indexBytes = await git(canonicalRoot, ["ls-files", "-s", "-z"]);
    const untrackedBytes = await git(canonicalRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
    await git(canonicalRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    const untracked = nulRecords(untrackedBytes).map(normalizeRelativePath).sort(compareText);
    return { root: canonicalRoot, index: parseIndex(indexBytes), untracked };
}
async function assertSymlinkContained(root, path, target) {
    const candidate = isAbsolute(target)
        ? target
        : resolve(dirname(resolve(root, path)), target);
    try {
        await assertContained(root, candidate);
    }
    catch (error) {
        throw schemaError("Manifest symlink target is outside the repository containment boundary.", {
            path,
            target,
            cause: error instanceof Error ? error.message : String(error),
        });
    }
}
async function indexEntry(root, entry) {
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
async function currentSubmoduleEntry(root, entry) {
    const submoduleRoot = await assertContained(root, resolve(root, entry.path));
    const commit = (await git(submoduleRoot, ["rev-parse", "HEAD"])).toString("utf8").trim();
    if (!SHA_PATTERN.test(commit)) {
        throw new LoopError("RECONCILE_REQUIRED", "A submodule did not resolve to a commit.", { path: entry.path });
    }
    return { path: entry.path, mode: "160000", digest: sha256Hex(commit), kind: "submodule" };
}
async function filesystemEntry(root, path, tracked) {
    const absolutePath = resolve(root, path);
    await assertContained(root, absolutePath);
    let metadata;
    try {
        metadata = await lstat(absolutePath);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    if (tracked?.mode === "160000")
        return currentSubmoduleEntry(root, tracked);
    if (metadata.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        await assertSymlinkContained(root, path, target);
        return { path, mode: "120000", digest: sha256Hex(Buffer.from(target)), kind: "symlink" };
    }
    if (!metadata.isFile()) {
        throw schemaError("Manifest inputs must be files, symlinks, or Git submodules.", { path });
    }
    const mode = tracked?.mode ?? ((metadata.mode & 0o111) === 0 ? "100644" : "100755");
    return { path, mode, digest: sha256Hex(await readFile(absolutePath)), kind: "file" };
}
function externalEntry(binding) {
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
function secretEntry(binding) {
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
async function artifactEntries(root, bindings) {
    const entries = [];
    for (const binding of bindings) {
        if (binding.kind === "external") {
            entries.push(externalEntry(binding));
        }
        else if (binding.kind === "secret") {
            entries.push(secretEntry(binding));
        }
        else {
            const path = normalizeRelativePath(binding.path);
            const entry = await filesystemEntry(root, path);
            if (entry === undefined)
                throw schemaError("A declared file artifact does not exist.", { path });
            entries.push({ ...entry, provenance: binding.provenance });
        }
    }
    return entries;
}
function contentManifest(kind, entries) {
    const sortedEntries = [...entries].sort((left, right) => compareText(left.path, right.path));
    for (let index = 1; index < sortedEntries.length; index += 1) {
        if (sortedEntries[index - 1]?.path === sortedEntries[index]?.path) {
            throw schemaError("Manifest entries must have unique normalized paths.", { path: sortedEntries[index]?.path });
        }
    }
    const content = { schema_version: 1, kind, entries: sortedEntries };
    return validateSchema("manifest", { ...content, digest: sha256Hex(canonicalJsonBytes(content)) });
}
async function buildGitManifest(kind, options, sealedSnapshot) {
    const snapshot = sealedSnapshot ?? await gitSnapshot(options.root);
    const exclusions = normalizeExclusions([...CONTROL_EXCLUSIONS, ...options.exclusions]);
    const includes = inclusionMatcher(options.include);
    const entries = [];
    const paths = new Set();
    for (const path of snapshot.index.keys())
        paths.add(path);
    if (kind !== "tree")
        for (const path of snapshot.untracked)
            paths.add(path);
    for (const path of [...paths].sort(compareText)) {
        if (isExcluded(path, exclusions) || !includes(path))
            continue;
        const tracked = snapshot.index.get(path);
        const entry = kind === "tree"
            ? tracked === undefined ? undefined : await indexEntry(snapshot.root, tracked)
            : await filesystemEntry(snapshot.root, path, tracked);
        if (entry !== undefined)
            entries.push(entry);
    }
    if (kind === "workspace" && "declaredArtifacts" in options) {
        for (const entry of await artifactEntries(snapshot.root, options.declaredArtifacts)) {
            if (!isExcluded(entry.path, exclusions))
                entries.push(entry);
        }
    }
    return contentManifest(kind, entries);
}
export function buildSourceManifest(options) {
    return buildGitManifest("source", {
        ...options,
        include: [...SOURCE_INCLUSIONS, ...options.include],
    });
}
export function buildTreeManifest(options) {
    return buildGitManifest("tree", options);
}
export function buildWorkspaceManifest(options) {
    return buildGitManifest("workspace", options);
}
async function walkFiles(root, directory, output) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolutePath = resolve(directory, entry.name);
        const relativePath = normalizeRelativePath(relative(root, absolutePath));
        if (entry.isDirectory())
            await walkFiles(root, absolutePath, output);
        else
            output.push(relativePath);
    }
}
export async function buildRuntimeManifest(root) {
    const canonicalRoot = await realpath(resolve(root));
    const paths = [];
    try {
        await walkFiles(canonicalRoot, resolve(canonicalRoot, "dist"), paths);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const includes = inclusionMatcher(RUNTIME_INCLUSIONS);
    const entries = [];
    for (const path of paths.filter(includes).sort(compareText)) {
        const entry = await filesystemEntry(canonicalRoot, path);
        if (entry !== undefined)
            entries.push(entry);
    }
    return contentManifest("runtime", entries);
}
async function buildArtifactManifest(root, bindings) {
    return contentManifest("artifact", await artifactEntries(await realpath(resolve(root)), bindings));
}
export async function sealWaveInput(options) {
    if (options.waveId === "" || options.repositoryId === "" || !SHA_PATTERN.test(options.baseSha) || !DIGEST_PATTERN.test(options.h1PolicyDigest)) {
        throw schemaError("WaveInput identifiers and digests are invalid.");
    }
    const exclusions = options.exclusions ?? CONTROL_EXCLUSIONS;
    const declaredArtifacts = options.declaredArtifacts ?? [];
    const snapshot = await gitSnapshot(options.root);
    const [source, tree, workspace, artifacts] = await Promise.all([
        buildGitManifest("source", {
            root: options.root,
            include: [...SOURCE_INCLUSIONS, ...(options.sourceInclude ?? [])],
            exclusions,
            declaredArtifacts,
        }, snapshot),
        buildGitManifest("tree", { root: options.root, include: options.sourceInclude ?? SOURCE_INCLUSIONS, exclusions }, snapshot),
        buildGitManifest("workspace", { root: options.root, include: options.workspaceInclude ?? ["**/*"], exclusions, declaredArtifacts }, snapshot),
        buildArtifactManifest(snapshot.root, declaredArtifacts),
    ]);
    const content = {
        schema_version: 1,
        loop_id: options.loopId,
        wave_id: options.waveId,
        base_sha: options.baseSha,
        source_manifest_digest: source.digest,
        tree_manifest_digest: tree.digest,
        workspace_manifest_digest: workspace.digest,
        artifact_manifest_digest: artifacts.digest,
        h1_policy_digest: options.h1PolicyDigest,
    };
    const digest = sha256Hex(canonicalJsonBytes({ ...content, repository_id: options.repositoryId }));
    return validateSchema("wave-input", { ...content, digest });
}
function evidenceEnvironment(allowlist) {
    const environment = {};
    const values = {};
    const seen = new Set();
    for (const name of allowlist) {
        if (!ENVIRONMENT_NAME_PATTERN.test(name))
            throw schemaError("Evidence environment names are invalid.", { name });
        const identity = process.platform === "win32" ? name.toUpperCase() : name;
        if (seen.has(identity))
            throw schemaError("Evidence environment allowlist contains a duplicate name.", { name });
        seen.add(identity);
        const actualName = process.platform === "win32"
            ? Object.keys(process.env).find((candidate) => candidate.toUpperCase() === identity) ?? name
            : name;
        const value = process.env[actualName];
        values[identity] = value ?? null;
        if (value !== undefined)
            environment[actualName] = value;
    }
    return { env: environment, digest: sha256Hex(canonicalJsonBytes(values)) };
}
function delay(milliseconds) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
function processGroupAlive(processGroupId) {
    try {
        process.kill(-processGroupId, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
async function waitForProcessGroupExit(processGroupId) {
    const deadline = Date.now() + 3_000;
    while (processGroupAlive(processGroupId) && Date.now() < deadline)
        await delay(20);
    if (processGroupAlive(processGroupId)) {
        throw new LoopError("RECONCILE_REQUIRED", "A timed-out POSIX process group survived forced termination.", { process_group_id: processGroupId });
    }
}
async function taskkill(pid) {
    try {
        await capture("taskkill", ["/PID", String(pid), "/T", "/F"], { env: process.env });
    }
    catch {
        // Windows cleanup is best-effort; the evidence records the attempted path.
    }
}
async function terminateTree(child) {
    const pid = child.pid;
    if (pid === undefined)
        return "PROCESS_NOT_STARTED";
    if (process.platform === "win32") {
        await taskkill(pid);
        return "WINDOWS_TASKKILL_BEST_EFFORT";
    }
    try {
        process.kill(-pid, "SIGTERM");
    }
    catch (error) {
        if (error.code !== "ESRCH")
            throw error;
    }
    await delay(250);
    try {
        process.kill(-pid, "SIGKILL");
    }
    catch (error) {
        if (error.code !== "ESRCH")
            throw error;
    }
    await waitForProcessGroupExit(pid);
    return "POSIX_PROCESS_GROUP_SIGTERM_SIGKILL";
}
function executeEvidence(request, environment) {
    return new Promise((resolvePromise, rejectPromise) => {
        let timedOut = false;
        let terminationPath = "NATURAL_EXIT";
        let termination = Promise.resolve();
        let spawnError;
        const stdout = [];
        const stderr = [];
        const child = spawn(request.executable, request.args, {
            cwd: request.cwd,
            env: environment,
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", (error) => {
            spawnError = error;
            stderr.push(Buffer.from(error.message));
        });
        const timer = setTimeout(() => {
            timedOut = true;
            termination = terminateTree(child).then((path) => { terminationPath = path; });
        }, request.timeoutMs);
        child.on("close", (exitCode, signal) => {
            clearTimeout(timer);
            void termination.then(() => resolvePromise({
                stdout: Buffer.concat(stdout),
                stderr: Buffer.concat(stderr),
                exitCode,
                signal,
                timedOut,
                terminationPath: spawnError === undefined ? terminationPath : "SPAWN_ERROR",
            }), rejectPromise);
        });
    });
}
function validateEvidenceRequest(request) {
    if (request.workItemId === ""
        || request.actorRole === ""
        || request.executable === ""
        || !Number.isSafeInteger(request.attempt)
        || request.attempt < 1
        || !Number.isSafeInteger(request.timeoutMs)
        || request.timeoutMs < 1
        || !DIGEST_PATTERN.test(request.h1Digest)
        || !DIGEST_PATTERN.test(request.waveInputDigest)
        || !DIGEST_PATTERN.test(request.outputTreeDigest))
        throw schemaError("Evidence command input is invalid.");
}
export async function runEvidenceCommand(request) {
    validateEvidenceRequest(request);
    const cwd = await realpath(resolve(request.cwd));
    const evidenceDirectory = resolve(request.evidenceDirectory);
    const environment = evidenceEnvironment(request.envAllowlist);
    const startedAt = new Date().toISOString();
    const execution = await executeEvidence({ ...request, cwd }, environment.env);
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
    const emptyArtifactManifest = contentManifest("artifact", []);
    const toolVersions = {
        executable: basename(request.executable),
        node: process.version,
        termination_path: execution.terminationPath,
    };
    if (execution.signal !== null)
        toolVersions.exit_signal = execution.signal;
    const record = {
        schema_version: 1,
        evidence_id: evidenceId,
        loop_id: request.loopId,
        work_item_id: request.workItemId,
        attempt: request.attempt,
        actor_role: request.actorRole,
        h1_digest: request.h1Digest,
        wave_input_digest: request.waveInputDigest,
        output_tree_digest: request.outputTreeDigest,
        argv: [request.executable, ...request.args],
        cwd,
        started_at: startedAt,
        ended_at: endedAt,
        exit_code: execution.timedOut ? null : execution.exitCode,
        environment_digest: environment.digest,
        tool_versions: toolVersions,
        stdout_path: stdoutPath,
        stdout_digest: sha256Hex(execution.stdout),
        stderr_path: stderrPath,
        stderr_digest: sha256Hex(execution.stderr),
        artifact_manifest_digest: emptyArtifactManifest.digest,
        result: !execution.timedOut && execution.exitCode === 0 ? "PASS" : "FAIL",
    };
    return validateSchema("evidence", record);
}
export function verifyEvidenceBinding(record, expected) {
    validateSchema("evidence", record);
    const mismatches = [];
    if (record.loop_id !== expected.loopId)
        mismatches.push("loop_id");
    if (record.work_item_id !== expected.workItemId)
        mismatches.push("work_item_id");
    if (record.attempt !== expected.attempt)
        mismatches.push("attempt");
    if (record.actor_role !== expected.actorRole)
        mismatches.push("actor_role");
    if (record.h1_digest !== expected.h1Digest)
        mismatches.push("h1_digest");
    if (record.wave_input_digest !== expected.waveInputDigest)
        mismatches.push("wave_input_digest");
    if (record.output_tree_digest !== expected.outputTreeDigest)
        mismatches.push("output_tree_digest");
    if (mismatches.length > 0) {
        throw schemaError("Evidence input binding does not match the expected execution.", { fields: mismatches });
    }
}
//# sourceMappingURL=manifests.js.map