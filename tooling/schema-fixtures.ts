import {
  ENVIRONMENT_NODES,
  LOOP_PHASES,
  LOOP_STATUSES,
  type Digest,
  type EnforcementClass,
  type EventRecord,
  type GateOwner,
  type LoopId,
  type LoopRecord,
  type MarkdownLanguage,
} from "../src/contracts/domain.js";
import type {
  AgentBundle,
  AgentRequest,
  AgentResult,
  WaveInput,
} from "../src/contracts/dispatch.js";
import type {
  ContentManifest,
  EvidenceRecord,
  H0Harness,
  H1Harness,
  ManifestEntry,
} from "../src/contracts/harness.js";
import {
  RELEASE_PHASES,
  type CommitActionEnvelope,
  type ExternalActionEnvelope,
  type FinalHandoff,
  type KnowledgeProposal,
  type KnowledgeProposalStatus,
  type PhysicalActionEnvelope,
  type Preferences,
  type ProjectPolicy,
  type ReleaseAction,
  type ReleaseHarness,
  type ReleaseRecord,
} from "../src/contracts/release.js";
import type { Checkpoint } from "../src/contracts/release.js";

function exactEnum<Union>() {
  return <const Values extends readonly Union[]>(
    ...values: Values & (Exclude<Union, Values[number]> extends never ? unknown : never)
  ): Values => values;
}

const gateOwners = exactEnum<GateOwner>()("LOOP_REQUIRED", "RELEASE_REQUIRED", "NOT_APPLICABLE");
const enforcementClasses = exactEnum<EnforcementClass>()("HOST_ENFORCED", "RUNTIME_ENFORCED", "ORCHESTRATION_ONLY");
const markdownLanguages = exactEnum<MarkdownLanguage>()("en-US", "zh-CN");
const releaseActions = exactEnum<ReleaseAction>()(
  "commit", "push", "pr", "tag", "publish", "deploy-sim", "run-hil", "deploy-robot", "run-real-robot",
);
const knowledgeStatuses = exactEnum<KnowledgeProposalStatus>()(
  "PROVISIONAL", "REVIEW_PENDING", "REVISE", "APPROVED", "REJECTED", "SUPERSEDED", "APPLIED",
);
const manifestKinds = exactEnum<ContentManifest["kind"]>()("source", "tree", "workspace", "runtime", "artifact");
const manifestEntryKinds = exactEnum<ManifestEntry["kind"]>()("file", "symlink", "submodule", "external");
const evidenceResults = exactEnum<EvidenceRecord["result"]>()("PASS", "FAIL", "PRE_EXISTING", "NOT_RUN");
const harnessKinds = exactEnum<H0Harness["kind"] | H1Harness["kind"]>()("H0", "H1");
const networkClasses = exactEnum<H0Harness["network_class"]>()("DISABLED", "RESTRICTED", "FULL");
const agentResultStatuses = exactEnum<AgentResult["status"]>()("COMPLETED", "FAILED", "BLOCKED");
const projectRiskClasses = exactEnum<ProjectPolicy["risk_class"]>()("LOW", "MEDIUM", "HIGH");
const proposalTypes = exactEnum<KnowledgeProposal["proposal_type"]>()("PROJECT_KNOWLEDGE", "PROJECT_POLICY", "WORKFLOW_SKILL_HARNESS");
const physicalEnvironmentNodes = exactEnum<PhysicalActionEnvelope["environment_node"]>()("HIL", "BENCH", "CLOSED_COURSE", "REAL_VEHICLE_ROBOT");

export const contractEnums = {
  loopPhase: LOOP_PHASES,
  loopStatus: LOOP_STATUSES,
  environmentNode: ENVIRONMENT_NODES,
  gateOwner: gateOwners,
  enforcementClass: enforcementClasses,
  markdownLanguage: markdownLanguages,
  releaseAction: releaseActions,
  releasePhase: RELEASE_PHASES,
  knowledgeProposalStatus: knowledgeStatuses,
  manifestKind: manifestKinds,
  manifestEntryKind: manifestEntryKinds,
  evidenceResult: evidenceResults,
  harnessKind: harnessKinds,
  networkClass: networkClasses,
  agentResultStatus: agentResultStatuses,
  projectRiskClass: projectRiskClasses,
  knowledgeProposalType: proposalTypes,
  physicalEnvironmentNode: physicalEnvironmentNodes,
} as const;

const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Digest;
const zeroDigest = "0000000000000000000000000000000000000000000000000000000000000000" as Digest;
const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const loopId = "loop-001" as LoopId;
const timestamp = "2026-08-06T00:00:00.000Z";

const loop = {
  schema_version: 2, loop_id: loopId, parent_loop_id: null, phase: "NEW", status: "ACTIVE",
  markdown_language: "en-US", last_event_sequence: 0, last_event_hash: zeroDigest,
  current_harness_revision: null, current_harness_digest: null, handoff_digest: null,
} as const satisfies LoopRecord;

