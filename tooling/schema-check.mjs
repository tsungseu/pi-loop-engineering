import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = resolve(repositoryRoot, "schemas");
const expectedNames = [
  "action-envelope", "agent-bundle", "agent-request", "agent-result", "checkpoint", "event",
  "evidence", "handoff", "harness", "knowledge-proposal", "loop", "manifest", "preferences",
  "project-policy", "release", "release-harness", "wave-input", "workflow-spec",
];
const schemaFiles = (await readdir(schemaDirectory))
  .filter((name) => name.endsWith(".schema.json"))
  .sort();
const records = [];

for (const file of schemaFiles) {
  const name = parse(file).name.replace(/\.schema$/, "");
  const schema = JSON.parse(await readFile(resolve(schemaDirectory, file), "utf8"));
  const expectedId = `https://pai-loop-engineering.local/schemas/${file}`;
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.$id !== expectedId) {
    throw new Error(`Schema ${file} does not use the locked Draft 2020-12 identity.`);
  }
  records.push({ file, id: schema.$id, name, schema });
}

if (JSON.stringify(records.map(({ name }) => name).sort()) !== JSON.stringify(expectedNames)) {
  throw new Error(`Expected exactly 18 Schemas: ${expectedNames.join(", ")}.`);
}

function visit(value, callback) {
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) visit(item, callback);
  }
}

for (const record of records) {
  visit(record.schema, (value) => {
    if (
      value !== null
      && typeof value === "object"
      && value.type === "object"
      && value.properties !== undefined
      && value.additionalProperties !== false
    ) {
      throw new Error(`Schema ${record.file} has an open record boundary.`);
    }
  });
}

const schemasById = new Map(records.map((record) => [record.id, record.schema]));
function resolvePointer(document, fragment) {
  if (fragment === "" || fragment === "/") return document;
  return fragment.split("/").slice(1).reduce((value, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return value?.[key];
  }, document);
}

for (const record of records) {
  visit(record.schema, (value) => {
    if (value === null || typeof value !== "object" || typeof value.$ref !== "string") return;
    const [referenceId = "", fragment = ""] = value.$ref.split("#", 2);
    const target = referenceId === "" ? record.schema : schemasById.get(referenceId);
    if (target === undefined || resolvePointer(target, fragment) === undefined) {
      throw new Error(`Schema ${record.file} contains unresolved $ref ${value.$ref}.`);
    }
  });
}

const ajv = new Ajv2020({ allErrors: true, strict: true, code: { esm: true, source: true } });
for (const record of records) ajv.addSchema(record.schema, record.id);
for (const record of records) {
  if (ajv.getSchema(record.id) === undefined) throw new Error(`Schema ${record.file} did not compile.`);
}

const temporaryRoot = resolve(repositoryRoot, `.schema-check-${randomBytes(12).toString("hex")}`);
const validatorsPath = resolve(temporaryRoot, "validators.mjs");
const domainModulePath = resolve(temporaryRoot, "src", "contracts", "domain.js");
const fixtureModulePath = resolve(temporaryRoot, "tooling", "schema-fixtures.js");
const englishContractModulePath = resolve(temporaryRoot, "tooling", "english-contract.js");
const enumExportPath = resolve(temporaryRoot, "workflow-enums.json");

