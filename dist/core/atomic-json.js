import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const DEFAULT_OPAQUE_FIELDS = new Set([
    "argv", "cwd", "tool_versions", "stdout_path", "stderr_path",
    "path", "provenance", "repository_root", "readable_paths", "writable_paths",
    "read_set", "write_set", "worktree", "actual_read_set", "actual_write_set",
    "target", "branch", "authorized_by", "included_paths", "excluded_paths",
    "opaque_evidence", "verbatim", "stdout", "stderr", "raw_output", "user_input",
]);
const MARKDOWN_FIELDS = new Set(["markdown", "markdown_body", "body_markdown", "content_markdown"]);
function renderPath(path) {
    return path.reduce((rendered, segment) => typeof segment === "number"
        ? `${rendered}[${segment}]`
        : rendered === "" ? segment : `${rendered}.${segment}`, "");
}
function inspectMachineStrings(value, path, opaqueFields) {
    const field = path.at(-1);
    if (typeof field === "string" && (opaqueFields.has(field) || MARKDOWN_FIELDS.has(field)))
        return;
    if (typeof value === "string") {
        if (CJK_PATTERN.test(value)) {
            throw new TypeError(`Plugin-authored machine string must be English at ${renderPath(path) || "<root>"}.`);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries())
            inspectMachineStrings(item, [...path, index], opaqueFields);
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            if (!opaqueFields.has(key) && !MARKDOWN_FIELDS.has(key) && CJK_PATTERN.test(key)) {
                throw new TypeError(`Plugin-authored machine key must be English at ${renderPath([...path, key])}.`);
            }
            inspectMachineStrings(item, [...path, key], opaqueFields);
        }
    }
}
export function assertEnglishMachineStrings(value, options = {}) {
    const opaqueFields = options.opaqueFields === undefined
        ? DEFAULT_OPAQUE_FIELDS
        : new Set([...DEFAULT_OPAQUE_FIELDS, ...options.opaqueFields]);
    inspectMachineStrings(value, [], opaqueFields);
}
function canonicalJson(value, ancestors) {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new TypeError("Value is not canonical JSON: numbers must be finite.");
        return JSON.stringify(value);
    }
    if (typeof value !== "object") {
        throw new TypeError(`Value is not canonical JSON: unsupported ${typeof value}.`);
    }
    if (ancestors.has(value))
        throw new TypeError("Value is not canonical JSON: cyclic object graph.");
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Value is not canonical JSON: objects must be plain records.");
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const items = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.hasOwn(value, index))
                    throw new TypeError("Value is not canonical JSON: sparse arrays are unsupported.");
                items.push(canonicalJson(value[index], ancestors));
            }
            return `[${items.join(",")}]`;
        }
        const symbols = Object.getOwnPropertySymbols(value);
        if (symbols.length > 0)
            throw new TypeError("Value is not canonical JSON: symbol keys are unsupported.");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const keys = Object.keys(descriptors).sort();
        const properties = [];
        for (const key of keys) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
                throw new TypeError("Value is not canonical JSON: object fields must be enumerable data properties.");
            }
            properties.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`);
        }
        return `{${properties.join(",")}}`;
    }
    finally {
        ancestors.delete(value);
    }
}
export function canonicalJsonBytes(value) {
    return new TextEncoder().encode(`${canonicalJson(value, new Set())}\n`);
}
async function writeAll(handle, data) {
    let offset = 0;
    while (offset < data.byteLength) {
        const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, null);
        if (bytesWritten === 0)
            throw new Error("Atomic file write made no progress.");
        offset += bytesWritten;
    }
}
function isUnsupportedDirectorySync(error) {
    const code = error.code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP")
        return true;
    return process.platform === "win32"
        && (code === "EPERM" || code === "EACCES" || code === "EISDIR" || code === "EBADF");
}
async function syncDirectory(path) {
    let handle;
    try {
        handle = await open(path, "r");
        await handle.sync();
        return "SYNCED";
    }
    catch (error) {
        if (isUnsupportedDirectorySync(error))
            return "UNSUPPORTED";
        throw error;
    }
    finally {
        if (handle !== undefined)
            await handle.close();
    }
}
async function removeTemp(path) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
export async function atomicWriteFile(path, data, hooks = {}) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(directory, `.${basename(path)}.tmp-${randomBytes(16).toString("hex")}`);
    let handle;
    let renamed = false;
    try {
        handle = await open(temporaryPath, "wx", 0o600);
        await writeAll(handle, data);
        await handle.sync();
        await hooks.afterTempSync?.();
        await handle.close();
        handle = undefined;
        await hooks.beforeRename?.();
        await rename(temporaryPath, path);
        renamed = true;
        await hooks.afterRename?.();
        return { fileSync: "SYNCED", directorySync: await syncDirectory(directory) };
    }
    catch (error) {
        if (handle !== undefined) {
            try {
                await handle.close();
            }
            catch {
                // Preserve the causal write or injected fault.
            }
        }
        if (!renamed) {
            try {
                await removeTemp(temporaryPath);
            }
            catch {
                // Preserve the causal write or injected fault.
            }
        }
        throw error;
    }
}
export async function atomicWriteJson(path, value, hooks = {}) {
    assertEnglishMachineStrings(value);
    return atomicWriteFile(path, canonicalJsonBytes(value), hooks);
}
export async function appendJsonLine(path, value) {
    assertEnglishMachineStrings(value);
    const data = canonicalJsonBytes(value);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a", 0o600);
    try {
        await writeAll(handle, data);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=atomic-json.js.map