const event = {
  schema_version: 1, sequence: 1, event_id: "event-001", loop_id: loopId, type: "LOOP_CREATED",
  actor_role: "controller", timestamp, previous_hash: digest,
  payload: { kind: "loop", data_digest: digest }, hash: digest,
} as const satisfies EventRecord;

const manifest = {
  schema_version: 1, kind: "source",
  entries: [{ path: "src/index.ts", mode: "100644", digest, kind: "file" }], digest,
} as const satisfies ContentManifest;

const evidence = {
  schema_version: 1, evidence_id: "evidence-001", loop_id: loopId, work_item_id: "work-001",
  attempt: 1, actor_role: "worker", h1_digest: digest, wave_input_digest: digest,
  output_tree_digest: digest, argv: ["npm", "\u6d4b\u8bd5"], cwd: "C:/\u9879\u76ee", started_at: timestamp,
  ended_at: timestamp, exit_code: 0, environment_digest: digest, tool_versions: { "\u4eff\u771f\u5668": "\u7248\u672c-1" },
  stdout_path: "evidence/\u8f93\u51fa.bin", stdout_digest: digest, stderr_path: "evidence/\u9519\u8bef.bin",
  stderr_digest: digest, artifact_manifest_digest: digest, result: "PASS",
} as const satisfies EvidenceRecord;

const h0 = {
  schema_version: 1, kind: "H0", loop_id: loopId, revision: 0, repository_id: "repository-001",
  repository_root: "C:/workspace", readable_paths: ["src/**"], repository_rules_digest: digest,
  explore_capabilities: ["native-search"], network_class: "DISABLED", denied_actions: ["push"], digest,
} as const satisfies H0Harness;

const h1 = {
  schema_version: 1, kind: "H1", loop_id: loopId, revision: 1, objective: "Implement the bounded task.",
  acceptance: ["All checks pass."], out_of_scope: ["Release execution."], readable_paths: ["src/**"],
  writable_paths: ["src/contracts/**"], wave_input_digest: digest, project_policy_digest: digest,
  plan_digest: digest,
  environment_gates: [{ gate_id: "unit", node: "UNIT_COMPONENT", owner: "LOOP_REQUIRED", depends_on: [], evidence_ids: ["evidence-001"], requires_new_action: false }],
  actors: [{ actor_role: "worker", model_class: "coding", capabilities: ["source-write"] }],
  capabilities: [{ capability: "source-write", enforcement: "ORCHESTRATION_ONLY" }],
  budgets: { attempts: 3, reviews: 2, transitions: 20 }, stop_rules: ["Stop on scope drift."],
  result_schemas: ["agent-result"], digest,
} as const satisfies H1Harness;

const waveInput = {
  schema_version: 1, loop_id: loopId, wave_id: "wave-001", base_sha: sha,
  source_manifest_digest: digest, tree_manifest_digest: digest, workspace_manifest_digest: digest,
  artifact_manifest_digest: digest, h1_policy_digest: digest, digest,
} as const satisfies WaveInput;

const agentRequest = {
  schema_version: 1, request_id: "request-001", loop_id: loopId, work_item_id: "work-001",
  attempt: 1, actor_role: "worker", objective: "Implement the bounded task.", acceptance: ["All checks pass."],
  dependencies: [], read_set: ["src/input.ts"], write_set: ["src/output.ts"], worktree: "C:/workspace",
  wave_input_digest: digest, h1_digest: digest, fencing_token: 1, required_evidence_ids: ["evidence-001"],
  allowed_tools: ["typescript"], stop_conditions: ["Stop on scope drift."], digest,
} as const satisfies AgentRequest;

const agentResult = {
  schema_version: 1, request_id: "request-001", loop_id: loopId, work_item_id: "work-001",
  attempt: 1, actor_role: "worker", wave_input_digest: digest, h1_digest: digest, fencing_token: 1,
  status: "COMPLETED", output_tree_digest: digest, actual_read_set: ["src/input.ts"],
  actual_write_set: ["src/output.ts"], evidence_ids: ["evidence-001"], artifact_manifest_digest: digest,
  summary: "The bounded task completed.", digest,
} as const satisfies AgentResult;

const agentBundle = {
  schema_version: 1, bundle_id: "bundle-001", request_digest: digest, result_digest: digest,
  patch_digest: digest, output_tree_digest: digest, artifact_manifest_digest: digest,
  evidence_ids: ["evidence-001"], digest,
} as const satisfies AgentBundle;

const checkpoint = {
  schema_version: 1, loop_id: loopId, sequence: 1, phase: "VERIFYING", status: "BLOCKED",
  source_head_sha: sha, completed_work_item_ids: ["work-001"], evidence_ids: ["evidence-001"],
  blocker: "Hardware is unavailable.", resume_entry: "Resume at the HIL gate.", digest,
} as const satisfies Checkpoint;

