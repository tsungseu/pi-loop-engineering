import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
class SyncError extends Error {
    details;
    constructor(message, details = {}) {
        super(message);
        this.details = details;
        this.name = "SyncError";
    }
}
const USAGE_EXIT_CODE = 2;
const DRIFT_EXIT_CODE = 1;
const UNKNOWN_EXIT_CODE = 1;
const SKILL_NAMES = ["knowledge-evolution", "loop-engineering", "release", "status"];
const KNOWN_ROLES = new Set([
    "explorer",
    "worker",
    "reviewer",
    "safety-reviewer",
    "environment-reviewer",
    "release-engineer",
    "robot-brain-engineer",
    "biped-cerebellum-engineer",
    "robot-data-algorithm",
    "robot-data-collector",
]);
const WRITER_BINDINGS = [
    "h1",
    "work_item",
    "worktree",
    "wave_input",
    "lease",
    "attempt",
    "fencing_token",
];
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Strip `#` comments outside double-quoted strings (basic TOML line comments). */
function stripTomlLineComment(line) {
    let inString = false;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\" && inString) {
            escaped = true;
            continue;
        }
        if (character === '"') {
            inString = !inString;
            continue;
        }
        if (character === "#" && !inString) {
            return line.slice(0, index);
        }
    }
    return line;
}
function unescapeTomlString(raw) {
    let result = "";
    for (let index = 0; index < raw.length; index += 1) {
        const character = raw[index];
        if (character !== "\\") {
            result += character;
            continue;
        }
        const next = raw[index + 1];
        if (next === undefined)
            throw new SyncError("Invalid TOML string escape.");
        const escapes = {
            b: "\b",
            t: "\t",
            n: "\n",
            f: "\f",
            r: "\r",
            '"': '"',
            "\\": "\\",
        };
        if (next in escapes) {
            result += escapes[next];
            index += 1;
            continue;
        }
        throw new SyncError("Unsupported TOML string escape.", { escape: next });
    }
    return result;
}
function parseStringArray(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
        throw new SyncError("Array value must be a bracketed string list.");
    }
    const body = trimmed.slice(1, -1).trim();
    if (body === "")
        return [];
    const values = [];
    let index = 0;
    while (index < body.length) {
        while (index < body.length && /[\s,]/u.test(body[index]))
            index += 1;
        if (index >= body.length)
            break;
        if (body[index] !== '"') {
            throw new SyncError("Array values must be double-quoted strings.");
        }
        index += 1;
        let raw = "";
        while (index < body.length) {
            const character = body[index];
            if (character === "\\") {
                raw += character + (body[index + 1] ?? "");
                index += 2;
                continue;
            }
            if (character === '"') {
                values.push(unescapeTomlString(raw));
                index += 1;
                break;
            }
            raw += character;
            index += 1;
        }
    }
    return values;
}
function parseScalar(text) {
    const trimmed = text.trim();
    if (trimmed === "true")
        return true;
    if (trimmed === "false")
        return false;
    if (trimmed.startsWith("["))
        return parseStringArray(trimmed);
    if (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length >= 6) {
        return trimmed.slice(3, -3).replace(/^\n/u, "");
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return unescapeTomlString(trimmed.slice(1, -1));
    }
    throw new SyncError("Unsupported TOML scalar.", { value: trimmed });
}
/** Minimal deterministic TOML reader: flat strings/booleans/arrays and one-level tables. */
export function parseToml(text) {
    const root = {};
    let table = root;
    const seen = new Set();
    const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
    let index = 0;
    while (index < lines.length) {
        const rawLine = lines[index];
        index += 1;
        const line = stripTomlLineComment(rawLine).trim();
        if (line === "")
            continue;
        const tableMatch = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/u.exec(line);
        if (tableMatch) {
            const name = tableMatch[1];
            if (seen.has(name) || Object.hasOwn(root, name)) {
                throw new SyncError("Duplicate TOML key.", { key: name });
            }
            const nested = {};
            root[name] = nested;
            table = nested;
            seen.add(name);
            continue;
        }
        if (line.startsWith("[")) {
            throw new SyncError("Unsupported TOML table syntax.", { line });
        }
        const equals = line.indexOf("=");
        if (equals <= 0)
            throw new SyncError("Unsupported TOML syntax.", { line });
        const key = line.slice(0, equals).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
            throw new SyncError("Invalid TOML key.", { key });
        }
        const qualified = table === root ? key : `${Object.keys(root).find((candidate) => root[candidate] === table)}.${key}`;
        if (seen.has(qualified) || Object.hasOwn(table, key)) {
            throw new SyncError("Duplicate TOML key.", { key: qualified });
        }
        let valueText = line.slice(equals + 1).trim();
        if (valueText.startsWith('"""')) {
            let block = valueText;
            if (!(valueText.endsWith('"""') && valueText.length > 3)) {
                const chunks = [valueText.slice(3)];
                while (index < lines.length) {
                    const next = lines[index];
                    index += 1;
                    const end = next.indexOf('"""');
                    if (end >= 0) {
                        chunks.push(next.slice(0, end));
                        block = `"""${chunks.join("\n")}"""`;
                        break;
                    }
                    chunks.push(next);
                }
            }
            valueText = block;
        }
        else if (valueText.startsWith("[") && !valueText.includes("]")) {
            const chunks = [valueText];
            while (index < lines.length) {
                const next = stripTomlLineComment(lines[index]);
                index += 1;
                chunks.push(next.trimEnd());
                if (next.includes("]"))
                    break;
            }
            valueText = chunks.join(" ");
        }
        table[key] = parseScalar(valueText);
        seen.add(qualified);
    }
    return root;
}
function requireString(record, key) {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") {
        throw new SyncError("Missing string field.", { key });
    }
    return value;
}
function requireBoolean(record, key) {
    const value = record[key];
    if (typeof value !== "boolean") {
        throw new SyncError("Missing boolean field.", { key });
    }
    return value;
}
function requireStringArray(record, key) {
    const value = record[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new SyncError("Missing string array field.", { key });
    }
    return value;
}
function requireFalse(record, key) {
    const value = requireBoolean(record, key);
    if (value !== false) {
        throw new SyncError("Capability must be false.", { key, value });
    }
    return false;
}
export function parseAgentProfile(text) {
    const parsed = parseToml(text);
    const capabilitiesValue = parsed.capabilities;
    if (!isRecord(capabilitiesValue)) {
        throw new SyncError("Agent profile requires a capabilities table.");
    }
    const capabilities = capabilitiesValue;
    const sourceAccess = requireString(parsed, "source_access");
    if (sourceAccess !== "read-only" && sourceAccess !== "h1-write-set") {
        throw new SyncError("Invalid source_access.", { source_access: sourceAccess });
    }
    const bindings = requireStringArray(parsed, "required_bindings");
    for (const binding of bindings) {
        if (!WRITER_BINDINGS.includes(binding)) {
            throw new SyncError("Unknown required binding.", { binding });
        }
    }
    const profile = {
        name: requireString(parsed, "name"),
        role: requireString(parsed, "role"),
        description: requireString(parsed, "description"),
        source_access: sourceAccess,
        capabilities: {
            external_write: requireBoolean(capabilities, "external_write"),
            network: requireBoolean(capabilities, "network"),
            recursive_dispatch: requireFalse(capabilities, "recursive_dispatch"),
            ledger_write: requireFalse(capabilities, "ledger_write"),
            release: requireBoolean(capabilities, "release"),
            physical_action: requireFalse(capabilities, "physical_action"),
        },
        required_bindings: bindings,
        evidence_requirements: requireStringArray(parsed, "evidence_requirements"),
        stop_conditions: requireStringArray(parsed, "stop_conditions"),
    };
    return profile;
}
function isWriter(profile) {
    return profile.source_access === "h1-write-set";
}
export function validateActorContract(profile) {
    if (!profile.name.startsWith("pi-loop-")) {
        throw new SyncError("Agent name must use the pi-loop namespace.", { name: profile.name });
    }
    if (!KNOWN_ROLES.has(profile.role)) {
        throw new SyncError("Unknown actor class.", { role: profile.role });
    }
    if (profile.capabilities.recursive_dispatch !== false) {
        throw new SyncError("recursive_dispatch must be false.");
    }
    if (profile.capabilities.ledger_write !== false) {
        throw new SyncError("ledger_write must be false.");
    }
    if (profile.capabilities.physical_action !== false) {
        throw new SyncError("physical_action must be false for every Sub-agent.");
    }
    if (profile.role.includes("reviewer")) {
        if (profile.source_access !== "read-only") {
            throw new SyncError("Reviewer actors must be read-only.", { role: profile.role });
        }
        if (profile.capabilities.external_write) {
            throw new SyncError("Reviewer actors cannot hold external_write capability.", { role: profile.role });
        }
        if (profile.capabilities.network) {
            throw new SyncError("Reviewer actors cannot hold network capability.", { role: profile.role });
        }
        if (profile.capabilities.release) {
            throw new SyncError("Reviewer actors cannot hold release capability.", { role: profile.role });
        }
    }
    if (profile.role === "release-engineer") {
        if (profile.source_access !== "read-only") {
            throw new SyncError("Release engineer source access must be read-only.");
        }
        if (!profile.capabilities.release) {
            throw new SyncError("Release engineer must declare release = true.");
        }
    }
    else if (profile.capabilities.release) {
        throw new SyncError("Only the release engineer may declare release = true.", { role: profile.role });
    }
    if (isWriter(profile)) {
        for (const binding of WRITER_BINDINGS) {
            if (!profile.required_bindings.includes(binding)) {
                throw new SyncError("Writer actors require complete H1 bindings.", { missing: binding });
            }
        }
    }
}
export async function loadProfiles(agentRoot) {
    const entries = await readdir(agentRoot, { withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
        .map((entry) => entry.name)
        .sort();
    if (files.length === 0) {
        throw new SyncError("No Agent profiles found.", { agentRoot });
    }
    const profiles = [];
    const names = new Set();
    for (const file of files) {
        if (!file.startsWith("pi-loop-")) {
            throw new SyncError("Agent profiles must use the pi-loop namespace.", { file });
        }
        const text = await readFile(join(agentRoot, file), "utf8");
        const profile = parseAgentProfile(text);
        validateActorContract(profile);
        if (names.has(profile.name)) {
            throw new SyncError("Duplicate Agent name.", { name: profile.name });
        }
        if (profile.name !== file.slice(0, -".toml".length)) {
            throw new SyncError("Agent name must equal filename stem.", { file, name: profile.name });
        }
        names.add(profile.name);
        profiles.push(profile);
    }
    return profiles;
}
function extractYamlPreamble(existing) {
    const normalized = existing.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    const withoutAgents = normalized.replace(/\nagents:\n(?:  - .+\n)*/u, "\n").replace(/\s+$/u, "");
    const lines = withoutAgents.split("\n");
    const kept = [];
    for (const line of lines) {
        if (/^\s*agents:\s*$/u.test(line))
            break;
        kept.push(line);
    }
    while (kept.length > 0 && kept[kept.length - 1].trim() === "")
        kept.pop();
    if (!kept.some((line) => line.startsWith("interface:"))) {
        throw new SyncError("openai.yaml is missing an interface section.");
    }
    if (!kept.some((line) => line.startsWith("policy:"))) {
        throw new SyncError("openai.yaml is missing a policy section.");
    }
    return `${kept.join("\n")}\n`;
}
function renderOpenaiYaml(existing, agentNames) {
    const preamble = extractYamlPreamble(existing);
    const agents = agentNames.map((name) => `  - ${name}`).join("\n");
    return `${preamble}agents:\n${agents}\n`;
}
async function writeUtf8Lf(path, content) {
    await writeFile(path, content, "utf8");
}
const HOST_MARKDOWN_DIRS = ["claude", "cursor"];
const CONTRACT_CAPABILITY_KEYS = [
    "external_write",
    "network",
    "recursive_dispatch",
    "ledger_write",
    "release",
    "physical_action",
];
export function contractFromProfile(profile) {
    return {
        name: profile.name,
        role: profile.role,
        source_access: profile.source_access,
        required_bindings: [...profile.required_bindings],
        evidence_requirements: [...profile.evidence_requirements],
        stop_conditions: [...profile.stop_conditions],
        capabilities: { ...profile.capabilities },
    };
}
function parseYamlStringArray(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
        throw new SyncError("Frontmatter array must be a JSON string list.", { value: trimmed });
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
            throw new SyncError("Frontmatter array must contain only strings.", { value: trimmed });
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof SyncError)
            throw error;
        throw new SyncError("Invalid frontmatter array JSON.", {
            value: trimmed,
            cause: error instanceof Error ? error.message : String(error),
        });
    }
}
function parseYamlBoolean(text, key) {
    const trimmed = text.trim();
    if (trimmed === "true")
        return true;
    if (trimmed === "false")
        return false;
    throw new SyncError("Frontmatter boolean must be true or false.", { key, value: trimmed });
}
function parseYamlScalarString(text) {
    const trimmed = text.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
        || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
export function parseMarkdownContract(text) {
    const normalized = text.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    if (!normalized.startsWith("---\n")) {
        throw new SyncError("Markdown agent profile is missing YAML frontmatter.");
    }
    const end = normalized.indexOf("\n---\n", 4);
    if (end < 0) {
        throw new SyncError("Markdown agent profile frontmatter is not closed.");
    }
    const body = normalized.slice(4, end);
    const lines = body.split("\n");
    const values = {};
    const capabilities = {};
    let inCapabilities = false;
    for (const rawLine of lines) {
        if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#"))
            continue;
        if (/^capabilities:\s*$/u.test(rawLine)) {
            inCapabilities = true;
            continue;
        }
        if (inCapabilities) {
            const indented = /^( {2}|\t)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/u.exec(rawLine);
            if (indented) {
                const key = indented[2];
                if (!CONTRACT_CAPABILITY_KEYS.includes(key)) {
                    throw new SyncError("Unknown capability in frontmatter.", { key });
                }
                capabilities[key] = parseYamlBoolean(indented[3], key);
                continue;
            }
            if (/^\S/u.test(rawLine)) {
                inCapabilities = false;
            }
            else {
                throw new SyncError("Invalid capabilities frontmatter line.", { line: rawLine });
            }
        }
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/u.exec(rawLine);
        if (!match) {
            throw new SyncError("Unsupported frontmatter syntax.", { line: rawLine });
        }
        const key = match[1];
        const value = match[2];
        if (key === "capabilities") {
            throw new SyncError("capabilities must be a nested mapping.");
        }
        if (Object.hasOwn(values, key)) {
            throw new SyncError("Duplicate frontmatter key.", { key });
        }
        values[key] = value;
    }
    const requireField = (key) => {
        const value = values[key];
        if (value === undefined || value.trim() === "") {
            throw new SyncError("Missing frontmatter field.", { key });
        }
        return value;
    };
    for (const key of CONTRACT_CAPABILITY_KEYS) {
        if (capabilities[key] === undefined) {
            throw new SyncError("Missing capability in frontmatter.", { key });
        }
    }
    return {
        name: parseYamlScalarString(requireField("name")),
        role: parseYamlScalarString(requireField("role")),
        source_access: parseYamlScalarString(requireField("source_access")),
        required_bindings: parseYamlStringArray(requireField("required_bindings")),
        evidence_requirements: parseYamlStringArray(requireField("evidence_requirements")),
        stop_conditions: parseYamlStringArray(requireField("stop_conditions")),
        capabilities: {
            external_write: capabilities.external_write,
            network: capabilities.network,
            recursive_dispatch: capabilities.recursive_dispatch,
            ledger_write: capabilities.ledger_write,
            release: capabilities.release,
            physical_action: capabilities.physical_action,
        },
    };
}
function stableStringify(value, indent) {
    const pad = "  ".repeat(indent);
    const childPad = "  ".repeat(indent + 1);
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0)
            return "[]";
        const items = value.map((entry) => `${childPad}${stableStringify(entry, indent + 1)}`);
        return `[\n${items.join(",\n")}\n${pad}]`;
    }
    if (typeof value === "object") {
        const record = value;
        const keys = Object.keys(record);
        if (keys.length === 0)
            return "{}";
        const items = keys.map((key) => `${childPad}${JSON.stringify(key)}: ${stableStringify(record[key], indent + 1)}`);
        return `{\n${items.join(",\n")}\n${pad}}`;
    }
    throw new SyncError("Unsupported contract JSON value.", { type: typeof value });
}
export function renderCodexSnapshot(contract) {
    return `${stableStringify(contract, 0)}\n`;
}
export function assertContractsEqual(expected, actual, path) {
    const compare = (field, left, right) => {
        if (JSON.stringify(left) !== JSON.stringify(right)) {
            throw new SyncError("Host agent contract drifted from TOML profile.", {
                path,
                field,
                expected: left,
                actual: right,
            });
        }
    };
    compare("name", expected.name, actual.name);
    compare("role", expected.role, actual.role);
    compare("source_access", expected.source_access, actual.source_access);
    compare("required_bindings", expected.required_bindings, actual.required_bindings);
    compare("evidence_requirements", expected.evidence_requirements, actual.evidence_requirements);
    compare("stop_conditions", expected.stop_conditions, actual.stop_conditions);
    compare("capabilities", expected.capabilities, actual.capabilities);
}
async function listHostAgentNames(dir, extension) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        throw new SyncError("Missing host agent directory.", {
            path: dir,
            cause: error instanceof Error ? error.message : String(error),
        });
    }
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
        .map((entry) => entry.name.slice(0, -extension.length))
        .sort();
}
function assertExactNames(expected, actual, path) {
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
        throw new SyncError("Host agent set must match TOML profiles exactly.", {
            path,
            expected,
            actual,
        });
    }
}
function requireJsonString(record, key, path) {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") {
        throw new SyncError("Codex contract snapshot missing string field.", { path, key });
    }
    return value;
}
function requireJsonStringArray(record, key, path) {
    const value = record[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new SyncError("Codex contract snapshot missing string array field.", { path, key });
    }
    return value;
}
function requireJsonBoolean(record, key, path) {
    const value = record[key];
    if (typeof value !== "boolean") {
        throw new SyncError("Codex contract snapshot missing boolean field.", { path, key });
    }
    return value;
}
function contractFromCodexJson(value, path) {
    if (!isRecord(value)) {
        throw new SyncError("Codex contract snapshot must be an object.", { path });
    }
    if (!isRecord(value.capabilities)) {
        throw new SyncError("Codex contract snapshot requires capabilities.", { path });
    }
    return {
        name: requireJsonString(value, "name", path),
        role: requireJsonString(value, "role", path),
        source_access: requireJsonString(value, "source_access", path),
        required_bindings: requireJsonStringArray(value, "required_bindings", path),
        evidence_requirements: requireJsonStringArray(value, "evidence_requirements", path),
        stop_conditions: requireJsonStringArray(value, "stop_conditions", path),
        capabilities: {
            external_write: requireJsonBoolean(value.capabilities, "external_write", path),
            network: requireJsonBoolean(value.capabilities, "network", path),
            recursive_dispatch: requireJsonBoolean(value.capabilities, "recursive_dispatch", path),
            ledger_write: requireJsonBoolean(value.capabilities, "ledger_write", path),
            release: requireJsonBoolean(value.capabilities, "release", path),
            physical_action: requireJsonBoolean(value.capabilities, "physical_action", path),
        },
    };
}
export async function synchronizeAgents(options) {
    const root = resolve(options.root);
    const agentRoot = join(root, "assets", "agents");
    const profiles = await loadProfiles(agentRoot);
    const names = profiles.map((profile) => profile.name).sort();
    const changedFiles = [];
    const hash = createHash("sha256");
    for (const skill of SKILL_NAMES) {
        const relative = join("skills", skill, "agents", "openai.yaml").replace(/\\/gu, "/");
        const absolute = join(root, relative);
        let existing;
        try {
            existing = await readFile(absolute, "utf8");
        }
        catch (error) {
            throw new SyncError("Missing Skill openai.yaml.", {
                path: relative,
                cause: error instanceof Error ? error.message : String(error),
            });
        }
        const next = renderOpenaiYaml(existing, names);
        hash.update(relative);
        hash.update("\0");
        hash.update(next);
        hash.update("\0");
        if (existing.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n") !== next) {
            changedFiles.push(relative);
            if (options.check !== true) {
                await writeUtf8Lf(absolute, next);
            }
        }
    }
    const codexDir = join(root, "agents", "codex");
    let codexNames = [];
    try {
        codexNames = await listHostAgentNames(codexDir, ".json");
    }
    catch (error) {
        if (options.check === true)
            throw error;
        await mkdir(codexDir, { recursive: true });
    }
    if (options.check === true) {
        assertExactNames(names, codexNames, "agents/codex");
    }
    for (const profile of profiles) {
        const expected = contractFromProfile(profile);
        const relative = `agents/codex/${profile.name}.json`;
        const absolute = join(root, relative);
        const rendered = renderCodexSnapshot(expected);
        let existing;
        try {
            existing = await readFile(absolute, "utf8");
        }
        catch {
            existing = undefined;
        }
        const normalizedExisting = existing?.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
        if (existing !== undefined) {
            let parsed;
            try {
                parsed = JSON.parse(existing);
            }
            catch (error) {
                throw new SyncError("Codex contract snapshot is not valid JSON.", {
                    path: relative,
                    cause: error instanceof Error ? error.message : String(error),
                });
            }
            const actual = contractFromCodexJson(parsed, relative);
            if (options.check === true || normalizedExisting === rendered) {
                assertContractsEqual(expected, actual, relative);
            }
        }
        if (normalizedExisting !== rendered) {
            changedFiles.push(relative);
            if (options.check !== true) {
                await mkdir(codexDir, { recursive: true });
                await writeUtf8Lf(absolute, rendered);
            }
        }
    }
    if (options.check !== true) {
        assertExactNames(names, await listHostAgentNames(codexDir, ".json"), "agents/codex");
    }
    for (const host of HOST_MARKDOWN_DIRS) {
        const hostDir = join(root, "agents", host);
        const hostNames = await listHostAgentNames(hostDir, ".md");
        assertExactNames(names, hostNames, `agents/${host}`);
        for (const profile of profiles) {
            const relative = `agents/${host}/${profile.name}.md`;
            const absolute = join(root, relative);
            let text;
            try {
                text = await readFile(absolute, "utf8");
            }
            catch (error) {
                throw new SyncError("Missing host agent markdown profile.", {
                    path: relative,
                    cause: error instanceof Error ? error.message : String(error),
                });
            }
            assertContractsEqual(contractFromProfile(profile), parseMarkdownContract(text), relative);
        }
    }
    return {
        outputDigest: hash.digest("hex"),
        changedFiles: changedFiles.sort(),
        profiles: names,
    };
}
function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === "--check") {
            options.check = true;
            continue;
        }
        if (token === "--root") {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new SyncError("Option requires a value.", { option: "root" });
            }
            options.root = value;
            index += 1;
            continue;
        }
        throw new SyncError("Unknown option.", { option: token });
    }
    if (options.root === undefined) {
        throw new SyncError("Missing required option.", { option: "root" });
    }
    return options.check === undefined
        ? { root: options.root }
        : { root: options.root, check: options.check };
}
export async function main(argv) {
    try {
        const options = parseArguments(argv);
        const report = await synchronizeAgents(options);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (options.check === true && report.changedFiles.length > 0) {
            return DRIFT_EXIT_CODE;
        }
        return 0;
    }
    catch (error) {
        if (error instanceof SyncError) {
            process.stderr.write(`${JSON.stringify({
                error: { code: "SYNC_ERROR", message: error.message, details: error.details },
            })}\n`);
            return error.message.startsWith("Missing required") || error.message.startsWith("Unknown option") || error.message.startsWith("Option requires")
                ? USAGE_EXIT_CODE
                : UNKNOWN_EXIT_CODE;
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
//# sourceMappingURL=sync-agents.js.map