import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOP_PHASES, LOOP_STATUSES, LoopError } from "../contracts/domain.js";
import validators from "../generated/validators.js";

export type SchemaName =
  | "workflow-spec" | "loop" | "event" | "manifest" | "evidence" | "harness"
  | "wave-input" | "agent-request" | "agent-result" | "agent-bundle"
  | "checkpoint" | "handoff" | "release" | "release-harness"
  | "action-envelope" | "preferences" | "project-policy" | "knowledge-proposal";

interface WorkflowContract {
  phases: readonly string[];
  statuses: readonly string[];
}

export function validateSchema<T>(name: SchemaName, value: unknown): T {
  const validate = validators[name];
  if (validate === undefined || !validate(value)) {
    throw new LoopError("SCHEMA_INVALID", "Machine contract validation failed.", {
      schema: name,
      errors: validate?.errors ?? [],
    });
  }
  return value as T;
}

function workflowPath(): string {
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../assets/loop-engineering/workflow-spec.json"),
    resolve(moduleDirectory, "../../../assets/loop-engineering/workflow-spec.json"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new LoopError("SCHEMA_INVALID", "Workflow specification was not found.");
  }
  return path;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

export function assertWorkflowParity(): void {
  const workflow = validateSchema<WorkflowContract>(
    "workflow-spec",
    JSON.parse(readFileSync(workflowPath(), "utf8")),
  );
  if (
    JSON.stringify(sorted(workflow.phases)) !== JSON.stringify(sorted(LOOP_PHASES))
    || JSON.stringify(sorted(workflow.statuses)) !== JSON.stringify(sorted(LOOP_STATUSES))
  ) {
    throw new LoopError("SCHEMA_INVALID", "Workflow and TypeScript enums differ.", {
      workflow_phases: workflow.phases,
      workflow_statuses: workflow.statuses,
      typescript_phases: LOOP_PHASES,
      typescript_statuses: LOOP_STATUSES,
    });
  }
}
