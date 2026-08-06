import type {
  Digest,
  EnforcementClass,
  EnvironmentNode,
  GateOwner,
  LoopId,
} from "./domain.js";

export interface ManifestEntry {
  path: string;
  mode: string;
  digest: Digest;
  kind: "file" | "symlink" | "submodule" | "external";
  provenance?: string;
}

export interface ContentManifest {
  schema_version: 1;
  kind: "source" | "tree" | "workspace" | "runtime" | "artifact";
  entries: readonly ManifestEntry[];
  digest: Digest;
}

export interface EvidenceRecord {
  schema_version: 1;
  evidence_id: string;
  loop_id: LoopId;
  work_item_id: string;
  attempt: number;
  actor_role: string;
  h1_digest: Digest;
  wave_input_digest: Digest;
  output_tree_digest: Digest;
  argv: readonly string[];
  cwd: string;
  started_at: string;
  ended_at: string;
  exit_code: number | null;
  environment_digest: Digest;
  tool_versions: Readonly<Record<string, string>>;
  stdout_path: string;
  stdout_digest: Digest;
  stderr_path: string;
  stderr_digest: Digest;
  artifact_manifest_digest: Digest;
  result: "PASS" | "FAIL" | "PRE_EXISTING" | "NOT_RUN";
}

export interface GateRequirement {
  gate_id: string;
  node: EnvironmentNode;
  owner: GateOwner;
  depends_on: readonly string[];
  evidence_ids: readonly string[];
  requires_new_action: boolean;
  not_applicable_reason?: string;
}

export interface CapabilityGrant {
  capability: string;
  enforcement: EnforcementClass;
}

export interface ActorGrant {
  actor_role: string;
  model_class: string;
  capabilities: readonly string[];
}

export interface HarnessBudgets {
  attempts: number;
  reviews: number;
  transitions: number;
}

export interface H0Harness {
  schema_version: 1;
  kind: "H0";
  loop_id: LoopId;
  revision: 0;
  repository_id: string;
  repository_root: string;
  readable_paths: readonly string[];
  repository_rules_digest: Digest;
  explore_capabilities: readonly string[];
  network_class: "DISABLED" | "RESTRICTED" | "FULL";
  denied_actions: readonly string[];
  digest: Digest;
}

export interface H1Harness {
  schema_version: 1;
  kind: "H1";
  loop_id: LoopId;
  revision: number;
  objective: string;
  acceptance: readonly string[];
  out_of_scope: readonly string[];
  readable_paths: readonly string[];
  writable_paths: readonly string[];
  wave_input_digest: Digest;
  project_policy_digest: Digest;
  plan_digest: Digest;
  environment_gates: readonly GateRequirement[];
  actors: readonly ActorGrant[];
  capabilities: readonly CapabilityGrant[];
  budgets: HarnessBudgets;
  stop_rules: readonly string[];
  result_schemas: readonly string[];
  digest: Digest;
}

export type Harness = H0Harness | H1Harness;
