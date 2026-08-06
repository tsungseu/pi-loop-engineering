import type { Digest, LoopId } from "./domain.js";

export interface WaveInput {
  schema_version: 1;
  loop_id: LoopId;
  wave_id: string;
  base_sha: string;
  source_manifest_digest: Digest;
  tree_manifest_digest: Digest;
  workspace_manifest_digest: Digest;
  artifact_manifest_digest: Digest;
  h1_policy_digest: Digest;
  digest: Digest;
}

export interface AgentRequest {
  schema_version: 1;
  request_id: string;
  loop_id: LoopId;
  work_item_id: string;
  attempt: number;
  actor_role: string;
  objective: string;
  acceptance: readonly string[];
  dependencies: readonly string[];
  read_set: readonly string[] | "UNKNOWN";
  write_set: readonly string[];
  worktree: string;
  wave_input_digest: Digest;
  h1_digest: Digest;
  fencing_token: number;
  required_evidence_ids: readonly string[];
  allowed_tools: readonly string[];
  stop_conditions: readonly string[];
  digest: Digest;
}

export interface AgentResult {
  schema_version: 1;
  request_id: string;
  loop_id: LoopId;
  work_item_id: string;
  attempt: number;
  actor_role: string;
  wave_input_digest: Digest;
  h1_digest: Digest;
  fencing_token: number;
  status: "COMPLETED" | "FAILED" | "BLOCKED";
  output_tree_digest: Digest;
  actual_read_set: readonly string[];
  actual_write_set: readonly string[];
  evidence_ids: readonly string[];
  artifact_manifest_digest: Digest;
  summary: string;
  digest: Digest;
}

export interface AgentBundle {
  schema_version: 1;
  bundle_id: string;
  request_digest: Digest;
  result_digest: Digest;
  patch_digest: Digest;
  output_tree_digest: Digest;
  artifact_manifest_digest: Digest;
  evidence_ids: readonly string[];
  digest: Digest;
}