const handoff = {
  schema_version: 1, loop_id: loopId, markdown_language: "en-US", source_head_sha: sha,
  reviewed_tree_digest: digest, workspace_digest: digest, source_manifest_digest: digest,
  runtime_manifest_digest: digest, project_policy_digest: digest, h0_digest: digest, h1_revision: 1,
  h1_digest: digest, loop_markdown_digest: digest, agent_bundle_digests: [digest],
  evidence_manifest_digest: digest, review_verdict: "PASS", residual_risks: ["Authorization remains separate."],
  rollback: { target: "release-001", procedure: ["Restore the prior commit."], triggers: ["Regression."], estimated_recovery_minutes: 10 },
  release_required_gates: ["hil"], recommended_release_actions: ["commit", "run-hil"],
  finalize_event_sequence: 10, digest,
} as const satisfies FinalHandoff;

const release = {
  schema_version: 1, release_id: "release-001", loop_id: loopId, handoff_digest: digest, phase: "READY",
  action_envelope_digests: [], operation_ids: [], created_at: timestamp, updated_at: timestamp,
  release_commit_sha: null, digest,
} as const satisfies ReleaseRecord;

const releaseHarness = {
  schema_version: 1, kind: "RELEASE", release_id: "release-001", loop_id: loopId, handoff_digest: digest,
  allowed_actions: ["commit", "run-hil"], allowed_targets: ["bench-a"], allowed_tools: ["git"],
  expires_at: "2026-08-06T01:00:00.000Z", digest,
} as const satisfies ReleaseHarness;

const commitAuthorization = { authorization_id: "auth-commit", action: "commit", target: "main", environment_node: null, authorized_by: "owner", authorized_at: timestamp, expires_at: timestamp, digest } as const;
const externalAuthorization = { authorization_id: "auth-push", action: "push", target: "origin", environment_node: null, authorized_by: "owner", authorized_at: timestamp, expires_at: timestamp, digest } as const;
const physicalAuthorization = { authorization_id: "auth-hil", action: "run-hil", target: "bench-a", environment_node: "HIL", authorized_by: "owner", authorized_at: timestamp, expires_at: timestamp, digest } as const;
const envelopeBase = { schema_version: 1, operation_id: "operation-001", release_id: "release-001", handoff_digest: digest, source_head_sha: sha, reviewed_tree_digest: digest, metadata_digest: digest } as const;
const commitEnvelope = { ...envelopeBase, target: "main", authorization: commitAuthorization, action: "commit", expected_parent_sha: sha, branch: "main" } as const satisfies CommitActionEnvelope;
const externalEnvelope = { ...envelopeBase, target: "origin", authorization: externalAuthorization, action: "push", release_commit_sha: sha } as const satisfies ExternalActionEnvelope;
const physicalEnvelope = { ...envelopeBase, target: "bench-a", authorization: physicalAuthorization, action: "run-hil", release_commit_sha: sha, environment_node: "HIL" } as const satisfies PhysicalActionEnvelope;

const preferences = { schema_version: 1, markdown_language: "en-US" } as const satisfies Preferences;
const projectPolicy = {
  schema_version: 1, risk_class: "HIGH", included_paths: ["src/**"], excluded_paths: [".ai-loop/**"],
  environment_gates: [{ gate_id: "hil", node: "HIL", owner: "RELEASE_REQUIRED", depends_on: [], evidence_ids: [], requires_new_action: true }],
  allowed_tools: ["typescript"], denied_actions: ["run-real-robot"], digest,
} as const satisfies ProjectPolicy;
const knowledgeProposal = {
  schema_version: 1, proposal_id: "proposal-001", proposal_type: "PROJECT_KNOWLEDGE", status: "PROVISIONAL",
  markdown_language: "en-US", source_loop_ids: [loopId], source_handoff_digests: [digest], observation_count: 1,
  explicit_user_correction: false, correction_provenance: [], counterexamples: [], privacy_review: "No sensitive content.",
  expected_benefit: "Reduce repeated review work.", safety_impact: "No safety boundary changes.",
  offline_evaluation: ["Replay prior cases."], canary: ["Use in one child Loop."], rollback: ["Supersede the proposal."],
  review_date: "2026-08-06", implementation_loop_id: null, digest,
} as const satisfies KnowledgeProposal;

export const typedSchemaFixtures = {
  loop: [loop], event: [event], manifest: [manifest], evidence: [evidence], harness: [h0, h1],
  "wave-input": [waveInput], "agent-request": [agentRequest], "agent-result": [agentResult],
  "agent-bundle": [agentBundle], checkpoint: [checkpoint], handoff: [handoff], release: [release],
  "release-harness": [releaseHarness], "action-envelope": [commitEnvelope, externalEnvelope, physicalEnvelope],
  preferences: [preferences], "project-policy": [projectPolicy], "knowledge-proposal": [knowledgeProposal],
} as const;
