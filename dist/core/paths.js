import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LoopError } from "../contracts/domain.js";
const LOOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const GIT_REPOSITORY_ENVIRONMENT_KEYS = new Set([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_GRAFT_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_SHALLOW_FILE",
    "GIT_SUPER_PREFIX",
    "GIT_INTERNAL_SUPER_PREFIX",
]);
export function parseLoopId(value) {
    if (!LOOP_ID_PATTERN.test(value)) {
        throw new LoopError("INVALID_LOOP_ID", "Loop ID must be 1-96 ASCII letters, numbers, dots, underscores, or hyphens and start with a letter or number.", { value });
    }
    return value;
}
export function resolveLayout(workspace, loopId) {
    const workspaceRoot = resolve(workspace);
    const stateRoot = join(workspaceRoot, ".ai-loop");
    const workspaceLayout = {
        workspaceRoot,
        stateRoot,
        projectPolicyJson: join(stateRoot, "project-policy.json"),
        preferencesJson: join(stateRoot, "preferences.json"),
        loopsRoot: join(stateRoot, "loop"),
        releasesRoot: join(stateRoot, "releases"),
        knowledgeProposalsRoot: join(stateRoot, "knowledge", "proposals"),
        localCoordinationRoot: join(stateRoot, "coordination"),
    };
    if (loopId === undefined)
        return workspaceLayout;
    const loopRoot = join(workspaceLayout.loopsRoot, loopId);
    return {
        ...workspaceLayout,
        loopId,
        loopRoot,
        loopJson: join(loopRoot, "LOOP.json"),
        eventsJsonl: join(loopRoot, "events.jsonl"),
        loopMarkdown: join(loopRoot, "LOOP.md"),
        harnessRoot: join(loopRoot, "harness"),
        evidenceRoot: join(loopRoot, "evidence"),
        checkpointsRoot: join(loopRoot, "checkpoints"),
        handoffJson: join(loopRoot, "handoff.json"),
    };
}
function comparablePath(path) {
    return process.platform === "win32" ? path.toLowerCase() : path;
}
async function resolveThroughExistingParent(path) {
    let current = path;
    const missingSegments = [];
    for (;;) {
        try {
            const existing = await realpath(current);
            return resolve(existing, ...missingSegments.reverse());
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = dirname(current);
            if (parent === current)
                throw error;
            missingSegments.push(basename(current));
            current = parent;
        }
    }
}
export async function assertContained(root, candidate) {
    const canonicalRoot = await realpath(resolve(root));
    const absoluteCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(canonicalRoot, candidate);
    const canonicalCandidate = await resolveThroughExistingParent(absoluteCandidate);
    const containment = relative(comparablePath(canonicalRoot), comparablePath(canonicalCandidate));
    if (containment === ".." || containment.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(containment)) {
        throw new Error(`Candidate path is outside the canonical root: ${candidate}`);
    }
    return canonicalCandidate;
}
function gitProbeEnvironment() {
    const env = {};
    const pollutedKeys = [];
    for (const [key, value] of Object.entries(process.env)) {
        const normalizedKey = key.toUpperCase();
        if (GIT_REPOSITORY_ENVIRONMENT_KEYS.has(normalizedKey)) {
            if (value !== undefined && value !== "")
                pollutedKeys.push(normalizedKey);
            continue;
        }
        if (normalizedKey !== "LANG" && normalizedKey !== "LC_ALL")
            env[key] = value;
    }
    env.LANG = "C";
    env.LC_ALL = "C";
    return { env, pollutedKeys: [...new Set(pollutedKeys)].sort() };
}
function gitCommonDirectory(workspace, environment) {
    return new Promise((resolvePromise) => {
        let settled = false;
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            resolvePromise(result);
        };
        const child = spawn("git", ["-C", workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
        child.on("error", (error) => settle({
            kind: "FAILED",
            details: { cause: error.message, error_code: error.code ?? "UNKNOWN" },
        }));
        child.on("close", (code) => {
            const stderr = Buffer.concat(stderrChunks).toString("utf8").replace(/[\r\n]+$/u, "");
            if (code !== 0) {
                if (/\bnot a git repository\b/iu.test(stderr)) {
                    settle({ kind: "NOT_REPOSITORY" });
                }
                else {
                    settle({ kind: "FAILED", details: { exit_code: code, stderr } });
                }
                return;
            }
            const output = Buffer.concat(stdoutChunks).toString("utf8").replace(/[\r\n]+$/u, "");
            settle(output === ""
                ? { kind: "FAILED", details: { exit_code: code, stderr, cause: "Git returned an empty common directory." } }
                : { kind: "FOUND", path: output });
        });
    });
}
async function hasGitMarker(workspace) {
    let current = workspace;
    for (;;) {
        try {
            await lstat(join(current, ".git"));
            return true;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const parent = dirname(current);
        if (parent === current)
            return false;
        current = parent;
    }
}
function gitResolutionError(workspace, details) {
    return new LoopError("RECONCILE_REQUIRED", "Git repository identity could not be resolved safely.", {
        workspace,
        ...details,
    });
}
export async function resolveCoordinationRoot(workspace) {
    const environment = gitProbeEnvironment();
    if (environment.pollutedKeys.length > 0) {
        throw gitResolutionError(resolve(workspace), {
            cause: "Ambient Git repository selection is not allowed for coordination discovery.",
            environment_keys: environment.pollutedKeys,
        });
    }
    const canonicalWorkspace = await realpath(resolve(workspace));
    const probe = await gitCommonDirectory(canonicalWorkspace, environment.env);
    if (probe.kind === "FAILED")
        throw gitResolutionError(canonicalWorkspace, probe.details);
    if (probe.kind === "NOT_REPOSITORY") {
        try {
            if (!await hasGitMarker(canonicalWorkspace)) {
                return join(canonicalWorkspace, ".ai-loop", "coordination");
            }
        }
        catch (error) {
            throw gitResolutionError(canonicalWorkspace, {
                cause: error instanceof Error ? error.message : String(error),
            });
        }
        throw gitResolutionError(canonicalWorkspace, { cause: "A Git marker exists but Git rejected the repository." });
    }
    try {
        const canonicalCommonDirectory = await realpath(resolve(canonicalWorkspace, probe.path));
        return join(canonicalCommonDirectory, "pi-loop-engineering", "coordination");
    }
    catch (error) {
        throw gitResolutionError(canonicalWorkspace, {
            common_directory: probe.path,
            cause: error instanceof Error ? error.message : String(error),
        });
    }
}
//# sourceMappingURL=paths.js.map