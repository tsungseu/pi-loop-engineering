import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LoopError, type LoopId } from "../contracts/domain.js";

const LOOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export interface WorkspaceLayout {
  workspaceRoot: string;
  stateRoot: string;
  projectPolicyJson: string;
  preferencesJson: string;
  loopsRoot: string;
  releasesRoot: string;
  knowledgeProposalsRoot: string;
  localCoordinationRoot: string;
}

export interface LoopLayout extends WorkspaceLayout {
  loopId: LoopId;
  loopRoot: string;
  loopJson: string;
  eventsJsonl: string;
  loopMarkdown: string;
  harnessRoot: string;
  evidenceRoot: string;
  checkpointsRoot: string;
  handoffJson: string;
}

export function parseLoopId(value: string): LoopId {
  if (!LOOP_ID_PATTERN.test(value)) {
    throw new LoopError("INVALID_LOOP_ID", "Loop ID must be 1-96 ASCII letters, numbers, dots, underscores, or hyphens and start with a letter or number.", { value });
  }
  return value as LoopId;
}

export function resolveLayout(workspace: string): WorkspaceLayout;
export function resolveLayout(workspace: string, loopId: LoopId): LoopLayout;
export function resolveLayout(workspace: string, loopId?: LoopId): WorkspaceLayout | LoopLayout {
  const workspaceRoot = resolve(workspace);
  const stateRoot = join(workspaceRoot, ".ai-loop");
  const workspaceLayout: WorkspaceLayout = {
    workspaceRoot,
    stateRoot,
    projectPolicyJson: join(stateRoot, "project-policy.json"),
    preferencesJson: join(stateRoot, "preferences.json"),
    loopsRoot: join(stateRoot, "loop"),
    releasesRoot: join(stateRoot, "releases"),
    knowledgeProposalsRoot: join(stateRoot, "knowledge", "proposals"),
    localCoordinationRoot: join(stateRoot, "coordination"),
  };

  if (loopId === undefined) return workspaceLayout;

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

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function resolveThroughExistingParent(path: string): Promise<string> {
  let current = path;
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

export async function assertContained(root: string, candidate: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(root));
  const absoluteCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(canonicalRoot, candidate);
  const canonicalCandidate = await resolveThroughExistingParent(absoluteCandidate);
  const containment = relative(comparablePath(canonicalRoot), comparablePath(canonicalCandidate));

  if (containment === ".." || containment.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(containment)) {
    throw new Error(`Candidate path is outside the canonical root: ${candidate}`);
  }
  return canonicalCandidate;
}

type GitProbeResult =
  | { kind: "FOUND"; path: string }
  | { kind: "NOT_REPOSITORY" }
  | { kind: "FAILED"; details: Readonly<Record<string, unknown>> };

function gitCommonDirectory(workspace: string): Promise<GitProbeResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result: GitProbeResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const child = spawn(
      "git",
      ["-C", workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => settle({
      kind: "FAILED",
      details: { cause: error.message, error_code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" },
    }));
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").replace(/[\r\n]+$/u, "");
      if (code !== 0) {
        if (/\bnot a git repository\b/iu.test(stderr)) {
          settle({ kind: "NOT_REPOSITORY" });
        } else {
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

async function hasGitMarker(workspace: string): Promise<boolean> {
  let current = workspace;
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function gitResolutionError(workspace: string, details: Readonly<Record<string, unknown>>): LoopError {
  return new LoopError("RECONCILE_REQUIRED", "Git repository identity could not be resolved safely.", {
    workspace,
    ...details,
  });
}

export async function resolveCoordinationRoot(workspace: string): Promise<string> {
  const canonicalWorkspace = await realpath(resolve(workspace));
  const probe = await gitCommonDirectory(canonicalWorkspace);
  if (probe.kind === "FAILED") throw gitResolutionError(canonicalWorkspace, probe.details);
  if (probe.kind === "NOT_REPOSITORY") {
    try {
      if (!await hasGitMarker(canonicalWorkspace)) {
        return join(canonicalWorkspace, ".ai-loop", "coordination");
      }
    } catch (error) {
      throw gitResolutionError(canonicalWorkspace, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    throw gitResolutionError(canonicalWorkspace, { cause: "A Git marker exists but Git rejected the repository." });
  }
  try {
    const canonicalCommonDirectory = await realpath(resolve(canonicalWorkspace, probe.path));
    return join(canonicalCommonDirectory, "pai-loop-engineering", "coordination");
  } catch (error) {
    throw gitResolutionError(canonicalWorkspace, {
      common_directory: probe.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
