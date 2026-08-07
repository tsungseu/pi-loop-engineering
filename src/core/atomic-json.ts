import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { validateSchema } from "./schema.js";

export interface AtomicWriteHooks {
  afterTempSync?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
}

export interface DurabilityResult {
  fileSync: "SYNCED";
  directorySync: "SYNCED" | "UNSUPPORTED";
}

type PathSegment = string | number;
type PathPattern = readonly string[];
type MachineContractKind =
  | "manifest" | "evidence" | "harness" | "agent-request" | "agent-result"
  | "handoff" | "release-harness" | "action-envelope" | "project-policy";

const NON_ENGLISH_MACHINE_PATTERN = /[^\u0009\u000a\u000d\u0020-\u007e]/u;
const OPAQUE_PATHS: Readonly<Record<MachineContractKind, readonly PathPattern[]>> = {
  manifest: [["entries", "*", "path"], ["entries", "*", "provenance"]],
  evidence: [["argv", "*"], ["cwd"], ["tool_versions", "*"], ["stdout_path"], ["stderr_path"]],
  harness: [["repository_root"], ["readable_paths", "*"], ["writable_paths", "*"]],
  "agent-request": [["read_set", "*"], ["write_set", "*"], ["worktree"]],
  "agent-result": [["actual_read_set", "*"], ["actual_write_set", "*"]],
  handoff: [["rollback", "target"]],
  "release-harness": [["allowed_targets", "*"]],
  "action-envelope": [["target"], ["branch"], ["authorization", "target"], ["authorization", "authorized_by"]],
  "project-policy": [["included_paths", "*"], ["excluded_paths", "*"]],
};

function renderPath(path: readonly PathSegment[]): string {
  return path.reduce<string>(
    (rendered, segment) => typeof segment === "number"
      ? `${rendered}[${segment}]`
      : rendered === "" ? segment : `${rendered}.${segment}`,
    "",
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inferMachineContract(value: unknown): MachineContractKind | undefined {
  if (!isRecord(value) || value.schema_version !== 1) return undefined;
  if (typeof value.evidence_id === "string" && Array.isArray(value.argv) && isRecord(value.tool_versions)) return "evidence";
  if (Array.isArray(value.entries) && ["source", "tree", "workspace", "runtime", "artifact"].includes(String(value.kind))) return "manifest";
  if (value.kind === "RELEASE" && Array.isArray(value.allowed_targets)) return "release-harness";
  if (
    (value.kind === "H0" && typeof value.repository_root === "string")
    || (value.kind === "H1" && Array.isArray(value.readable_paths) && Array.isArray(value.writable_paths))
  ) return "harness";
  if (typeof value.request_id === "string" && typeof value.objective === "string") return "agent-request";
  if (typeof value.request_id === "string" && typeof value.summary === "string") return "agent-result";
  if (value.review_verdict === "PASS" && isRecord(value.rollback)) return "handoff";
  if (typeof value.operation_id === "string" && isRecord(value.authorization)) return "action-envelope";
  if (typeof value.risk_class === "string" && Array.isArray(value.included_paths)) return "project-policy";
  return undefined;
}

function detectMachineContract(value: unknown): MachineContractKind | undefined {
  const candidate = inferMachineContract(value);
  if (candidate === undefined) return undefined;
  try {
    validateSchema(candidate, value);
    return candidate;
  } catch {
    return undefined;
  }
}

function pathMatches(path: readonly PathSegment[], pattern: PathPattern): boolean {
  return path.length === pattern.length
    && pattern.every((segment, index) => segment === "*" || segment === String(path[index]));
}

function isOpaqueLeaf(contract: MachineContractKind | undefined, path: readonly PathSegment[]): boolean {
  return contract !== undefined && OPAQUE_PATHS[contract].some((pattern) => pathMatches(path, pattern));
}

function inspectMachineStrings(value: unknown, path: readonly PathSegment[], contract: MachineContractKind | undefined): void {
  if (typeof value === "string" && isOpaqueLeaf(contract, path)) return;

  if (typeof value === "string") {
    if (NON_ENGLISH_MACHINE_PATTERN.test(value)) {
      throw new TypeError(`Plugin-authored machine string must be English at ${renderPath(path) || "<root>"}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) inspectMachineStrings(item, [...path, index], contract);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const itemPath = [...path, key];
      if (!(typeof item === "string" && isOpaqueLeaf(contract, itemPath)) && NON_ENGLISH_MACHINE_PATTERN.test(key)) {
        throw new TypeError(`Plugin-authored machine key must be English at ${renderPath([...path, key])}.`);
      }
      inspectMachineStrings(item, itemPath, contract);
    }
  }
}

export function assertEnglishMachineStrings(value: unknown): void {
  inspectMachineStrings(value, [], detectMachineContract(value));
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Value is not canonical JSON: numbers must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Value is not canonical JSON: unsupported ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new TypeError("Value is not canonical JSON: cyclic object graph.");

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Value is not canonical JSON: objects must be plain records.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("Value is not canonical JSON: symbol keys are unsupported.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const elementKeys = Object.keys(descriptors).filter((key) => key !== "length");
      if (elementKeys.length !== value.length) {
        throw new TypeError("Value is not canonical JSON: sparse arrays are unsupported.");
      }
      const elements: { index: number; value: unknown }[] = [];
      for (const key of elementKeys) {
        const index = Number(key);
        if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || !Number.isSafeInteger(index) || index >= value.length) {
          throw new TypeError("Value is not canonical JSON: arrays cannot carry extra properties.");
        }
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Value is not canonical JSON: array elements must be enumerable data properties.");
        }
        elements.push({ index, value: descriptor.value });
      }
      elements.sort((left, right) => left.index - right.index);
      const items: string[] = [];
      for (const [expectedIndex, element] of elements.entries()) {
        if (element.index !== expectedIndex) {
          throw new TypeError("Value is not canonical JSON: sparse arrays are unsupported.");
        }
        items.push(canonicalJson(element.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) throw new TypeError("Value is not canonical JSON: symbol keys are unsupported.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const properties: string[] = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Value is not canonical JSON: object fields must be enumerable data properties.");
      }
      properties.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`);
    }
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value, new Set())}\n`);
}

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("Atomic file write made no progress.");
    offset += bytesWritten;
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") return true;
  return process.platform === "win32"
    && (code === "EPERM" || code === "EACCES" || code === "EISDIR" || code === "EBADF");
}

async function syncDirectory(path: string): Promise<"SYNCED" | "UNSUPPORTED"> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
    return "SYNCED";
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return "UNSUPPORTED";
    throw error;
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

async function removeTemp(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function atomicWriteFile(
  path: string,
  data: Uint8Array,
  hooks: AtomicWriteHooks = {},
): Promise<DurabilityResult> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(path)}.tmp-${randomBytes(16).toString("hex")}`);
  let handle: FileHandle | undefined;
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
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the causal write or injected fault.
      }
    }
    if (!renamed) {
      try {
        await removeTemp(temporaryPath);
      } catch {
        // Preserve the causal write or injected fault.
      }
    }
    throw error;
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  hooks: AtomicWriteHooks = {},
): Promise<DurabilityResult> {
  assertEnglishMachineStrings(value);
  return atomicWriteFile(path, canonicalJsonBytes(value), hooks);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  assertEnglishMachineStrings(value);
  const data = canonicalJsonBytes(value);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  try {
    await writeAll(handle, data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
