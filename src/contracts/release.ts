import type { Digest, EnvironmentNode, LoopId, LoopPhase, LoopStatus, MarkdownLanguage } from "./domain.js";
import type { GateRequirement } from "./harness.js";

export type ReleaseAction =
  | "commit"
  | "push"
  | "pr"
  | "tag"
  | "publish"
  | "deploy-sim"
  | "run-hil"
  | "deploy-robot"
  | "run-real-robot";

export interface Checkpoint {
  schema_version: 1;
  loop_id: LoopId;
  sequence: number;
  phase: LoopPhase;
  status: LoopStatus;
  source_head_sha: string;
  completed_work_item_ids: readonly string[];
  evidence_ids: readonly string[];
  blocker: string | null;
  resume_entry: string;
  digest: Digest;
}

export interface RollbackPlan {
  target: string;
  procedure: readonly string[];
  triggers: readonly string[];
  estimated_recovery_minutes: number;
}

export interface FinalHandoff {
  schema_version: 1;
  loop_id: LoopId;
  markdown_language: MarkdownLanguage;
  source_head_sha: string;
  reviewed_tree_digest: Digest;
  workspace_digest: Digest;
  source_manifest_digest: Digest;
  runtime_manifest_digest: Digest;
  project_policy_digest: Digest | null;
  h0_digest: Digest;
  h1_revision: number;
  h1_digest: Digest;
  loop_markdown_digest: Digest;
  agent_bundle_digests: readonly Digest[];
  evidence_manifest_digest: Digest;
  review_verdict: "PASS";
  residual_risks: readonly string[];
  rollback: RollbackPlan;
  release_required_gates: readonly string[];
  recommended_release_actions: readonly ReleaseAction[];
  finalize_event_sequence: number;
  digest: Digest;
}

export const RELEASE_PHASES = [
  "NEW", "VALIDATING_HANDOFF", "READY", "AWAITING_AUTHORIZATION",
  "EXECUTING", "RECONCILING", "RELEASED", "BLOCKED", "CANCELLED",
] as const;
export type ReleasePhase = (typeof RELEASE_PHASES)[number];

export interface ReleaseRecord {
  schema_version: 1;
  release_id: string;
  loop_id: LoopId;
  handoff_digest: Digest;
  phase: ReleasePhase;
  action_envelope_digests: readonly Digest[];
  operation_ids: readonly string[];
  created_at: string;
  updated_at: string;
  release_commit_sha: string | null;
  digest: Digest;
}

export interface ReleaseHarness {
  schema_version: 1;
  kind: "RELEASE";
  release_id: string;
  loop_id: LoopId;
  handoff_digest: Digest;
  allowed_actions: readonly ReleaseAction[];
  allowed_targets: readonly string[];
  allowed_tools: readonly string[];
  expires_at: string;
  digest: Digest;
}

export interface ScopedAuthorization {
  authorization_id: string;
  action: ReleaseAction;
  target: string;
  environment_node: EnvironmentNode | null;
  authorized_by: string;
  authorized_at: string;
  expires_at: string;
  digest: Digest;
}

interface ActionEnvelopeBase {
  schema_version: 1;
  operation_id: string;
  release_id: string;
  handoff_digest: Digest;
  target: string;
  source_head_sha: string;
  reviewed_tree_digest: Digest;
  authorization: ScopedAuthorization;
  metadata_digest: Digest;
}

export interface CommitActionEnvelope extends ActionEnvelopeBase {
  action: "commit";
  expected_parent_sha: string;
  branch: string;
}

export interface ExternalActionEnvelope extends ActionEnvelopeBase {
  action: "push" | "pr" | "tag" | "publish" | "deploy-sim";
  release_commit_sha: string;
}

export interface PhysicalActionEnvelope extends ActionEnvelopeBase {
  action: "run-hil" | "deploy-robot" | "run-real-robot";
  release_commit_sha: string;
  environment_node: "HIL" | "BENCH" | "CLOSED_COURSE" | "REAL_VEHICLE_ROBOT";
}

export type ActionEnvelope = CommitActionEnvelope | ExternalActionEnvelope | PhysicalActionEnvelope;

export interface Preferences {
  schema_version: 1;
  markdown_language: MarkdownLanguage;
}

export interface ProjectPolicy {
  schema_version: 1;
  risk_class: "LOW" | "MEDIUM" | "HIGH";
  included_paths: readonly string[];
  excluded_paths: readonly string[];
  environment_gates: readonly GateRequirement[];
  allowed_tools: readonly string[];
  denied_actions: readonly ReleaseAction[];
  digest: Digest;
}

export type KnowledgeProposalStatus =
  | "PROVISIONAL"
  | "REVIEW_PENDING"
  | "REVISE"
  | "APPROVED"
  | "REJECTED"
  | "SUPERSEDED"
  | "APPLIED";

export interface KnowledgeProposal {
  schema_version: 1;
  proposal_id: string;
  proposal_type: "PROJECT_KNOWLEDGE" | "PROJECT_POLICY" | "WORKFLOW_SKILL_HARNESS";
  status: KnowledgeProposalStatus;
  markdown_language: MarkdownLanguage;
  source_loop_ids: readonly LoopId[];
  source_handoff_digests: readonly Digest[];
  observation_count: number;
  explicit_user_correction: boolean;
  correction_provenance: readonly string[];
  counterexamples: readonly string[];
  privacy_review: string;
  expected_benefit: string;
  safety_impact: string;
  offline_evaluation: readonly string[];
  canary: readonly string[];
  rollback: readonly string[];
  review_date: string;
  implementation_loop_id: LoopId | null;
  digest: Digest;
}
