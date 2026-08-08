import { spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
class UsageError extends Error {
    details;
    constructor(message, details = {}) {
        super(message);
        this.details = details;
        this.name = "UsageError";
    }
}
const USAGE_EXIT_CODE = 2;
const UNKNOWN_EXIT_CODE = 1;
const COMMAND_OPTIONS = {
    resolve: { required: ["workspace"], optional: ["mcp-available"] },
    health: { required: ["workspace"], optional: [] },
    "sync-existing": { required: ["workspace"], optional: [] },
};
function parseArguments(argv) {
    if (argv.length === 0)
        throw new UsageError("A subcommand is required.");
    const [command, ...rest] = argv;
    if (command === undefined || !Object.hasOwn(COMMAND_OPTIONS, command)) {
        throw new UsageError("Unknown subcommand.", { command });
    }
    const spec = COMMAND_OPTIONS[command];
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith("--")) {
            throw new UsageError("Positional arguments are not supported.", { token });
        }
        const key = token.slice(2);
        const allowed = new Set([...spec.required, ...spec.optional]);
        if (!allowed.has(key)) {
            throw new UsageError("Unknown option.", { command, option: key });
        }
        const value = rest[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new UsageError("Option requires a value.", { option: key });
        }
        options[key] = value;
        index += 1;
    }
    for (const key of spec.required) {
        if (options[key] === undefined) {
            throw new UsageError("Missing required option.", { command, option: key });
        }
    }
    return { command: command, options };
}
function requireOption(options, key) {
    const value = options[key];
    if (value === undefined)
        throw new UsageError("Missing required option.", { option: key });
    return value;
}
function parseBoolean(value, option) {
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    throw new UsageError("Option requires true or false.", { option, value });
}
async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function resolveWorkspace(workspace) {
    const absolute = resolve(workspace);
    try {
        return await realpath(absolute);
    }
    catch {
        return absolute;
    }
}
async function readRepositoryRules(workspace) {
    const candidates = ["AGENTS.md", "agents.md", "CLAUDE.md", ".cursorrules"];
    const chunks = [];
    for (const name of candidates) {
        const path = join(workspace, name);
        if (await pathExists(path)) {
            chunks.push(await readFile(path, "utf8"));
        }
    }
    return chunks.join("\n");
}
function codeGraphIsMandatory(rules) {
    return /codegraph\s+is\s+mandatory/iu.test(rules)
        || /codegraph\s+is\s+required/iu.test(rules)
        || /requires\s+codegraph/iu.test(rules)
        || /mandatory\s+codegraph/iu.test(rules)
        || /must\s+use\s+codegraph/iu.test(rules);
}
async function indexDirectoryPresent(workspace) {
    return pathExists(join(workspace, ".codegraph"));
}
async function inspectIndexHealth(workspace) {
    const present = await indexDirectoryPresent(workspace);
    if (!present) {
        return { present: false, healthy: false, reasons: ["index absent"] };
    }
    const markerPath = join(workspace, ".codegraph", "status.json");
    if (await pathExists(markerPath)) {
        try {
            const marker = JSON.parse(await readFile(markerPath, "utf8"));
            const reasons = [];
            if (marker.healthy === false)
                reasons.push("marker reports unhealthy");
            if (marker.initialized === false)
                reasons.push("marker reports uninitialized");
            const pending = marker.pendingChanges;
            if (pending !== undefined) {
                const total = (pending.added ?? 0) + (pending.modified ?? 0) + (pending.removed ?? 0);
                if (total > 0)
                    reasons.push("pending source changes");
            }
            if (marker.worktreeMismatch != null)
                reasons.push("worktree mismatch");
            if (marker.index?.reindexRecommended === true)
                reasons.push("full reindex required");
            if (marker.healthy === true && reasons.length === 0) {
                return { present: true, healthy: true, reasons: [] };
            }
            if (reasons.length > 0) {
                return { present: true, healthy: false, reasons };
            }
        }
        catch {
            // Fall through to CLI status when the marker is unusable.
        }
    }
    const status = await runCodegraph(workspace, ["status", "--json", workspace], 5_000);
    if (status.exitCode !== 0) {
        return { present: true, healthy: true, reasons: [] };
    }
    try {
        const payload = JSON.parse(status.stdout);
        const reasons = [];
        if (payload.initialized === false)
            reasons.push("not initialized");
        const pending = payload.pendingChanges;
        if (pending !== undefined) {
            const total = (pending.added ?? 0) + (pending.modified ?? 0) + (pending.removed ?? 0);
            if (total > 0)
                reasons.push("pending source changes");
        }
        if (payload.worktreeMismatch != null)
            reasons.push("worktree mismatch");
        if (payload.index?.reindexRecommended === true)
            reasons.push("full reindex required");
        return { present: true, healthy: reasons.length === 0, reasons };
    }
    catch {
        return { present: true, healthy: true, reasons: [] };
    }
}
function runCodegraph(workspace, args, timeoutMs) {
    return new Promise((resolvePromise) => {
        const child = spawn("codegraph", [...args], {
            cwd: workspace,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            // Windows PATHEXT resolution for .cmd shims requires a shell.
            shell: process.platform === "win32",
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill();
            resolvePromise({ exitCode: null, stdout, stderr: `${stderr}timed out` });
        }, timeoutMs);
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise({ exitCode: code, stdout, stderr });
        });
    });
}
async function cliExploreAvailable(workspace) {
    const result = await runCodegraph(workspace, ["explore", "--help"], 5_000);
    return result.exitCode === 0;
}
function nativeResolution(degraded, reason) {
    if (reason === undefined) {
        return { mode: "NATIVE_EXPLORE", degraded, initialization_attempted: false };
    }
    return { mode: "NATIVE_EXPLORE", degraded, initialization_attempted: false, reason };
}
function blockedResolution(reason) {
    return { mode: "BLOCKED", degraded: false, initialization_attempted: false, reason };
}
export async function resolveCodeGraph(request) {
    const workspace = await resolveWorkspace(request.workspace);
    const rules = await readRepositoryRules(workspace);
    const mandatory = codeGraphIsMandatory(rules);
    const health = await inspectIndexHealth(workspace);
    if (!health.present || !health.healthy) {
        if (mandatory) {
            return blockedResolution("CodeGraph is mandatory and no healthy index is available.");
        }
        if (!health.present) {
            return nativeResolution(false);
        }
        return nativeResolution(true, health.reasons.join("; ") || "index unhealthy");
    }
    if (request.mcpAvailable === true) {
        return { mode: "MCP", degraded: false, initialization_attempted: false };
    }
    if (await cliExploreAvailable(workspace)) {
        return { mode: "CLI", degraded: false, initialization_attempted: false };
    }
    if (mandatory) {
        return blockedResolution("CodeGraph is mandatory but neither MCP nor CLI explore is available.");
    }
    return nativeResolution(true, "healthy index present but MCP and CLI explore are unavailable");
}
export async function reportCodeGraphHealth(workspaceInput) {
    const workspace = await resolveWorkspace(workspaceInput);
    const health = await inspectIndexHealth(workspace);
    return {
        ok: health.present && health.healthy,
        evidence_class: "STRUCTURAL_HINT",
        can_close_findings: false,
        proves_behavior: false,
        index_present: health.present,
        healthy: health.healthy,
        reasons: health.reasons,
    };
}
export async function syncExistingCodeGraph(workspaceInput) {
    const workspace = await resolveWorkspace(workspaceInput);
    const rules = await readRepositoryRules(workspace);
    const mandatory = codeGraphIsMandatory(rules);
    const present = await indexDirectoryPresent(workspace);
    if (!present) {
        if (mandatory) {
            return blockedResolution("CodeGraph is mandatory and no existing index can be synchronized.");
        }
        return nativeResolution(false, "no existing index to synchronize");
    }
    const sync = await runCodegraph(workspace, ["sync", workspace], 30_000);
    if (sync.exitCode !== 0) {
        if (mandatory) {
            return blockedResolution("Existing CodeGraph synchronization failed under mandatory repository rules.");
        }
        return nativeResolution(true, sync.stderr.trim() || sync.stdout.trim() || "synchronization failed");
    }
    return resolveCodeGraph({ workspace, mcpAvailable: false });
}
async function run(parsed) {
    const { command, options } = parsed;
    switch (command) {
        case "resolve": {
            const workspace = requireOption(options, "workspace");
            const mcpAvailable = options["mcp-available"] === undefined
                ? undefined
                : parseBoolean(options["mcp-available"], "mcp-available");
            const request = { workspace };
            if (mcpAvailable !== undefined)
                request.mcpAvailable = mcpAvailable;
            return resolveCodeGraph(request);
        }
        case "health":
            return reportCodeGraphHealth(requireOption(options, "workspace"));
        case "sync-existing":
            return syncExistingCodeGraph(requireOption(options, "workspace"));
        default:
            throw new UsageError("Unknown subcommand.", { command });
    }
}
export async function main(argv) {
    try {
        const parsed = parseArguments(argv);
        const output = await run(parsed);
        process.stdout.write(`${JSON.stringify(output)}\n`);
        return 0;
    }
    catch (error) {
        if (error instanceof UsageError) {
            process.stderr.write(`${JSON.stringify({
                error: { code: "USAGE", message: error.message, details: error.details },
            })}\n`);
            return USAGE_EXIT_CODE;
        }
        process.stderr.write(`${JSON.stringify({
            error: {
                code: "UNEXPECTED",
                message: error instanceof Error ? error.message : String(error),
                details: {},
            },
        })}\n`);
        return UNKNOWN_EXIT_CODE;
    }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
//# sourceMappingURL=codegraphctl.js.map