function run(command, arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { cwd: repositoryRoot, stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Child exited with ${signal === null ? `code ${code}` : `signal ${signal}`}.`));
    });
  });
}

const digest = "a".repeat(64);
const sha = "b".repeat(40);
const timestamp = "2026-08-06T00:00:00.000Z";
const workflow = JSON.parse(await readFile(resolve(repositoryRoot, "assets", "loop-engineering", "workflow-spec.json"), "utf8"));
const authorization = {
  authorization_id: "authorization-001", action: "run-hil", target: "bench-a",
  environment_node: "HIL", authorized_by: "release-owner", authorized_at: timestamp,
  expires_at: "2026-08-06T01:00:00.000Z", digest,
};
const validFixtures = {
  "action-envelope": { schema_version: 1, operation_id: "operation-001", release_id: "release-001", handoff_digest: digest, target: "bench-a", source_head_sha: sha, reviewed_tree_digest: digest, authorization, metadata_digest: digest, action: "run-hil", release_commit_sha: sha, environment_node: "HIL" },
  "agent-bundle": { schema_version: 1, bundle_id: "bundle-001", request_digest: digest, result_digest: digest, patch_digest: digest, output_tree_digest: digest, artifact_manifest_digest: digest, evidence_ids: ["evidence-001"], digest },
  "agent-request": { schema_version: 1, request_id: "request-001", loop_id: "loop-001", work_item_id: "work-001", attempt: 1, actor_role: "worker", objective: "Implement the bounded task.", acceptance: ["All checks pass."], dependencies: [], read_set: ["src/input.ts"], write_set: ["src/output.ts"], worktree: "C:/workspace", wave_input_digest: digest, h1_digest: digest, fencing_token: 1, required_evidence_ids: ["evidence-001"], allowed_tools: ["typescript"], stop_conditions: ["Stop on scope drift."], digest },
  "agent-result": { schema_version: 1, request_id: "request-001", loop_id: "loop-001", work_item_id: "work-001", attempt: 1, actor_role: "worker", wave_input_digest: digest, h1_digest: digest, fencing_token: 1, status: "COMPLETED", output_tree_digest: digest, actual_read_set: ["src/input.ts"], actual_write_set: ["src/output.ts"], evidence_ids: ["evidence-001"], artifact_manifest_digest: digest, summary: "The bounded task completed.", digest },
  checkpoint: { schema_version: 1, loop_id: "loop-001", sequence: 1, phase: "VERIFYING", status: "BLOCKED", source_head_sha: sha, completed_work_item_ids: ["work-001"], evidence_ids: ["evidence-001"], blocker: "Hardware is unavailable.", resume_entry: "Resume at the HIL gate.", digest },
  event: { schema_version: 1, sequence: 1, event_id: "event-001", loop_id: "loop-001", type: "LOOP_CREATED", actor_role: "controller", timestamp, previous_hash: digest, payload: { kind: "loop", data_digest: digest }, hash: digest },
  evidence: { schema_version: 1, evidence_id: "evidence-001", loop_id: "loop-001", work_item_id: "work-001", attempt: 1, actor_role: "worker", h1_digest: digest, wave_input_digest: digest, output_tree_digest: digest, argv: ["npm", "\u6d4b\u8bd5"], cwd: "C:/\u9879\u76ee", started_at: timestamp, ended_at: timestamp, exit_code: 0, environment_digest: digest, tool_versions: { "\u4eff\u771f\u5668": "\u7248\u672c-1" }, stdout_path: "evidence/\u8f93\u51fa.bin", stdout_digest: digest, stderr_path: "evidence/\u9519\u8bef.bin", stderr_digest: digest, artifact_manifest_digest: digest, result: "PASS" },
  handoff: { schema_version: 1, loop_id: "loop-001", markdown_language: "en-US", source_head_sha: sha, reviewed_tree_digest: digest, workspace_digest: digest, source_manifest_digest: digest, runtime_manifest_digest: digest, project_policy_digest: digest, h0_digest: digest, h1_revision: 1, h1_digest: digest, loop_markdown_digest: digest, agent_bundle_digests: [digest], evidence_manifest_digest: digest, review_verdict: "PASS", residual_risks: ["Release authorization remains separate."], rollback: { target: "release-001", procedure: ["Restore the prior commit."], triggers: ["Verification regression."], estimated_recovery_minutes: 10 }, release_required_gates: ["hil"], recommended_release_actions: ["commit", "run-hil"], finalize_event_sequence: 10, digest },
  harness: { schema_version: 1, kind: "H0", loop_id: "loop-001", revision: 0, repository_id: "repository-001", repository_root: "C:/workspace", readable_paths: ["src/**"], repository_rules_digest: digest, explore_capabilities: ["native-search"], network_class: "DISABLED", denied_actions: ["push", "run-hil"], digest },
  "knowledge-proposal": { schema_version: 1, proposal_id: "proposal-001", proposal_type: "PROJECT_KNOWLEDGE", status: "PROVISIONAL", markdown_language: "en-US", source_loop_ids: ["loop-001"], source_handoff_digests: [digest], observation_count: 1, explicit_user_correction: false, correction_provenance: [], counterexamples: [], privacy_review: "No sensitive content is included.", expected_benefit: "Reduce repeated review work.", safety_impact: "No safety boundary changes.", offline_evaluation: ["Replay prior cases."], canary: ["Use in one child Loop."], rollback: ["Supersede the proposal."], review_date: "2026-08-06", implementation_loop_id: null, digest },
  loop: { schema_version: 2, loop_id: "loop-001", parent_loop_id: null, phase: "NEW", status: "ACTIVE", markdown_language: "en-US", last_event_sequence: 0, last_event_hash: "0".repeat(64), current_harness_revision: null, current_harness_digest: null, handoff_digest: null },
  manifest: { schema_version: 1, kind: "source", entries: [{ path: "src/index.ts", mode: "100644", digest, kind: "file" }], digest },
  preferences: { schema_version: 1, markdown_language: "en-US" },
  "project-policy": { schema_version: 1, risk_class: "HIGH", included_paths: ["src/**"], excluded_paths: [".ai-loop/**"], environment_gates: [{ gate_id: "hil", node: "HIL", owner: "RELEASE_REQUIRED", depends_on: [], evidence_ids: [], requires_new_action: true }], allowed_tools: ["typescript"], denied_actions: ["run-real-robot"], digest },
  release: { schema_version: 1, release_id: "release-001", loop_id: "loop-001", handoff_digest: digest, phase: "READY", action_envelope_digests: [], operation_ids: [], created_at: timestamp, updated_at: timestamp, release_commit_sha: null, digest },
  "release-harness": { schema_version: 1, kind: "RELEASE", release_id: "release-001", loop_id: "loop-001", handoff_digest: digest, allowed_actions: ["commit", "run-hil"], allowed_targets: ["bench-a"], allowed_tools: ["git", "hil-controller"], expires_at: "2026-08-06T01:00:00.000Z", digest },
  "wave-input": { schema_version: 1, loop_id: "loop-001", wave_id: "wave-001", base_sha: sha, source_manifest_digest: digest, tree_manifest_digest: digest, workspace_manifest_digest: digest, artifact_manifest_digest: digest, h1_policy_digest: digest, digest },
  "workflow-spec": workflow,
};

try {
  await mkdir(temporaryRoot, { recursive: true });
  await run(process.execPath, [
    resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "--ignoreConfig", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
    "--strict", "true", "--noUncheckedIndexedAccess", "true", "--exactOptionalPropertyTypes", "true",
    "--verbatimModuleSyntax", "true", "--types", "node", "--rootDir", repositoryRoot, "--outDir", temporaryRoot,
    resolve(repositoryRoot, "tooling", "schema-fixtures.ts"),
    resolve(repositoryRoot, "tooling", "english-contract.ts"),
  ]);
  const domain = await import(`${pathToFileURL(domainModulePath).href}?check=${Date.now()}`);
  const typedContracts = await import(`${pathToFileURL(fixtureModulePath).href}?check=${Date.now()}`);
  const englishContract = await import(`${pathToFileURL(englishContractModulePath).href}?check=${Date.now()}`);
  await writeFile(enumExportPath, JSON.stringify({ phases: domain.LOOP_PHASES, statuses: domain.LOOP_STATUSES }), "utf8");
  const enumExport = JSON.parse(await readFile(enumExportPath, "utf8"));
  const workflowSchema = records.find(({ name }) => name === "workflow-spec")?.schema;
  if (
    JSON.stringify(workflow.phases) !== JSON.stringify(enumExport.phases)
    || JSON.stringify(workflow.statuses) !== JSON.stringify(enumExport.statuses)
    || JSON.stringify(workflow.phases) !== JSON.stringify(workflowSchema?.properties?.phases?.const)
    || JSON.stringify(workflow.statuses) !== JSON.stringify(workflowSchema?.properties?.statuses?.const)
  ) {
    throw new Error("Workflow, TypeScript, and Schema phase/status enums differ.");
  }

  const harnessSchema = records.find(({ name }) => name === "harness")?.schema;
  const releaseSchema = records.find(({ name }) => name === "release")?.schema;
  const actionSchema = records.find(({ name }) => name === "action-envelope")?.schema;
  const preferencesSchema = records.find(({ name }) => name === "preferences")?.schema;
  const knowledgeSchema = records.find(({ name }) => name === "knowledge-proposal")?.schema;
  const manifestSchema = records.find(({ name }) => name === "manifest")?.schema;
  const evidenceSchema = records.find(({ name }) => name === "evidence")?.schema;
  const agentResultSchema = records.find(({ name }) => name === "agent-result")?.schema;
  const policySchema = records.find(({ name }) => name === "project-policy")?.schema;
  const schemaEnums = {
    loopPhase: workflow.phases,
    loopStatus: workflow.statuses,
    environmentNode: harnessSchema?.$defs?.gate?.properties?.node?.enum,
    gateOwner: harnessSchema?.$defs?.gate?.properties?.owner?.enum,
    enforcementClass: harnessSchema?.$defs?.capability?.properties?.enforcement?.enum,
    markdownLanguage: preferencesSchema?.properties?.markdown_language?.enum,
    releaseAction: actionSchema?.$defs?.releaseAction?.enum,
    releasePhase: releaseSchema?.properties?.phase?.enum,
    knowledgeProposalStatus: knowledgeSchema?.properties?.status?.enum,
    manifestKind: manifestSchema?.properties?.kind?.enum,
    manifestEntryKind: manifestSchema?.$defs?.entry?.properties?.kind?.enum,
    evidenceResult: evidenceSchema?.properties?.result?.enum,
    harnessKind: [harnessSchema?.$defs?.h0?.properties?.kind?.const, harnessSchema?.$defs?.h1?.properties?.kind?.const],
    networkClass: harnessSchema?.$defs?.h0?.properties?.network_class?.enum,
    agentResultStatus: agentResultSchema?.properties?.status?.enum,
    projectRiskClass: policySchema?.properties?.risk_class?.enum,
    knowledgeProposalType: knowledgeSchema?.properties?.proposal_type?.enum,
    physicalEnvironmentNode: actionSchema?.$defs?.physical?.properties?.environment_node?.enum,
  };
  if (JSON.stringify(schemaEnums) !== JSON.stringify(typedContracts.contractEnums)) {
    throw new Error("TypeScript and Schema enum contracts differ.");
  }

  await run(process.execPath, [resolve(repositoryRoot, "tooling", "generate-validators.mjs"), validatorsPath]);
  const generated = (await import(`${pathToFileURL(validatorsPath).href}?check=${Date.now()}`)).default;
  if (JSON.stringify(Object.keys(generated).sort()) !== JSON.stringify(expectedNames)) {
    throw new Error("Generated validator map does not match the Schema family.");
  }

  englishContract.assertPluginAuthoredEnglish(validFixtures);
  englishContract.assertPluginAuthoredEnglish(typedContracts.typedSchemaFixtures);
  let cjkRejected = false;
  try {
    englishContract.assertPluginAuthoredEnglish({ "agent-result": { summary: "unsafe \u4e2d\u6587" } });
  } catch {
    cjkRejected = true;
  }
  if (!cjkRejected) throw new Error("English-only fixture enforcement did not reject CJK text.");

  for (const name of expectedNames) {
    const fixture = validFixtures[name];
    const validate = generated[name];
    if (!validate(fixture)) throw new Error(`Generated validator rejected valid ${name}: ${JSON.stringify(validate.errors)}`);
    if (validate({ ...fixture, unexpected: true })) throw new Error(`Generated validator accepted an open ${name} record.`);
  }

  for (const [name, fixtures] of Object.entries(typedContracts.typedSchemaFixtures)) {
    const validate = generated[name];
    for (const fixture of fixtures) {
      if (!validate(fixture)) throw new Error(`Generated validator rejected typed ${name}: ${JSON.stringify(validate.errors)}`);
      for (const key of Object.keys(fixture)) {
        const missing = { ...fixture };
        delete missing[key];
        if (validate(missing)) throw new Error(`Schema ${name} does not require TypeScript field ${key}.`);
      }
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("schema:check PASS: 18 Schemas compiled; TypeScript enums/required fields, union branches, workflow parity, strictness, references, generated validators, and English-only fixtures confirmed.");
