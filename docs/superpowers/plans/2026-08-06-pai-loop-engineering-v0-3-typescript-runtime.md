# PI Loop Engineering v0.3 TypeScript Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the clean-break `pi-loop-engineering` v0.3 plugin with four public commands, a strict TypeScript control plane, committed deterministic JavaScript ESM runtime, bounded Sub-agent dispatch, immutable Handoff, independently authorized Release, and proposal-only Knowledge Evolution for Physical AI.

**Architecture:** Keep `src/` as the only hand-maintained control-plane source and commit reproducible, unbundled ESM output under `dist/`. Route every persisted mutation through validated contracts, the Runtime Gate, fixed-order Repository/Loop coordination, and a short WAL transaction; bind execution to H0/H1 Harnesses, content-addressed manifests, fencing tokens, evidence, independent Review, and a single immutable Final Handoff. Release and Knowledge Evolution consume completed Handoffs through separate lifecycles and cannot expand Loop authority.

**Tech Stack:** Node.js `>=22`; TypeScript `7.0.2` in strict/NodeNext mode; `@types/node` `22.20.1`; Ajv `8.20.0` used only at build time for JSON Schema Draft 2020-12 standalone ESM validators; Node built-in test runner; Git CLI; Markdown Skills; TOML Agent profiles.

**Execution Note:** The user approved the 2026-08-06 SDD preflight corrections: test/build scaffolding precedes the first product RED, aggregate npm gates grow only when their components exist, and physical gates distinguish existing immutable evidence from actions that require fresh Release authority.

## Global Constraints

- Clean break: retain no aliases, Tombstones, state migrations, Python Runtime, Python tests, Shell fallback, or dual-runtime bridge.
- Public commands are exactly `$loop-engineering`, `$status`, `$release`, and `$knowledge-evolution`.
- Persistent Loop paths are exactly `.ai-loop/loop/<loop-id>/LOOP.json` and `.ai-loop/loop/<loop-id>/LOOP.md`; public contracts use complete Loop naming.
- `src/` is the only hand-maintained control-plane implementation; `dist/` is committed, unbundled, unminified JavaScript ESM.
- Published runtime requirements are Node.js `>=22` and Node built-ins only; `package.json` has no `dependencies` entry.
- `package-lock.json` pins TypeScript `7.0.2`, `@types/node` `22.20.1`, and Ajv `8.20.0` as development dependencies.
- Only persisted Markdown supports `en-US` and `zh-CN`; `en-US` is the fixed default. Plugin-generated JSON, JSONL, Schema, Harness, Envelope, Evidence metadata, and other non-Markdown strings are English-only.
- Raw user input, source excerpts, stdout/stderr, compiler output, simulation output, and device logs remain opaque/verbatim bytes and are never silently translated.
- CodeGraph is optional unless repository instructions require it; never initialize a missing index.
- No current H1 means no controller-mediated source write, write-capable Sub-agent dispatch, protected transition, Finalize, or Handoff.
- Runtime enforcement claims must be one of `HOST_ENFORCED`, `RUNTIME_ENFORCED`, or `ORCHESTRATION_ONLY`; never claim plugin-level OS isolation.
- Parallel writers require a persistent Loop, acyclic DAG, disjoint declared read/write sets, identical WaveInput, independent Worktrees, cross-Loop leases, bounded attempts, fencing, sealed results, and freshness checks. Unknown read sets serialize.
- Repository locks are short transactions only and follow Repository Coordinator then Loop ordering; no lock remains held while an Agent or external action runs.
- Release readiness is read-only. Commit, push, PR, tag, publish, deploy, HIL, and robot actions require an exact action, target, immutable fresh Handoff, unexpired Action Envelope, and scoped authorization; physical actions require fresh confirmation.
- Knowledge Evolution writes proposals only; applying an approved proposal requires a new Loop and Handoff.
- Windows, Linux, and macOS run the same core suite on Node 22 and Node 24 LTS; real symlink tests skip only when the host cannot create symlinks.
- Preserve AGPL-3.0-only licensing and the repository's dual-license notice in every new Skill and Agent source.
- Never stage the current dirty Python work as content. Task 1 removes the exact obsolete Python control plane before the first implementation commit, so Git records only clean-break deletions.

## File Responsibility Map

- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.test.json`: locked ESM build and test contract.
- `tooling/build.mjs`: generate standalone validators, compile TypeScript, normalize source maps, and write only to an explicitly supplied output root.
- `tooling/test.mjs`: compile TypeScript tests to a disposable root and invoke `node --test` with argv arrays.
- `tooling/check-dist.mjs`: rebuild into a temporary root and byte-compare its file inventory with committed `dist/`.
- `tooling/schema-check.mjs`: validate Schema references, standalone validators, workflow/type enum parity, and English-only machine-contract strings.
- `src/contracts/domain.ts`: shared branded IDs, digests, phase/status/error enums, events, evidence, findings, manifests, and environment DAG types.
- `src/contracts/harness.ts`: H0/H1, WaveInput policy, gates, enforcement classes, actor/capability/budget/stop contracts.
- `src/contracts/dispatch.ts`: work items, leases, attempts, request/result envelopes, sealed bundles, and integration records.
- `src/contracts/release.ts`: Handoff, Release, Action Envelope, authorization, operation, and Knowledge Proposal contracts.
- `src/core/schema.ts`: the only runtime entry to generated standalone validators.
- `src/core/paths.ts`: canonical workspace/Git roots, `.ai-loop` layout, Loop ID validation, path containment, and platform case rules.
- `src/core/markdown.ts`: locale resolution plus deterministic `LOOP.md` and Knowledge Proposal rendering.
- `src/core/atomic-json.ts`: canonical UTF-8 JSON, durable atomic replacement, JSONL append, directory-fsync capability reporting, and fault injection seams.
- `src/core/lock.ts`: atomic lock-directory ownership, expiry, monotonic fencing, explicit Reconcile, and fixed-order helpers.
- `src/core/ledger.ts`: hash-chained events, WAL Intent/Commit transactions, CAS replay, snapshot rebuild, transition validation, and Checkpoints.
- `src/core/manifests.ts`: Source/Tree/Workspace/Runtime/Artifact manifests, inclusion rules, dirty WaveInput capture, and evidence process execution.
- `src/core/harness.ts`: H0/H1 forge/seal/revision/drift, Physical AI environment DAG, and Runtime Gate decisions.
- `src/core/coordinator.ts`: canonical Git common-dir coordination state and cross-Loop branch/path/integration leases.
- `src/core/dispatch.ts`: DAG admission, Wave reservation, bounded attempts, sealed AgentResult validation, stale-result checks, and reconciliation.
- `src/core/review.ts`: risk classification, independent Reviewer admission, Finding ownership, verdict aggregation, and non-convergence.
- `src/core/handoff.ts`: Checkpoint construction, transactional Finalize, immutable Handoff, freshness, and Child Loop requirements.
- `src/core/release.ts`: read-only readiness, Release Harness, Action Envelopes, commit packaging, operation reconciliation, and physical-action authorization.
- `src/core/knowledge.ts`: completed-source selection, proposal construction, review states, approval boundary, and applied-by-Loop linkage.
- `src/cli/loopctl.ts`: thin validated Loop/Harness/Dispatch/Review/Handoff CLI.
- `src/cli/releasectl.ts`: thin validated readiness/action/reconcile CLI.
- `src/cli/knowledgectl.ts`: thin validated proposal CLI.
- `src/cli/triggerctl.ts`: side-effect-free five-intent classifier exposing only four public Skills.
- `src/cli/codegraphctl.ts`: existing-index capability resolver and sync; no initialization path.
- `src/cli/sync-agents.ts`: deterministic Agent profile to Skill metadata synchronization.
- `src/cli/validate-plugin.ts`: clean-break, manifest, Skill, Agent, Schema, link, runtime-dependency, and `dist` delivery gate.
- `schemas/*.schema.json`: external Draft 2020-12 machine contracts.
- `assets/loop-engineering/workflow-spec.json`: lifecycle v2 transition and gate table.
- `assets/router/trigger-policy.json`: shared explicit/implicit routing policy outside `skills/`.
- `assets/loop-engineering/{workflow,review}.md` and `templates/LOOP.{en-US,zh-CN}.md`: closed-loop instructions, internal Review, and the only localized Loop templates.
- `test/unit/**/*.test.ts`, `test/cli/**/*.test.ts`, `test/faults/**/*.test.ts`: focused behavior, real `dist/` entry-point, and crash-boundary suites.

---

### Task 1: TypeScript/ESM Build Trust Root and Python Clean Break

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `tooling/build.mjs`
- Create: `tooling/test.mjs`
- Create: `tooling/check-dist.mjs`
- Create: `src/contracts/domain.ts`
- Create: `test/unit/domain.test.ts`
- Modify: `.gitignore`
- Delete: `scripts/codegraphctl.py`
- Delete: `scripts/loopctl.py`
- Delete: `scripts/sync_agents.py`
- Delete: `scripts/triggerctl.py`
- Delete: `scripts/pi_loop/__init__.py`
- Delete: `scripts/pi_loop/errors.py`
- Delete: `scripts/pi_loop/file_lock.py`
- Delete: `scripts/pi_loop/jsonio.py`
- Delete: `tests/test_codegraphctl.py`
- Delete: `tests/test_file_lock.py`
- Delete: `tests/test_jsonio.py`
- Delete: `tests/test_loopctl.py`
- Delete: `tests/test_plugin_contract.py`
- Delete: `tests/test_sync_agents.py`
- Delete: `tests/test_triggerctl.py`
- Delete: `tests/trigger-cases.json`

**Interfaces:**
- Consumes: Node.js `>=22` and Git; no existing runtime API.
- Produces: `Digest`, `LoopId`, `LoopErrorCode`, `LoopError`, `sha256Hex(data: Uint8Array | string): Digest`, deterministic `npm run build`/`npm run check:dist`, and grouped TypeScript test execution.

- [ ] **Step 1: Establish the locked build/test configuration and write the first failing domain test**

```json
{
  "name": "pi-loop-engineering",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "node tooling/build.mjs dist",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test:unit": "node tooling/test.mjs unit",
    "check:dist": "node tooling/check-dist.mjs",
    "test": "npm run typecheck && npm run test:unit && npm run check:dist"
  },
  "devDependencies": {
    "@types/node": "22.20.1",
    "ajv": "8.20.0",
    "typescript": "7.0.2"
  }
}
```

Use `module`/`moduleResolution` `NodeNext`, `target` `ES2022`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `rootDir: "src"`, `outDir: "dist"`, `declaration: false`, and source maps. The test config extends it with `rootDir: "."` and `outDir: ".test-dist"`. Add `node_modules/`, `.test-dist/`, and `*.tmp-*` to `.gitignore`. Generate `package-lock.json` with:

```powershell
npm install --package-lock-only --ignore-scripts
```

Implement `tooling/test.mjs`, `tooling/build.mjs`, and `tooling/check-dist.mjs` now as approved test/build scaffolding; these tools are required to produce a meaningful RED and are not product runtime behavior. `tooling/test.mjs` must remove only the resolved repository-local `.test-dist` directory, compile with the local `node_modules/typescript/bin/tsc`, enumerate `.test-dist/test/<group>/**/*.test.js` in sorted order, and spawn `process.execPath` with `["--test", ...files, ...forwardedArgs]`. `tooling/build.mjs` accepts one repository-relative output root, rejects the repository root and paths outside it, deletes that exact output, invokes the local compiler with `["-p", "tsconfig.json", "--outDir", output]`, normalizes source map `sourceRoot` to `""`, and never invokes a shell. `tooling/check-dist.mjs` builds into `.dist-check-<nonce>`, compares sorted relative paths and bytes with `dist/`, and always removes that exact temp root.

Then write the first product test:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { LoopError, sha256Hex } from "../../src/contracts/domain.js";

test("LoopError carries a stable English code and details", () => {
  const error = new LoopError("INVALID_LOOP_ID", "Loop ID is invalid.", { value: "../bad" });
  assert.equal(error.code, "INVALID_LOOP_ID");
  assert.deepEqual(error.details, { value: "../bad" });
});

test("sha256Hex returns a branded lowercase digest", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
```

- [ ] **Step 2: Run the focused test and verify the contract is absent**

Run: `npm run test:unit -- --test-name-pattern "LoopError|sha256Hex"`

Expected: RED because `src/contracts/domain.ts` is absent; the test runner itself starts successfully, and the failure is specifically the missing product contract rather than missing infrastructure.

- [ ] **Step 3: Implement the domain error primitive and remove the Python runtime**

```ts
import { createHash } from "node:crypto";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type Digest = Brand<string, "Digest">;
export type LoopId = Brand<string, "LoopId">;

export type LoopErrorCode =
  | "INVALID_LOOP_ID"
  | "INVALID_MARKDOWN_LANGUAGE"
  | "SCHEMA_INVALID"
  | "LOCK_BUSY"
  | "RECONCILE_REQUIRED"
  | "CAS_MISMATCH"
  | "INVALID_TRANSITION"
  | "HARNESS_REQUIRED"
  | "HARNESS_DRIFT"
  | "DISPATCH_REJECTED"
  | "STALE_AGENT_RESULT"
  | "STALE_HANDOFF"
  | "AUTHORIZATION_REQUIRED"
  | "NON_CONVERGENT";

export class LoopError extends Error {
  constructor(
    readonly code: LoopErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "LoopError";
  }
}

export function sha256Hex(data: Uint8Array | string): Digest {
  return createHash("sha256").update(data).digest("hex") as Digest;
}
```

Remove the exact Python files listed above with patch deletions. Do not stage any Python content before deletion.

- [ ] **Step 4: Verify the foundation and reproducible output**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run test:unit`

Expected: 2 tests PASS.

Run: `npm run build && npm run check:dist`

Expected: PASS; `dist/contracts/domain.js` is ordinary ESM and rebuilding is byte-identical.

Run: `rg --files -g "*.py" -g "test_*.py"`

Expected: no output.

- [ ] **Step 5: Commit only the clean-break foundation**

```powershell
git add .gitignore package.json package-lock.json tsconfig.json tsconfig.test.json tooling src/contracts/domain.ts test/unit/domain.test.ts dist scripts tests
git diff --cached --check
git commit -m "build: establish TypeScript runtime foundation"
```

---

### Task 2: Strict Contracts, Workflow Spec v2, and Standalone Schema Validators

**Files:**
- Create: `src/contracts/harness.ts`
- Create: `src/contracts/dispatch.ts`
- Create: `src/contracts/release.ts`
- Create: `src/core/schema.ts`
- Create: `src/generated/validators.d.ts`
- Create: `tooling/generate-validators.mjs`
- Create: `tooling/schema-check.mjs`
- Create: `schemas/workflow-spec.schema.json`
- Create: `schemas/loop.schema.json`
- Create: `schemas/event.schema.json`
- Create: `schemas/manifest.schema.json`
- Create: `schemas/evidence.schema.json`
- Create: `schemas/harness.schema.json`
- Create: `schemas/wave-input.schema.json`
- Create: `schemas/agent-request.schema.json`
- Create: `schemas/agent-result.schema.json`
- Create: `schemas/agent-bundle.schema.json`
- Create: `schemas/checkpoint.schema.json`
- Create: `schemas/handoff.schema.json`
- Create: `schemas/release.schema.json`
- Create: `schemas/release-harness.schema.json`
- Create: `schemas/action-envelope.schema.json`
- Create: `schemas/preferences.schema.json`
- Create: `schemas/project-policy.schema.json`
- Create: `schemas/knowledge-proposal.schema.json`
- Create: `assets/loop-engineering/workflow-spec.json`
- Create: `test/unit/schema.test.ts`
- Delete: `schemas/run-state.schema.json`
- Modify: `package.json`
- Modify: `tooling/build.mjs`
- Modify: `tooling/test.mjs`

**Interfaces:**
- Consumes: `Digest`, `LoopId`, `LoopError`, and `sha256Hex` from Task 1.
- Produces: the domain unions below; `SchemaName`; `validateSchema<T>(name: SchemaName, value: unknown): T`; `assertWorkflowParity(): void`; generated `dist/generated/validators.js` with one named validator per Schema.

- [ ] **Step 1: Write failing parity, strictness, and English-contract tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../../assets/loop-engineering/workflow-spec.json" with { type: "json" };
import { LOOP_PHASES, LOOP_STATUSES } from "../../src/contracts/domain.js";
import { assertWorkflowParity, validateSchema } from "../../src/core/schema.js";

test("workflow v2 and TypeScript unions contain the same phases and statuses", () => {
  assert.deepEqual([...workflow.phases].sort(), [...LOOP_PHASES].sort());
  assert.deepEqual([...workflow.statuses].sort(), [...LOOP_STATUSES].sort());
  assert.doesNotThrow(assertWorkflowParity);
});

test("Loop schema rejects unknown properties and old Run vocabulary", () => {
  assert.throws(
    () => validateSchema("loop", { schema_version: 2, run_id: "legacy", unexpected: true }),
    /SCHEMA_INVALID/,
  );
});
```

- [ ] **Step 2: Run the focused tests and confirm missing contracts/generator**

Run: `npm run test:unit -- --test-name-pattern "workflow v2|Loop schema"`

Expected: FAIL because the workflow v2 document, contracts, and generated validators do not exist.

- [ ] **Step 3: Define the complete discriminated contracts and strict Schema family**

Add these exact constants to `domain.ts`:

```ts
export const LOOP_PHASES = [
  "NEW", "ORIENTING", "CONTRACTED", "PLANNED", "PLAN_REVIEW", "HARNESSING",
  "IMPLEMENTING", "VERIFYING", "REVIEWING", "REMEDIATING", "FINALIZING",
  "HANDOFF_READY", "CANCELLED",
] as const;
export type LoopPhase = (typeof LOOP_PHASES)[number];

export const LOOP_STATUSES = [
  "ACTIVE", "DEGRADED", "PAUSED", "BLOCKED", "NON_CONVERGENT", "COMPLETE", "CANCELLED",
] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export const ENVIRONMENT_NODES = [
  "SOURCE_STATIC", "UNIT_COMPONENT", "REPLAY", "SIMULATION", "SIL", "HIL",
  "BENCH", "CLOSED_COURSE", "REAL_VEHICLE_ROBOT",
] as const;
export type EnvironmentNode = (typeof ENVIRONMENT_NODES)[number];
export type GateOwner = "LOOP_REQUIRED" | "RELEASE_REQUIRED" | "NOT_APPLICABLE";
export type EnforcementClass = "HOST_ENFORCED" | "RUNTIME_ENFORCED" | "ORCHESTRATION_ONLY";
```

The contract files define, without `any`:

```ts
export interface ManifestEntry { path: string; mode: string; digest: Digest; kind: "file" | "symlink" | "submodule" | "external"; provenance?: string }
export interface ContentManifest { schema_version: 1; kind: "source" | "tree" | "workspace" | "runtime" | "artifact"; entries: readonly ManifestEntry[]; digest: Digest }
export interface EvidenceRecord { schema_version: 1; evidence_id: string; loop_id: LoopId; work_item_id: string; attempt: number; actor_role: string; h1_digest: Digest; wave_input_digest: Digest; output_tree_digest: Digest; argv: readonly string[]; cwd: string; started_at: string; ended_at: string; exit_code: number | null; environment_digest: Digest; tool_versions: Readonly<Record<string, string>>; stdout_path: string; stdout_digest: Digest; stderr_path: string; stderr_digest: Digest; artifact_manifest_digest: Digest; result: "PASS" | "FAIL" | "PRE_EXISTING" | "NOT_RUN" }
export interface GateRequirement { gate_id: string; node: EnvironmentNode; owner: GateOwner; depends_on: readonly string[]; evidence_ids: readonly string[]; requires_new_action: boolean; not_applicable_reason?: string }
export interface ScopedAuthorization { authorization_id: string; action: ReleaseAction; target: string; environment_node: EnvironmentNode | null; authorized_by: string; authorized_at: string; expires_at: string; digest: Digest }
export type ReleaseAction = "commit" | "push" | "pr" | "tag" | "publish" | "deploy-sim" | "run-hil" | "deploy-robot" | "run-real-robot";
interface ActionEnvelopeBase { schema_version: 1; operation_id: string; release_id: string; handoff_digest: Digest; target: string; source_head_sha: string; reviewed_tree_digest: Digest; authorization: ScopedAuthorization; metadata_digest: Digest }
export interface CommitActionEnvelope extends ActionEnvelopeBase { action: "commit"; expected_parent_sha: string; branch: string }
export interface ExternalActionEnvelope extends ActionEnvelopeBase { action: "push" | "pr" | "tag" | "publish" | "deploy-sim"; release_commit_sha: string }
export interface PhysicalActionEnvelope extends ActionEnvelopeBase { action: "run-hil" | "deploy-robot" | "run-real-robot"; release_commit_sha: string; environment_node: "HIL" | "BENCH" | "CLOSED_COURSE" | "REAL_VEHICLE_ROBOT" }
export type ActionEnvelope = CommitActionEnvelope | ExternalActionEnvelope | PhysicalActionEnvelope;
```

Every Schema uses Draft 2020-12, a `https://pi-loop-engineering.local/schemas/<name>.schema.json` ID, `additionalProperties: false` at record boundaries, and required fields matching the TypeScript interfaces. `workflow-spec.json` has `schema_version: 2`, the exact phase/status arrays above, every legal edge from the approved state diagram, a cancel edge from every nonterminal phase, no outgoing edge from `CANCELLED` or `HANDOFF_READY`, and gate tables for Low/Medium/High risk.

- [ ] **Step 4: Generate standalone ESM validators and expose one runtime validation API**

`tooling/generate-validators.mjs` imports `ajv/dist/2020.js` and `ajv/dist/standalone/index.js`, loads every sorted Schema file, compiles them with `{ allErrors: true, strict: true, code: { esm: true, source: true } }`, and asks Ajv standalone for stable camelCase named exports. It appends a sorted default map such as `{ "workflow-spec": workflowSpec, "loop": loop, ... }` so `schema.ts` has one lookup contract, then writes the deterministic module to the exact output argument. `src/generated/validators.d.ts` declares `StandaloneValidate = ((data: unknown) => boolean) & { errors?: readonly unknown[] | null }` and the default `Readonly<Record<string, StandaloneValidate>>` map. `build.mjs` generates `<out>/generated/validators.js` before invoking TypeScript. `test.mjs` generates the same module at `.test-dist/src/generated/validators.js` before compiling/running tests.

Extend `package.json` only when this task's Schema gate exists:

```json
{
  "scripts": {
    "schema:check": "node tooling/schema-check.mjs",
    "test": "npm run typecheck && npm run schema:check && npm run test:unit && npm run check:dist"
  }
}
```

```ts
import validators from "../generated/validators.js";
import { LoopError } from "../contracts/domain.js";

export type SchemaName =
  | "workflow-spec" | "loop" | "event" | "manifest" | "evidence" | "harness"
  | "wave-input" | "agent-request" | "agent-result" | "agent-bundle"
  | "checkpoint" | "handoff" | "release" | "release-harness"
  | "action-envelope" | "preferences" | "project-policy" | "knowledge-proposal";

export function validateSchema<T>(name: SchemaName, value: unknown): T {
  const validate = validators[name];
  if (!validate(value)) {
    throw new LoopError("SCHEMA_INVALID", "Machine contract validation failed.", {
      schema: name,
      errors: validate.errors ?? [],
    });
  }
  return value as T;
}
```

`schema-check.mjs` validates all `$ref` targets, compiles all Schemas, invokes the generated validators against valid/invalid fixtures, compares workflow enums to a small generated JSON export from the TypeScript constants, and rejects CJK characters in plugin-authored non-Markdown fixture strings.

- [ ] **Step 5: Verify all contract layers agree**

Run: `npm run schema:check`

Expected: PASS with 18 Schemas compiled and parity confirmed.

Run: `npm run typecheck && npm run test:unit && npm run build && npm run check:dist`

Expected: PASS; `dist/generated/validators.js` imports no Ajv runtime module.

- [ ] **Step 6: Commit the v2 contract surface**

```powershell
git add src/contracts src/core/schema.ts src/generated tooling schemas assets/loop-engineering/workflow-spec.json test/unit/schema.test.ts dist
git diff --cached --check
git commit -m "feat: define Loop v2 machine contracts"
```

---

### Task 3: Canonical Paths, Markdown-Only Localization, and Durable Atomic I/O

**Files:**
- Create: `src/core/paths.ts`
- Create: `src/core/markdown.ts`
- Create: `src/core/atomic-json.ts`
- Create: `assets/loop-engineering/templates/LOOP.en-US.md`
- Create: `assets/loop-engineering/templates/LOOP.zh-CN.md`
- Create: `test/unit/paths.test.ts`
- Create: `test/unit/markdown.test.ts`
- Create: `test/unit/atomic-json.test.ts`
- Create: `test/faults/atomic-json.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `LoopId`, `Digest`, `LoopError`, `validateSchema`, and `ContentManifest`.
- Produces: `parseLoopId(value: string): LoopId`; `resolveLayout(workspace: string, loopId?: LoopId): LoopLayout`; `resolveCoordinationRoot(workspace: string): Promise<string>`; `assertContained(root: string, candidate: string): Promise<string>`; `resolveMarkdownLanguage(input: LanguageInput): Promise<MarkdownLanguage>`; `renderLoopMarkdown(facts: LoopNarrativeFacts, language: MarkdownLanguage): string`; `canonicalJsonBytes(value: unknown): Uint8Array`; `atomicWriteFile(path: string, data: Uint8Array, hooks?: AtomicWriteHooks): Promise<DurabilityResult>`; `atomicWriteJson(path: string, value: unknown, hooks?: AtomicWriteHooks): Promise<DurabilityResult>`; `appendJsonLine(path: string, value: unknown): Promise<void>`.

- [ ] **Step 1: Write failing path, language, and crash-safety tests**

```ts
test("layout uses complete Loop paths and rejects traversal", async () => {
  const id = parseLoopId("loop-001");
  assert.match(resolveLayout(root, id).loopJson, /\.ai-loop[\\/]loop[\\/]loop-001[\\/]LOOP\.json$/);
  assert.throws(() => parseLoopId("../escape"), /INVALID_LOOP_ID/);
});

test("language priority is explicit then preferences then en-US", async () => {
  await writePreferences(root, { markdown_language: "zh-CN" });
  assert.equal(await resolveMarkdownLanguage({ workspace: root }), "zh-CN");
  assert.equal(await resolveMarkdownLanguage({ workspace: root, explicit: "en-US" }), "en-US");
  assert.equal(await resolveMarkdownLanguage({ workspace: emptyRoot }), "en-US");
});

test("failed rename preserves the previous JSON value", async () => {
  await atomicWriteJson(target, { sequence: 1 });
  await assert.rejects(
    atomicWriteJson(target, { sequence: 2 }, { beforeRename: () => { throw new Error("injected"); } }),
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { sequence: 1 });
});
```

- [ ] **Step 2: Run tests and confirm missing storage primitives**

Run: `npm run test:unit -- --test-name-pattern "layout uses|language priority|failed rename"`

Expected: FAIL because `paths.ts`, `markdown.ts`, and `atomic-json.ts` do not exist.

- [ ] **Step 3: Implement canonical layout and locale resolution**

`parseLoopId` accepts `^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$` only. `resolveCoordinationRoot` executes `git rev-parse --path-format=absolute --git-common-dir` with argv arrays; Git worktrees share `<common-dir>/pi-loop-engineering/coordination`, while non-Git workspaces use `<workspace>/.ai-loop/coordination`. `assertContained` resolves real parents, applies Windows case-folding only on Windows, rejects symlink escape, and returns a native absolute path.

```ts
export type MarkdownLanguage = "en-US" | "zh-CN";
export interface LanguageInput {
  workspace: string;
  explicit?: string;
  requestInstruction?: MarkdownLanguage;
}

export async function resolveMarkdownLanguage(input: LanguageInput): Promise<MarkdownLanguage> {
  const candidate = input.explicit ?? input.requestInstruction ?? await readPreference(input.workspace) ?? "en-US";
  if (candidate !== "en-US" && candidate !== "zh-CN") {
    throw new LoopError("INVALID_MARKDOWN_LANGUAGE", "Supported Markdown languages are en-US and zh-CN.", { value: candidate });
  }
  return candidate;
}
```

Both templates contain the stable headings `[S1]`, `[S2]`, `[S3]`, `Tasks`, `Report`, `Verification`, `Review and Residual Risk`, and `Journey Log`; the Chinese file translates prose/headings but never IDs, enum values, paths, or evidence digests.

- [ ] **Step 4: Implement canonical JSON and durable atomic replacement**

`canonicalJsonBytes` recursively sorts object keys, preserves array order, rejects `undefined`, non-finite numbers, and non-JSON objects, emits UTF-8 with one trailing newline, and never locale-sorts. `atomicWriteFile` creates a same-directory `.<name>.tmp-<nonce>` with `wx`, writes all bytes, calls file `sync()`, closes, runs the fault hook, renames, and attempts directory fsync; `DurabilityResult.directorySync` is `"SYNCED"` or `"UNSUPPORTED"`. It never reports unsupported Windows directory sync as success.

```ts
export interface AtomicWriteHooks {
  afterTempSync?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
}
export interface DurabilityResult {
  fileSync: "SYNCED";
  directorySync: "SYNCED" | "UNSUPPORTED";
}
```

`appendJsonLine` opens with append mode, writes exactly one canonical compact UTF-8 line under the caller's lock, syncs, and closes. It rejects embedded plugin-generated non-English narrative through a separate `assertEnglishMachineStrings` check while exempting fields explicitly typed as opaque evidence.

Add the first fault-suite script now that a fault test exists, and extend the aggregate without referring to future CLI or plugin-validator tasks:

```json
{
  "scripts": {
    "test:faults": "node tooling/test.mjs faults",
    "test": "npm run typecheck && npm run schema:check && npm run test:unit && npm run test:faults && npm run check:dist"
  }
}
```

- [ ] **Step 5: Verify locale equivalence and all atomic boundaries**

Run: `npm run test:unit -- --test-name-pattern "layout|language|Markdown|atomic"`

Expected: PASS.

Run: `npm run test:faults -- --test-name-pattern "atomic JSON"`

Expected: PASS for failures after temp sync, before rename, and after rename; recovery sees either the old or complete new value, never partial JSON.

- [ ] **Step 6: Commit storage and localization**

```powershell
git add src/core/paths.ts src/core/markdown.ts src/core/atomic-json.ts assets/loop-engineering/templates test/unit test/faults dist
git diff --cached --check
git commit -m "feat: add durable Loop storage primitives"
```

---

### Task 4: Lock-Directory Fencing and Transactional Loop Ledger

**Files:**
- Create: `src/core/lock.ts`
- Create: `src/core/ledger.ts`
- Create: `test/unit/lock.test.ts`
- Create: `test/unit/ledger.test.ts`
- Create: `test/faults/ledger-recovery.test.ts`

**Interfaces:**
- Consumes: Task 3 path and atomic I/O APIs; `LoopPhase`, `LoopStatus`, `Digest`, `LoopError`; `validateSchema`.
- Produces: `acquireLock(options: AcquireLockOptions): Promise<LockLease>`; `reconcileLock(options: ReconcileLockOptions): Promise<LockReconciliation>`; `withOrderedLocks<T>(repository: LockTarget, loop: LockTarget | undefined, action: (leases: readonly LockLease[]) => Promise<T>): Promise<T>`; `openLedger(layout: LoopLayout): Promise<LoopLedger>`; `LoopLedger.transact<T>(kind: TransactionKind, expected: LedgerCursor, writeArtifact: (transactionId: string) => Promise<T>): Promise<CommittedTransaction<T>>`; `LoopLedger.transition(to: LoopPhase, status: LoopStatus, expected: LedgerCursor): Promise<LoopSnapshot>`; `LoopLedger.recover(): Promise<RecoveryReport>`.

- [ ] **Step 1: Write failing concurrency, fencing, transition, and WAL recovery tests**

```ts
test("expired lock cannot be stolen without reconcile and stale fence cannot write", async () => {
  const first = await acquireLock({ target: lockDir, ownerId: "one", ttlMs: 1, clock });
  clock.advance(2);
  await assert.rejects(acquireLock({ target: lockDir, ownerId: "two", ttlMs: 100, clock }), /RECONCILE_REQUIRED/);
  const reconciliation = await reconcileLock({ target: lockDir, expectedNonce: first.owner.nonce, clock });
  const second = await acquireLock({ target: lockDir, ownerId: "two", ttlMs: 100, clock });
  assert.ok(second.owner.fencingToken > first.owner.fencingToken);
  await assert.rejects(first.assertCurrent(), /CAS_MISMATCH/);
  assert.equal(reconciliation.outcome, "EXPIRED_OWNER_FENCED");
});

test("recovery consumes only artifacts with matching COMMIT events", async () => {
  await injectFinalizeCrash(ledger, "after-artifact-rename");
  const report = await ledger.recover();
  assert.equal(report.quarantinedArtifacts.length, 1);
  assert.equal((await ledger.snapshot()).phase, "FINALIZING");
});
```

- [ ] **Step 2: Run tests and confirm the lock/ledger API is missing**

Run: `npm run test:unit -- --test-name-pattern "expired lock|recovery consumes"`

Expected: FAIL because `lock.ts` and `ledger.ts` do not exist.

- [ ] **Step 3: Implement atomic lock directories with explicit Reconcile**

`acquireLock` creates `<target>.lock` atomically, persists `owner.json` containing `ownerId`, random nonce, PID, ISO timestamps, and a monotonic fencing token allocated under the parent fence lock. An existing unexpired owner returns `LOCK_BUSY`. An expired or malformed owner returns `RECONCILE_REQUIRED` and is never overwritten. `reconcileLock` re-reads owner and nonce, records a reconciliation result, renames the stale lock to a quarantined name, and then permits a new acquire. `release` deletes only when owner nonce and fencing token still match. `withOrderedLocks` rejects a Loop-before-Repository request.

```ts
export interface LockOwner {
  ownerId: string;
  nonce: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
  fencingToken: number;
}
export interface LockLease {
  readonly target: string;
  readonly owner: LockOwner;
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}
```

- [ ] **Step 4: Implement hash-chained WAL transactions and exact lifecycle rules**

Events use canonical payload bytes and `hash = SHA256(previous_hash + canonical(event_without_hash))`. A transaction appends `<KIND>_INTENT` with expected sequence/hash/digest, writes and validates a pending artifact, fsyncs and renames it, appends `<KIND>_COMMIT`, then atomically replaces `LOOP.json`. Replay treats committed events as truth, rebuilds snapshots, completes only provably idempotent work, and quarantines unmatched artifacts.

`workflow-spec.json` drives transitions. `PAUSED`, `BLOCKED`, and `DEGRADED` preserve phase; `NON_CONVERGENT` preserves the last checkpoint and terminates resume; cancel sets phase/status to `CANCELLED`; `HANDOFF_READY + COMPLETE` and `CANCELLED` are closed.

```ts
export interface LedgerCursor { sequence: number; eventHash: Digest; snapshotDigest: Digest }
export interface LoopSnapshot {
  schema_version: 2;
  loop_id: LoopId;
  parent_loop_id: LoopId | null;
  phase: LoopPhase;
  status: LoopStatus;
  markdown_language: "en-US" | "zh-CN";
  last_event_sequence: number;
  last_event_hash: Digest;
  current_harness_revision: number | null;
  current_harness_digest: Digest | null;
  handoff_digest: Digest | null;
}
```

- [ ] **Step 5: Verify concurrency and every transaction crash boundary**

Run: `npm run test:unit -- --test-name-pattern "lock|ledger|transition"`

Expected: PASS, including two-process contention and fencing.

Run: `npm run test:faults -- --test-name-pattern "ledger recovery"`

Expected: PASS for Intent, temp write, fsync, rename, Commit, and snapshot-replace injection points.

- [ ] **Step 6: Commit the transactional state core**

```powershell
git add src/core/lock.ts src/core/ledger.ts test/unit/lock.test.ts test/unit/ledger.test.ts test/faults/ledger-recovery.test.ts dist
git diff --cached --check
git commit -m "feat: add fenced transactional Loop ledger"
```

---

### Task 5: Reproducible Manifests, WaveInput, and Verbatim Evidence

**Files:**
- Create: `src/core/manifests.ts`
- Create: `test/unit/manifests.test.ts`
- Create: `test/unit/evidence.test.ts`
- Create: `test/cli/process-timeout.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 manifest/evidence types and Schema API; Task 3 canonical paths/I/O; `sha256Hex`.
- Produces: `buildSourceManifest(options: ManifestOptions): Promise<ContentManifest>`; `buildTreeManifest(options: TreeManifestOptions): Promise<ContentManifest>`; `buildWorkspaceManifest(options: ManifestOptions): Promise<ContentManifest>`; `buildRuntimeManifest(root: string): Promise<ContentManifest>`; `sealWaveInput(options: WaveInputOptions): Promise<WaveInput>`; `runEvidenceCommand(request: EvidenceCommandRequest): Promise<EvidenceRecord>`; `verifyEvidenceBinding(record: EvidenceRecord, expected: EvidenceBinding): void`.

- [ ] **Step 1: Write failing manifest-equivalence, dirty-input, and byte-evidence tests**

```ts
test("source tree and workspace use one exclusion contract", async () => {
  const source = await buildSourceManifest({ root, exclusions: CONTROL_EXCLUSIONS });
  const workspace = await buildWorkspaceManifest({ root, exclusions: CONTROL_EXCLUSIONS });
  assert.equal(source.entries.some((entry) => entry.path.startsWith(".git/")), false);
  assert.equal(workspace.entries.some((entry) => entry.path.startsWith(".ai-loop/")), false);
  assert.equal(source.entries.some((entry) => entry.path === "src/product.ts"), true);
});

test("evidence preserves non-UTF8 stdout and binds every execution input", async () => {
  const record = await runEvidenceCommand(binaryFixtureRequest);
  assert.deepEqual(await readFile(record.stdout_path), Buffer.from([0xff, 0x00, 0x61]));
  assert.equal(record.wave_input_digest, expectedWaveDigest);
  assert.throws(() => verifyEvidenceBinding(record, { ...expectedBinding, attempt: 2 }), /SCHEMA_INVALID/);
});
```

- [ ] **Step 2: Run tests and confirm manifests/evidence are absent**

Run: `npm run test:unit -- --test-name-pattern "exclusion contract|non-UTF8"`

Expected: FAIL because `manifests.ts` does not exist.

- [ ] **Step 3: Implement one normalized manifest algorithm for every source view**

Use Git `ls-files -s -z`, `ls-files --others --exclude-standard -z`, and `status --porcelain=v2 -z` with argv arrays. Record slash-normalized relative paths, Git mode, Blob/content digest, and kind. The Source Manifest explicitly includes `src/**/*.ts`, `schemas/**/*.json`, `assets/loop-engineering/workflow-spec.json`, `package.json`, and `package-lock.json`. The Runtime Manifest explicitly includes `dist/**/*.js` and `dist/**/*.js.map`. Exclude the complete `.git/`, `.ai-loop/`, `.codegraph/` and only declared Scratch/Cache roots. Include behavior-affecting ignored inputs through explicit Artifact entries; external assets carry URI/mount, version, digest, provenance, and read-only materialization policy; Secret entries store provider/handle/version metadata without secret bytes. Symlink targets are hashed and containment-checked; submodules bind path, mode, and commit.

```ts
export interface ManifestOptions {
  root: string;
  include: readonly string[];
  exclusions: readonly string[];
  declaredArtifacts: readonly ArtifactBinding[];
}
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
```

`sealWaveInput` never mutates the user's index. It combines Source/Tree/Workspace/Artifact manifests, repository identity, base SHA, H1 WaveInput policy digest, ignored/external inputs, and a canonical digest. Every Agent Worktree must materialize or verify this exact input.

- [ ] **Step 4: Implement cross-platform process capture as Buffer evidence**

`runEvidenceCommand` calls `spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })`, accumulates Buffer chunks without decoding, writes raw streams atomically, records digests, tool versions, redacted environment digest, start/end, exit code/signal, and artifact digest. On timeout, Windows uses `taskkill /PID <pid> /T /F` and POSIX signals the detached process group; the evidence result records timeout as failure and the actual termination path.

```ts
export interface EvidenceCommandRequest {
  loopId: LoopId;
  workItemId: string;
  attempt: number;
  actorRole: string;
  h1Digest: Digest;
  waveInputDigest: Digest;
  outputTreeDigest: Digest;
  executable: string;
  args: readonly string[];
  cwd: string;
  envAllowlist: readonly string[];
  timeoutMs: number;
  evidenceDirectory: string;
}
```

Add the CLI-suite script now that the first real CLI-boundary test exists:

```json
{
  "scripts": {
    "test:cli": "npm run build && node tooling/test.mjs cli",
    "test": "npm run typecheck && npm run schema:check && npm run test:unit && npm run test:cli && npm run test:faults && npm run check:dist"
  }
}
```

- [ ] **Step 5: Verify dirty inputs, symlinks, ignored assets, and timeout cleanup**

Run: `npm run test:unit -- --test-name-pattern "manifest|WaveInput|evidence"`

Expected: PASS.

Run: `npm run test:cli -- --test-name-pattern "process timeout"`

Expected: PASS on Windows, Linux, and macOS; no child remains after timeout. Real symlink integration skips only on an explicit permission error.

- [ ] **Step 6: Commit reproducible input and evidence capture**

```powershell
git add src/core/manifests.ts test/unit/manifests.test.ts test/unit/evidence.test.ts test/cli/process-timeout.test.ts dist
git diff --cached --check
git commit -m "feat: bind manifests WaveInputs and evidence"
```

---

### Task 6: H0/H1 Harness Foundry, Runtime Gate, and Physical AI Environment DAG

**Files:**
- Create: `src/core/harness.ts`
- Create: `test/unit/harness.test.ts`
- Create: `test/unit/runtime-gate.test.ts`
- Create: `test/unit/environment-dag.test.ts`
- Create: `test/faults/harness-transaction.test.ts`

**Interfaces:**
- Consumes: Harness/domain Schemas, ledger transactions, manifests, paths, and evidence bindings.
- Produces: `forgeH0(input: H0Input): Promise<H0Harness>`; `sealH1(input: H1Input, ledger: LoopLedger): Promise<H1Harness>`; `classifyHarnessDrift(current: H1Harness, facts: HarnessFacts): HarnessDrift`; `evaluateGate(request: GateRequest): GateDecision`; `validateEnvironmentDag(gates: readonly GateRequirement[]): void`; `assertFinalizeGates(gates: readonly GateRequirement[], evidence: readonly EvidenceRecord[]): void`.

- [ ] **Step 1: Write failing No-Harness/No-Evidence/No-Physical-Action tests**

```ts
test("H0 rejects source writes and H1 cannot seal before plan review", async () => {
  const h0 = await forgeH0(discoveryInput);
  assert.equal(evaluateGate({ harness: h0, operation: "SOURCE_WRITE", facts }).allowed, false);
  await assert.rejects(sealH1({ ...executionInput, planReview: "REQUIRED_NOT_PASSED" }, ledger), /HARNESS_REQUIRED/);
});

test("new physical actions must be RELEASE_REQUIRED", () => {
  assert.throws(
    () => validateEnvironmentDag([{ gate_id: "hil", node: "HIL", owner: "LOOP_REQUIRED", depends_on: [], evidence_ids: [], requires_new_action: true }]),
    /new physical action/i,
  );
});

test("existing immutable physical evidence may remain LOOP_REQUIRED", () => {
  assert.doesNotThrow(() => validateEnvironmentDag([
    { gate_id: "hil-existing", node: "HIL", owner: "LOOP_REQUIRED", depends_on: [], evidence_ids: ["E-HIL-1"], requires_new_action: false },
  ]));
});
```

- [ ] **Step 2: Run tests and verify the gate is absent**

Run: `npm run test:unit -- --test-name-pattern "H0 rejects|physical actions"`

Expected: FAIL because `harness.ts` does not exist.

- [ ] **Step 3: Implement immutable H0/H1 forge and drift classification**

H0 binds Loop/repository identity, canonical root, readable scope, repository rules digest, CodeGraph/native explore capabilities, network class, and denied external/physical actions. H1 binds objective, acceptance, out-of-scope, path sets, Artifact/WaveInput policy, DAG, actors, capabilities with enforcement classes, budgets, verification gates, stop rules, and result Schemas. H1 can seal only from `HARNESSING` after the required Plan Review. Revisions are immutable `h1-execution-rNNN.json` files committed through the ledger.

```ts
export type HarnessDrift =
  | { kind: "NONE" }
  | { kind: "FACT_REFRESH"; reason: string; nextPhase: "HARNESSING" }
  | { kind: "PLAN_CHANGE"; reason: string; nextPhase: "PLANNED" }
  | { kind: "AUTHORITY_EXPANSION"; reason: string; childLoopRequired: true };

export type GateDecision =
  | { allowed: true; harnessDigest: Digest; enforcement: EnforcementClass }
  | { allowed: false; code: "HARNESS_REQUIRED" | "HARNESS_DRIFT" | "AUTHORIZATION_REQUIRED"; reason: string };
```

- [ ] **Step 4: Implement Runtime Gate and environment evidence semantics**

`evaluateGate` validates current H1 digest against current Source/Runtime/Policy/plan facts, operation/path/tool/actor allowance, remaining budgets, no active write Wave, and required evidence. Without host hooks, direct main-Agent path controls are `ORCHESTRATION_ONLY`; the next write boundary recomputes Workspace/Diff, invalidates affected evidence, and blocks Finalize on drift.

`validateEnvironmentDag` rejects cycles, missing dependencies, `NOT_APPLICABLE` without reason, and any HIL/BENCH/CLOSED_COURSE/REAL_VEHICLE_ROBOT gate with `requires_new_action: true` owned by the Loop. A physical gate with `requires_new_action: false` may be `LOOP_REQUIRED` only when it references existing immutable evidence bound to the current input and environment. `assertFinalizeGates` requires current evidence for every `LOOP_REQUIRED` gate and carries unsatisfied `RELEASE_REQUIRED` gates into Handoff.

```ts
export interface GateRequest {
  harness: H0Harness | H1Harness | null;
  operation: "SOURCE_WRITE" | "EVIDENCE_EXECUTION" | "DISPATCH" | "TRANSITION" | "FINALIZE" | "EXTERNAL_ACTION" | "PHYSICAL_ACTION";
  actorRole: string;
  path?: string;
  argv?: readonly string[];
  facts: HarnessFacts;
}
export interface EnvironmentGateResult {
  loopSatisfied: readonly string[];
  releasePending: readonly string[];
  notApplicable: readonly string[];
}
```

- [ ] **Step 5: Verify revisions, drift, budgets, and crash recovery**

Run: `npm run test:unit -- --test-name-pattern "Harness|Runtime Gate|environment"`

Expected: PASS for H0/H1, old-revision retention, same-scope refresh, Child Loop expansion, missing evidence, and budget rejection.

Run: `npm run test:faults -- --test-name-pattern "Harness transaction"`

Expected: PASS at Intent/write/rename/Commit/snapshot boundaries.

- [ ] **Step 6: Commit the bounded runtime Harness**

```powershell
git add src/core/harness.ts test/unit/harness.test.ts test/unit/runtime-gate.test.ts test/unit/environment-dag.test.ts test/faults/harness-transaction.test.ts dist
git diff --cached --check
git commit -m "feat: forge bounded Physical AI Harnesses"
```

---

### Task 7: Persistent Loop Bootstrap, Resume, Transition, and Read-Only Status CLI

**Files:**
- Create: `src/cli/loopctl.ts`
- Create: `test/cli/loopctl.test.ts`
- Create: `test/cli/status-readonly.test.ts`
- Create: `test/faults/bootstrap-resume.test.ts`

**Interfaces:**
- Consumes: Tasks 2-6 validation, layout, ledger, manifests, H0/H1, Runtime Gate, and Markdown APIs.
- Produces CLI operations `start`, `resume`, `transition`, `set-markdown-language`, `checkpoint`, `status`, `reconcile` with JSON stdout and stable nonzero error exits; `bootstrapLoop(request: BootstrapRequest): Promise<LoopSnapshot>`; `resumeLoop(request: ResumeRequest): Promise<LoopSnapshot>`; `inspectLoops(request: StatusRequest): Promise<StatusReport>`.

- [ ] **Step 1: Write failing real-dist bootstrap, exact-resume, locale, and read-only tests**

```ts
test("start bootstraps H0 without Init and writes complete Loop paths", async () => {
  const result = await runDist("loopctl", ["start", "--workspace", root, "--task", "Calibrate controller"]);
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.phase, "ORIENTING");
  assert.equal(existsSync(join(root, ".ai-loop", "loop", report.loop_id, "LOOP.json")), true);
  assert.equal(existsSync(join(root, ".ai-loop", "loop", report.loop_id, "harness", "h0-discovery.json")), true);
});

test("status does not change any byte or mtime", async () => {
  const before = await snapshotDirectory(join(root, ".ai-loop"));
  await runDist("loopctl", ["status", "--workspace", root, "--loop-id", loopId]);
  assert.deepEqual(await snapshotDirectory(join(root, ".ai-loop")), before);
});
```

- [ ] **Step 2: Build and run the CLI tests to confirm the entry point is missing**

Run: `npm run test:cli -- --test-name-pattern "bootstraps H0|does not change"`

Expected: FAIL because `dist/cli/loopctl.js` is absent.

- [ ] **Step 3: Implement validated CLI parsing and atomic Bootstrap**

The CLI accepts only:

```text
loopctl start --workspace <path> --task <text> [--markdown-language en-US|zh-CN]
loopctl resume --workspace <path> --loop-id <id>
loopctl transition --workspace <path> --loop-id <id> --to <phase> [--status <status>]
loopctl set-markdown-language --workspace <path> --loop-id <id> --language en-US|zh-CN
loopctl checkpoint --workspace <path> --loop-id <id> --reason <english-text>
loopctl status --workspace <path> [--loop-id <id>] [--display-language en-US|zh-CN]
loopctl reconcile --workspace <path> --loop-id <id>
```

Parsing rejects unknown options before writes. `start` validates language, derives repository identity, creates the Loop directory, writes H0 through an Intent/Commit transaction, creates `LOOP.json` and `LOOP.md`, then reaches `ORIENTING`. `resume` requires exact ID and validates lineage, repository, ledger, workspace, Harness, and terminal status; complete, cancelled, non-convergent, and v1/`.ai/runs` state cannot resume. `set-markdown-language` appends English `MARKDOWN_LANGUAGE_CHANGED` and regenerates mutable `LOOP.md` only.

- [ ] **Step 4: Implement byte-for-byte read-only status**

`status` with no ID lists candidates; exact status validates but never repairs, locks, creates directories, updates access metadata, or rewrites snapshots. It reports phase/status, Harness revision/digest/drift, budgets, gates, open Findings, Evidence freshness, leases/dispatch, Handoff/Release pointers, blockers, and next legal actions. `--display-language` localizes only stdout and never persisted files.

```ts
export interface StatusRequest { workspace: string; loopId?: LoopId; displayLanguage?: "en-US" | "zh-CN" }
export interface StatusReport {
  candidates: readonly LoopId[];
  selected: LoopSnapshot | null;
  harness: { revision: number | null; digest: Digest | null; drift: HarnessDrift };
  openFindings: readonly string[];
  staleEvidence: readonly string[];
  activeLeases: readonly string[];
  nextActions: readonly string[];
}
```

- [ ] **Step 5: Verify bootstrap crash recovery and all terminal rules**

Run: `npm run test:cli -- --test-name-pattern "loopctl|status"`

Expected: PASS through real committed `dist/`.

Run: `npm run test:faults -- --test-name-pattern "bootstrap|resume"`

Expected: PASS; exact resume reconciles committed transactions, quarantines partial artifacts, and never overwrites a Final Handoff.

- [ ] **Step 6: Commit the Loop CLI**

```powershell
git add src/cli/loopctl.ts test/cli/loopctl.test.ts test/cli/status-readonly.test.ts test/faults/bootstrap-resume.test.ts dist
git diff --cached --check
git commit -m "feat: add persistent Loop control CLI"
```

---

### Task 8: Repository Coordinator and Bounded Parallel Dispatch Broker

**Files:**
- Create: `src/core/coordinator.ts`
- Create: `src/core/dispatch.ts`
- Create: `test/unit/coordinator.test.ts`
- Create: `test/unit/dispatch.test.ts`
- Create: `test/cli/dispatch-lifecycle.test.ts`
- Create: `test/faults/dispatch-recovery.test.ts`
- Modify: `src/cli/loopctl.ts`

**Interfaces:**
- Consumes: current H1/Gate, ledger, locks, canonical coordination root, WaveInput/manifests, dispatch Schemas.
- Produces: `openRepositoryCoordinator(workspace: string): Promise<RepositoryCoordinator>`; `RepositoryCoordinator.reserve(request: LeaseRequest): Promise<RepositoryLease>`; `RepositoryCoordinator.reconcile(): Promise<CoordinatorRecovery>`; `reserveDispatch(request: DispatchReservation): Promise<AgentRequest>`; `acceptAgentResult(result: unknown): Promise<AcceptedAgentBundle>`; `admitIntegration(request: IntegrationRequest): Promise<IntegrationDecision>`; `reconcileDispatch(loopId: LoopId): Promise<DispatchRecovery>`.

- [ ] **Step 1: Write failing cross-Worktree lease, DAG, conflict, stale-result, and sealing tests**

```ts
test("two Worktrees share one Git common-dir coordinator", async () => {
  const first = await openRepositoryCoordinator(worktreeA);
  const second = await openRepositoryCoordinator(worktreeB);
  assert.equal(first.root, second.root);
  await first.reserve({ loopId: loopA, kind: "path", resources: ["src/control/**"], ttlMs: 60_000 });
  await assert.rejects(
    second.reserve({ loopId: loopB, kind: "path", resources: ["src/control/gain.ts"], ttlMs: 60_000 }),
    /DISPATCH_REJECTED/,
  );
});

test("parallel admission applies the symmetric read-write rule", () => {
  assert.equal(canShareWave({ reads: ["a"], writes: ["b"] }, { reads: ["c"], writes: ["d"] }), true);
  assert.equal(canShareWave({ reads: ["a"], writes: ["b"] }, { reads: ["b"], writes: ["d"] }), false);
  assert.equal(canShareWave({ reads: "UNKNOWN", writes: ["b"] }, { reads: ["c"], writes: ["d"] }), false);
});
```

- [ ] **Step 2: Run tests and confirm Coordinator/Broker are missing**

Run: `npm run test:unit -- --test-name-pattern "common-dir coordinator|symmetric"`

Expected: FAIL because `coordinator.ts` and `dispatch.ts` do not exist.

- [ ] **Step 3: Implement fixed-order cross-Loop Repository leases**

Repository state lives only at `<git-common-dir>/pi-loop-engineering/coordination/{repository.json,events.jsonl}`. Lease kinds are `branch`, `path`, `integration`, and `external-root`. Reservations validate overlap using canonical platform paths/globs, use monotonic fencing and expiry, write Intent/Commit under the Repository lock, then the Loop lock, and release both before Agent execution. Unknown state requires `reconcile`; no caller steals an expired lease.

```ts
export interface LeaseRequest {
  loopId: LoopId;
  kind: "branch" | "path" | "integration" | "external-root";
  resources: readonly string[];
  ttlMs: number;
}
export interface RepositoryLease {
  leaseId: string;
  loopId: LoopId;
  kind: LeaseRequest["kind"];
  resources: readonly string[];
  fencingToken: number;
  expiresAt: string;
}
```

- [ ] **Step 4: Implement Dispatch reservation, sealed result admission, and serial integration**

`reserveDispatch` verifies acyclic DAG readiness, H1, WaveInput, actor/model class, no recursive delegation, budgets, environment prohibition, Worktree identity, and symmetric read/write conflicts. Session-only mode admits parallel read-only work and rejects every parallel writer. External write is admitted only with `HOST_ENFORCED` containment and an external-root lease.

```ts
export interface DispatchReservation {
  loopId: LoopId;
  workItemId: string;
  actorRole: string;
  objective: string;
  acceptance: readonly string[];
  dependencies: readonly string[];
  readSet: readonly string[] | "UNKNOWN";
  writeSet: readonly string[];
  worktree: string;
  waveInputDigest: Digest;
  h1Digest: Digest;
}
export type IntegrationDecision =
  | { admitted: true; bundleDigest: Digest; fencingToken: number }
  | { admitted: false; code: "STALE_AGENT_RESULT" | "DISPATCH_REJECTED"; reason: string };
```

On Agent exit, independently diff tracked/untracked/ignored/rename/symlink/submodule plus permitted external roots, reject undeclared writes, validate evidence and envelope identity, and seal patch/output-tree/artifacts into a content-addressed bundle. Integration reads only the sealed bundle, obtains one integration lease, compares current tree and declared read/write dependencies to the WaveInput, writes `INTEGRATION_INTENT`, applies exactly once, records Commit, and makes remaining stale results ineligible. It never auto-rebases.

Add exact CLI primitives `dispatch-reserve`, `dispatch-accept`, `integrate`, and `dispatch-reconcile`; each takes a JSON request file validated before state change.

- [ ] **Step 5: Verify admission matrix and crash reconciliation**

Run: `npm run test:unit -- --test-name-pattern "Coordinator|Dispatch|sealed|stale"`

Expected: PASS for DAG, unknown reads, overlapping sets, budgets, actor denial, external roots, fencing, and sealed-bundle immutability.

Run: `npm run test:cli -- --test-name-pattern "dispatch lifecycle"`

Expected: PASS through real `dist/cli/loopctl.js`.

Run: `npm run test:faults -- --test-name-pattern "dispatch recovery"`

Expected: PASS for reservation, result, bundle, and integration Intent/Commit boundaries without duplicate dispatch or apply.

- [ ] **Step 6: Commit bounded parallel dispatch**

```powershell
git add src/core/coordinator.ts src/core/dispatch.ts src/cli/loopctl.ts test/unit/coordinator.test.ts test/unit/dispatch.test.ts test/cli/dispatch-lifecycle.test.ts test/faults/dispatch-recovery.test.ts dist
git diff --cached --check
git commit -m "feat: broker bounded parallel Agent work"
```

---

### Task 9: Risk-Adaptive Independent Review, Checkpoints, Immutable Handoff, and Final Status

**Files:**
- Create: `src/core/review.ts`
- Create: `src/core/handoff.ts`
- Create: `test/unit/review.test.ts`
- Create: `test/unit/handoff.test.ts`
- Create: `test/cli/finalize-status.test.ts`
- Create: `test/faults/handoff-finalize.test.ts`
- Modify: `src/cli/loopctl.ts`

**Interfaces:**
- Consumes: integrated tree/manifests, current H1, Gate/evidence, ledger, dispatch bundles, workflow risk gates.
- Produces: `RequirementContract`, `ReviewerRequest`, `FindingUpdate`, `VerdictInput`, `CheckpointInput`, `FinalizeInput`, and `FreshnessFacts`; `classifyRisk(contract: RequirementContract): RiskLevel`; `requiredReviewGates(risk: RiskLevel): readonly ReviewGate[]`; `admitReviewer(request: ReviewerRequest): ReviewAssignment`; `recordFindingUpdate(update: FindingUpdate): Promise<Finding>`; `aggregateVerdict(input: VerdictInput): ReviewVerdict`; `writeCheckpoint(input: CheckpointInput): Promise<Checkpoint>`; `finalizeHandoff(input: FinalizeInput): Promise<FinalHandoff>`; `verifyHandoffFreshness(handoff: FinalHandoff, facts: FreshnessFacts): Promise<void>`.

- [ ] **Step 1: Write failing risk gate, Reviewer ownership, immutable Finalize, and stale-Handoff tests**

```ts
test("risk gates are adaptive but final independent review is universal", () => {
  assert.deepEqual(requiredReviewGates("LOW"), ["FINAL_DIFF"]);
  assert.deepEqual(requiredReviewGates("MEDIUM"), ["PLAN", "FINAL_DIFF"]);
  assert.deepEqual(requiredReviewGates("HIGH"), ["PLAN", "CODE", "SAFETY_ENVIRONMENT"]);
});

test("implementer can fix but only current independent reviewer can verify", async () => {
  await recordFindingUpdate({ findingId: "F-1", actorRole: "implementer", status: "FIXED", sourceDigest });
  await assert.rejects(
    recordFindingUpdate({ findingId: "F-1", actorRole: "implementer", status: "VERIFIED", sourceDigest }),
    /independent reviewer/i,
  );
});

test("Final Handoff is single-write and Source drift is stale", async () => {
  const handoff = await finalizeHandoff(validFinalizeInput);
  await assert.rejects(finalizeHandoff(validFinalizeInput), /immutable/i);
  await assert.rejects(verifyHandoffFreshness(handoff, changedSourceFacts), /STALE_HANDOFF/);
});
```

- [ ] **Step 2: Run tests and confirm Review/Handoff are absent**

Run: `npm run test:unit -- --test-name-pattern "risk gates|independent reviewer|single-write"`

Expected: FAIL because `review.ts` and `handoff.ts` do not exist.

- [ ] **Step 3: Implement independent Review and non-convergence**

Risk classification marks persistence/concurrency/interface/rollback as at least Medium and control/safety/actuator/real-time/HIL/real robot/model release as High. Reviewer input contains spec/acceptance, Base/Head SHA, Diff coordinates, source snapshot digest, and compact verification facts but not implementer conclusions. Reviewer source is read-only; cache/temp/output use a private root, and any command that can mutate source/shared resources requires a Worktree and lease. Only a distinct Reviewer assignment on the current source/evidence digest can mark `VERIFIED`.

```ts
export interface RequirementContract {
  objective: string;
  acceptance: readonly string[];
  outOfScope: readonly string[];
  safetyInvariants: readonly string[];
  changedDomains: readonly ("LOCAL" | "INTERFACE" | "PERSISTENCE" | "CONCURRENCY" | "ROLLBACK" | "CONTROL" | "SAFETY" | "ACTUATOR" | "REAL_TIME" | "HIL" | "REAL_ROBOT" | "MODEL_RELEASE")[];
}
export interface ReviewerRequest {
  loopId: LoopId;
  gate: "PLAN" | "FINAL_DIFF" | "CODE" | "SAFETY_ENVIRONMENT";
  reviewerActor: string;
  implementerActors: readonly string[];
  baseSha: string;
  headSha: string;
  sourceDigest: Digest;
  diffCoordinates: readonly string[];
  acceptance: readonly string[];
  verificationEvidenceIds: readonly string[];
  privateOutputRoot: string;
}
```

`aggregateVerdict` blocks on open Critical/High Findings, unmet risk gates, stale evidence, or oscillation. Repeated same-area Findings, new Criticals after fixes, alternating verification, or exhausted attempt/review/transition budgets produce `NON_CONVERGENT` plus a Checkpoint.

- [ ] **Step 4: Implement transactionally immutable Final Handoff**

`writeCheckpoint` writes increasing `checkpoints/<sequence>.json` with completed results, evidence, blocker, and exact resume entry. `finalizeHandoff` first evaluates Runtime Gate, current H1, actual dispatch/Harness consistency, all `LOOP_REQUIRED` gates, Review verdict, Finding states, Source/Tree/Workspace/Runtime/Policy/LOOP.md/H0/H1/bundle/evidence manifests, rollback, residual risk, and pending `RELEASE_REQUIRED` gates.

It writes `handoff.pending.<transaction-id>.json`, validates Schema/digests, atomically renames once to `handoff.json`, commits the ledger pointer, then transitions to `HANDOFF_READY + COMPLETE`. Freshness excludes preferences, Release, and coordination state but includes reviewed source/runtime, Project Policy, H1, and Loop-bound evidence. A stale complete Handoff requires a Child Loop and is never overwritten.

```ts
export interface FinalHandoff {
  schema_version: 1;
  loop_id: LoopId;
  markdown_language: "en-US" | "zh-CN";
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
  rollback: { target: string; procedure: readonly string[]; triggers: readonly string[]; estimated_recovery_minutes: number };
  release_required_gates: readonly string[];
  recommended_release_actions: readonly ReleaseAction[];
  finalize_event_sequence: number;
  digest: Digest;
}
```

Add CLI primitives `review-admit`, `finding-update`, `verdict`, `finalize`, and `child-loop`. Enhance `status` with Review gates, Finding ownership, Handoff digest/freshness, rollback, residual risks, and Release recommendations without writes.

- [ ] **Step 5: Verify Review isolation and every Finalize crash boundary**

Run: `npm run test:unit -- --test-name-pattern "Review|Finding|Handoff|freshness"`

Expected: PASS.

Run: `npm run test:cli -- --test-name-pattern "finalize|final status"`

Expected: PASS; status remains byte-for-byte read-only.

Run: `npm run test:faults -- --test-name-pattern "Handoff finalize"`

Expected: PASS; no crash state exposes a consumable Handoff without its Commit event and ledger pointer.

- [ ] **Step 6: Commit Review and Handoff**

```powershell
git add src/core/review.ts src/core/handoff.ts src/cli/loopctl.ts test/unit/review.test.ts test/unit/handoff.test.ts test/cli/finalize-status.test.ts test/faults/handoff-finalize.test.ts dist
git diff --cached --check
git commit -m "feat: finalize independently reviewed Handoffs"
```

---

### Task 10: Separate Release Lifecycle, Action Envelopes, and Just-in-Time Physical Authorization

**Files:**
- Create: `src/core/release.ts`
- Create: `src/cli/releasectl.ts`
- Create: `test/unit/release.test.ts`
- Create: `test/cli/releasectl.test.ts`
- Create: `test/faults/release-reconcile.test.ts`

**Interfaces:**
- Consumes: immutable Final Handoff/freshness, Git manifests, Coordinator, atomic ledger, Release/Action Schemas.
- Produces: `checkReadiness(input: ReadinessInput): Promise<ReadinessReport>`; `createRelease(input: ReleaseInput): Promise<ReleaseRecord>`; `createActionEnvelope(input: ActionRequest): Promise<ActionEnvelope>`; `executeCommit(envelope: ActionEnvelope): Promise<CommitResult>`; `recordOperationIntent(envelope: ActionEnvelope): Promise<OperationRecord>`; `reconcileOperation(operationId: string): Promise<OperationRecord>`; `assertPhysicalAuthorization(envelope: ActionEnvelope, now: Date): void`.

- [ ] **Step 1: Write failing readiness-only, Tree-preserving commit, idempotency, and physical-authorization tests**

```ts
test("readiness-only creates no Release files", async () => {
  const before = await snapshotDirectory(join(root, ".ai-loop"));
  const report = await checkReadiness({ workspace: root, loopId });
  assert.equal(report.ready, true);
  assert.deepEqual(await snapshotDirectory(join(root, ".ai-loop")), before);
});

test("commit packages the reviewed Tree without editing content", async () => {
  const result = await executeCommit(validCommitEnvelope);
  assert.equal(result.treeDigest, handoff.reviewed_tree_digest);
  assert.equal(result.parentSha, validCommitEnvelope.expected_parent_sha);
});

test("physical action requires unexpired action-target-environment authorization", () => {
  assert.throws(() => assertPhysicalAuthorization({ ...hilEnvelope, expires_at: expired }, now), /AUTHORIZATION_REQUIRED/);
  assert.throws(() => assertPhysicalAuthorization({ ...hilEnvelope, target: "robot-B" }, now), /AUTHORIZATION_REQUIRED/);
});
```

- [ ] **Step 2: Run tests and verify Release is absent**

Run: `npm run test:unit -- --test-name-pattern "readiness-only|packages|physical action"`

Expected: FAIL because `release.ts` does not exist.

- [ ] **Step 3: Implement read-only readiness and independent Release state**

`checkReadiness` accepts only `HANDOFF_READY + COMPLETE`, rejects Checkpoints, recomputes Handoff freshness and `check:dist` facts, validates rollback/recommendations/pending gates, and creates no directory. An explicit action creates `.ai-loop/releases/<release-id>/release.json` and an immutable read-only `release-harness.json` bound to the Handoff; it never inherits H1 write capabilities.

Release phases are `NEW → VALIDATING_HANDOFF → READY → AWAITING_AUTHORIZATION → EXECUTING → RECONCILING → RELEASED` with `BLOCKED`/`CANCELLED` terminals. Each action has a unique immutable envelope bound to action, target, Handoff, reviewed Tree, Release Commit, authorization, and expiry.

```ts
export const RELEASE_PHASES = [
  "NEW", "VALIDATING_HANDOFF", "READY", "AWAITING_AUTHORIZATION",
  "EXECUTING", "RECONCILING", "RELEASED", "BLOCKED", "CANCELLED",
] as const;
export interface ReadinessReport {
  loopId: LoopId;
  handoffDigest: Digest;
  ready: boolean;
  blockers: readonly string[];
  pendingReleaseGates: readonly string[];
  allowedActions: readonly ReleaseAction[];
}
```

- [ ] **Step 4: Implement safe commit packaging and operation reconciliation**

`executeCommit` is the only action allowed to change Commit SHA without content drift. It checks HEAD/expected parent, stages exactly the Handoff-bound reviewed workspace without editing bytes, commits with metadata whose digest matches the envelope, and confirms the resulting Git Tree digest. A clean existing Commit with the same Tree is an idempotent no-op. Push/PR/tag/publish/deploy actions require the verified Release Commit.

Every mutable action records an idempotency-keyed Operation Intent before execution. A lost response becomes `UNKNOWN` and `reconcileOperation` queries actual Git/external state before any retry; `PENDING`/`UNKNOWN` are never blindly repeated. HIL/BENCH/CLOSED_COURSE/REAL_VEHICLE_ROBOT operations call `assertPhysicalAuthorization` immediately before execution and verify action, target, environment node, authorizer, and current expiry.

The CLI accepts:

```text
releasectl readiness --workspace <path> --loop-id <id>
releasectl action --workspace <path> --loop-id <id> --action <action> --target <target> --authorization <json-file>
releasectl reconcile --workspace <path> --release-id <id> --operation-id <id>
```

- [ ] **Step 5: Verify real CLI, stale Handoff, commit, and unknown-operation recovery**

Run: `npm run test:unit -- --test-name-pattern "Release|Action Envelope|commit|authorization"`

Expected: PASS.

Run: `npm run test:cli -- --test-name-pattern "releasectl"`

Expected: PASS; readiness does not mutate state and stage Handoffs are rejected.

Run: `npm run test:faults -- --test-name-pattern "Release reconcile"`

Expected: PASS for Intent, response loss, Reconcile, and idempotent completion.

- [ ] **Step 6: Commit the Release boundary**

```powershell
git add src/core/release.ts src/cli/releasectl.ts test/unit/release.test.ts test/cli/releasectl.test.ts test/faults/release-reconcile.test.ts dist
git diff --cached --check
git commit -m "feat: separate authorized Release lifecycle"
```

---

### Task 11: Proposal-Only Knowledge Evolution

**Files:**
- Create: `src/core/knowledge.ts`
- Create: `src/cli/knowledgectl.ts`
- Create: `assets/knowledge/proposal.en-US.md`
- Create: `assets/knowledge/proposal.zh-CN.md`
- Create: `test/unit/knowledge.test.ts`
- Create: `test/cli/knowledgectl.test.ts`

**Interfaces:**
- Consumes: completed Handoff/ended Release readers, Markdown resolver/renderer, Knowledge Proposal Schema, immutable digests.
- Produces: `collectKnowledgeSources(input: KnowledgeSourceInput): Promise<KnowledgeObservation[]>`; `buildProposal(input: ProposalInput): Promise<KnowledgeProposal>`; `transitionProposal(input: ProposalTransition): Promise<KnowledgeProposal>`; `markProposalApplied(input: AppliedInput): Promise<KnowledgeProposal>`.

- [ ] **Step 1: Write failing completed-source, provisional, and no-direct-apply tests**

```ts
test("active Loops cannot be generalized", async () => {
  await assert.rejects(collectKnowledgeSources({ workspace: root, loopIds: [activeLoop] }), /completed Loop/i);
});

test("one observation is PROVISIONAL and proposal cannot modify production", async () => {
  const proposal = await buildProposal(singleObservationInput);
  assert.equal(proposal.status, "PROVISIONAL");
  assert.equal(proposal.observation_count, 1);
  await assert.rejects(markProposalApplied({ proposalId: proposal.proposal_id, implementationLoopId: activeLoop }), /completed implementation Loop/i);
});
```

- [ ] **Step 2: Run tests and confirm Knowledge Evolution is absent**

Run: `npm run test:unit -- --test-name-pattern "cannot be generalized|PROVISIONAL"`

Expected: FAIL because `knowledge.ts` does not exist.

- [ ] **Step 3: Implement source selection, proposal review states, and Markdown-only localization**

Sources are only immutable completed Handoffs and ended Releases. Proposal types are `PROJECT_KNOWLEDGE`, `PROJECT_POLICY`, and `WORKFLOW_SKILL_HARNESS`. Every proposal binds source Loop/Handoff digests, observation count, user-correction provenance, counterexamples, privacy review, expected benefit, safety impact, offline evaluation, Canary, rollback, and review date.

States are `PROVISIONAL`, `REVIEW_PENDING`, `REVISE`, `APPROVED`, `REJECTED`, `SUPERSEDED`, and `APPLIED`. One observation remains provisional unless it is an explicit user correction. `APPROVED` does not edit production. `APPLIED` requires a separate completed implementation Loop/Handoff whose contract cites the proposal.

The CLI accepts:

```text
knowledgectl propose --workspace <path> --loop-id <id> [--loop-id <id>...] [--markdown-language en-US|zh-CN]
knowledgectl transition --workspace <path> --proposal-id <id> --to <state> --review <json-file>
knowledgectl mark-applied --workspace <path> --proposal-id <id> --implementation-loop-id <id>
```

It writes one localized `.ai-loop/knowledge/proposals/<proposal-id>.md` with English front-matter keys/enums. No JSON narrative contains Chinese.

- [ ] **Step 4: Verify proposal provenance and both Markdown languages**

Run: `npm run test:unit -- --test-name-pattern "Knowledge|proposal|privacy|Canary|rollback"`

Expected: PASS.

Run: `npm run test:cli -- --test-name-pattern "knowledgectl"`

Expected: PASS; `en-US` is default, explicit `zh-CN` changes Markdown only, and active sources/direct application are rejected.

- [ ] **Step 5: Commit proposal-only Knowledge Evolution**

```powershell
git add src/core/knowledge.ts src/cli/knowledgectl.ts assets/knowledge test/unit/knowledge.test.ts test/cli/knowledgectl.test.ts dist
git diff --cached --check
git commit -m "feat: add proposal-only Knowledge Evolution"
```

---

### Task 12: Optional CodeGraph, Shared Trigger Policy, and Exactly Four Public Skills

**Files:**
- Create: `src/cli/codegraphctl.ts`
- Create: `src/cli/triggerctl.ts`
- Create: `assets/router/trigger-policy.json`
- Create: `assets/loop-engineering/workflow.md`
- Create: `assets/loop-engineering/review.md`
- Create: `skills/loop-engineering/SKILL.md`
- Create: `skills/loop-engineering/agents/openai.yaml`
- Create: `skills/knowledge-evolution/SKILL.md`
- Create: `skills/knowledge-evolution/agents/openai.yaml`
- Rewrite: `skills/status/SKILL.md`
- Rewrite: `skills/status/agents/openai.yaml`
- Rewrite: `skills/release/SKILL.md`
- Rewrite: `skills/release/agents/openai.yaml`
- Create: `test/cli/codegraphctl.test.ts`
- Create: `test/cli/triggerctl.test.ts`
- Create: `test/cli/skills.test.ts`
- Delete: `skills/init/`
- Delete: `skills/run/`
- Delete: `skills/review/`
- Delete: `skills/learn/`
- Delete: `skills/superworkflows/`
- Delete: `assets/loop-engineering/trigger-policy.json`

**Interfaces:**
- Consumes: real `dist` CLIs, Harness/Review/Release/Knowledge boundaries, repository `AGENTS.md` rules.
- Produces: `resolveCodeGraph(request: CodeGraphRequest): Promise<CodeGraphResolution>`; `classifyTrigger(input: TriggerInput): TriggerDecision`; four and only four discoverable Skill directories.

- [ ] **Step 1: Write failing capability-fallback and exact-Skill tests**

```ts
test("missing CodeGraph falls back to native exploration without init", async () => {
  const result = await runDist("codegraphctl", ["resolve", "--workspace", root]);
  assert.deepEqual(JSON.parse(result.stdout), { mode: "NATIVE_EXPLORE", degraded: false, initialization_attempted: false });
});

test("skills expose exactly four commands and no Router Skill", async () => {
  assert.deepEqual(await skillNames(root), ["knowledge-evolution", "loop-engineering", "release", "status"]);
  assert.equal(await containsOldCommandOrAlias(root), false);
});
```

- [ ] **Step 2: Run CLI tests and confirm old surface remains**

Run: `npm run test:cli -- --test-name-pattern "CodeGraph|exactly four"`

Expected: FAIL because the new CLIs/Skills are absent and old Skills still exist.

- [ ] **Step 3: Implement the centralized CodeGraph capability resolver**

Resolution order is: read repository rules; if CodeGraph is mandatory and no healthy index is available return `BLOCKED`; with existing healthy `.codegraph/` prefer MCP availability reported by the caller, then `codegraph explore` CLI; without an index use `NATIVE_EXPLORE`. An existing-index sync failure is `DEGRADED` unless repository rules make it mandatory. The CLI exposes only `resolve`, `health`, and `sync-existing` and contains no `init` token or code path. Graph evidence is `STRUCTURAL_HINT` and cannot close Findings or prove behavior.

```ts
export type CodeGraphResolution =
  | { mode: "MCP"; degraded: false; initialization_attempted: false }
  | { mode: "CLI"; degraded: false; initialization_attempted: false }
  | { mode: "NATIVE_EXPLORE"; degraded: boolean; initialization_attempted: false; reason?: string }
  | { mode: "BLOCKED"; degraded: false; initialization_attempted: false; reason: string };
```

- [ ] **Step 4: Implement shared trigger classification and four Skill contracts**

`trigger-policy.json` defines decisions:

```json
{
  "exact": {
    "$loop-engineering": "PERSISTENT_LOOP",
    "$status": "READ_ONLY_STATUS",
    "$release": "READINESS_OR_AUTHORIZED_RELEASE",
    "$knowledge-evolution": "PROPOSAL_ONLY_EVOLUTION"
  },
  "implicit": {
    "complex_implementation": "SESSION_ONLY_LOOP",
    "status": "READ_ONLY_STATUS",
    "release": "READINESS_ONLY",
    "knowledge": "RESPONSE_ONLY",
    "review": "SESSION_ONLY_READ_ONLY_REVIEW"
  }
}
```

Every Skill calls `node dist/cli/triggerctl.js` before side effects. `loop-engineering` documents persistent exact invocation, session-only implicit mode, H0/H1, bounded Sub-agents, risk Review, Final Handoff stop, and no Release authority. `status` is strictly read-only. `release` defaults readiness-only and requires explicit action/target. `knowledge-evolution` writes proposals only. Natural-language Review loads internal `review.md` and a read-only Reviewer without a `review` Skill.

- [ ] **Step 5: Verify routing, unknown legacy commands, and no automatic index mutation**

Run: `npm run test:cli -- --test-name-pattern "codegraphctl|triggerctl|skills"`

Expected: PASS for MCP, CLI, native fallback, mandatory-blocked, sync-degraded, explicit/implicit/session-only routes, and physical authorization boundaries.

Run: `rg -n "\$(init|run|review|learn)\b|skills/superworkflows|codegraph init" skills assets src dist`

Expected: no runtime/Skill matches; static migration wording is added only in Task 14 documentation.

- [ ] **Step 6: Commit the four-command surface**

```powershell
git add src/cli/codegraphctl.ts src/cli/triggerctl.ts assets/router assets/loop-engineering/workflow.md assets/loop-engineering/review.md skills test/cli/codegraphctl.test.ts test/cli/triggerctl.test.ts test/cli/skills.test.ts dist
git diff --cached --check
git commit -m "feat: expose four PI Loop Engineering commands"
```

---

### Task 13: PI Agent Namespace, Actor Contracts, and Deterministic Synchronization

**Files:**
- Create: `src/cli/sync-agents.ts`
- Create: `assets/agents/pi-loop-explorer.toml`
- Create: `assets/agents/pi-loop-worker.toml`
- Create: `assets/agents/pi-loop-reviewer.toml`
- Create: `assets/agents/pi-loop-safety-reviewer.toml`
- Create: `assets/agents/pi-loop-environment-reviewer.toml`
- Create: `assets/agents/pi-loop-release-engineer.toml`
- Create: `assets/agents/pi-loop-robot-brain-engineer.toml`
- Create: `assets/agents/pi-loop-biped-cerebellum-engineer.toml`
- Create: `assets/agents/pi-loop-robot-data-algorithm.toml`
- Create: `assets/agents/pi-loop-robot-data-collector.toml`
- Create: `test/cli/sync-agents.test.ts`
- Delete: `assets/agents/sw-biped-cerebellum-engineer.toml`
- Delete: `assets/agents/sw-explorer.toml`
- Delete: `assets/agents/sw-robot-brain-engineer.toml`
- Delete: `assets/agents/sw-robot-data-algorithm.toml`
- Delete: `assets/agents/sw-robot-data-collector.toml`
- Delete: `assets/agents/sw-robot-release-engineer.toml`
- Delete: `assets/agents/sw-robot-safety-reviewer.toml`
- Delete: `assets/agents/sw-robot-sim2real-validator.toml`
- Delete: `assets/agents/sw-robot-system-architect.toml`
- Delete: `assets/agents/sw-worker.toml`

**Interfaces:**
- Consumes: H1 Actor/Capability contract and the four Skill metadata files.
- Produces: `parseAgentProfile(text: string): AgentProfile`; `validateActorContract(profile: AgentProfile): void`; `synchronizeAgents(options: SyncOptions): Promise<SyncReport>`; deterministic `openai.yaml` Agent references.

- [ ] **Step 1: Write failing namespace, capability, and idempotent-sync tests**

```ts
test("all Agent names use pi-loop and declare bounded actor capabilities", async () => {
  const profiles = await loadProfiles(agentRoot);
  assert.ok(profiles.every((profile) => profile.name.startsWith("pi-loop-")));
  assert.ok(profiles.every((profile) => profile.capabilities.recursive_dispatch === false));
  assert.ok(profiles.filter((profile) => profile.role.includes("reviewer")).every((profile) => profile.capabilities.source_write === false));
  assert.ok(profiles.every((profile) => profile.capabilities.physical_action === false));
});

test("sync is deterministic and rejects duplicate or unknown actors", async () => {
  const first = await synchronizeAgents({ root });
  const second = await synchronizeAgents({ root });
  assert.equal(first.outputDigest, second.outputDigest);
  assert.equal(second.changedFiles.length, 0);
});
```

- [ ] **Step 2: Run tests and confirm the old namespace fails**

Run: `npm run test:cli -- --test-name-pattern "pi-loop|sync is deterministic"`

Expected: FAIL because `sw-*` profiles remain and `sync-agents.ts` is absent.

- [ ] **Step 3: Define explicit read/write/review/release actor classes**

Each TOML profile declares `name`, `role`, `description`, `source_access` (`read-only` or `h1-write-set`), `external_write`, `network`, `recursive_dispatch = false`, `ledger_write = false`, `release = false` except the release engineer's envelope-mediated role, `physical_action = false` for every Sub-agent, evidence requirements, stop conditions, and license header. Reviewer roles are read-only and independent; writer roles require H1 work item, Worktree, WaveInput, lease, attempt, and fencing token.

The new environment reviewer replaces the old sim-to-real name because it reviews an explicit environment DAG rather than assuming a linear ladder.

```ts
export interface AgentProfile {
  name: string;
  role: string;
  description: string;
  source_access: "read-only" | "h1-write-set";
  capabilities: {
    external_write: boolean;
    network: boolean;
    recursive_dispatch: false;
    ledger_write: false;
    release: boolean;
    physical_action: false;
  };
  required_bindings: readonly ("h1" | "work_item" | "worktree" | "wave_input" | "lease" | "attempt" | "fencing_token")[];
  evidence_requirements: readonly string[];
  stop_conditions: readonly string[];
}
```

- [ ] **Step 4: Implement a minimal deterministic TOML reader and metadata sync**

`sync-agents.ts` parses only the repository's flat strings, booleans, arrays, and one-level tables; it rejects duplicate keys, unsupported syntax, duplicate Agent names, unknown actor classes, write-capable Reviewers, recursive dispatch, ledger writes, and physical capabilities. It updates only the four `skills/*/agents/openai.yaml` files using sorted Agent names and UTF-8 LF output; `--check` reports drift without writes.

```ts
export interface SyncOptions { root: string; check?: boolean }
export interface SyncReport { outputDigest: Digest; changedFiles: readonly string[]; profiles: readonly string[] }
```

- [ ] **Step 5: Verify namespace deletion and deterministic output**

Run: `npm run test:cli -- --test-name-pattern "Agent|sync"`

Expected: PASS.

Run: `node dist/cli/sync-agents.js --root . --check`

Expected: exit 0 with no drift.

Run: `rg -n "\bsw-" assets skills src dist test`

Expected: no output.

- [ ] **Step 6: Commit PI Actor contracts**

```powershell
git add src/cli/sync-agents.ts assets/agents skills test/cli/sync-agents.test.ts dist
git diff --cached --check
git commit -m "feat: define bounded PI Agent actors"
```

---

### Task 14: Plugin Brand, Clean Delivery Surface, Cross-Platform CI, and Full Acceptance Gate

**Files:**
- Create: `src/cli/validate-plugin.ts`
- Create: `.github/workflows/ci.yml`
- Create: `test/cli/plugin-validation.test.ts`
- Rewrite: `.codex-plugin/plugin.json`
- Rewrite: `compatibility.json`
- Rewrite: `README.md`
- Rewrite: `README.zh-CN.md`
- Rewrite: `SECURITY.md`
- Rewrite: `CHANGELOG.md`
- Rewrite: `CHANGELOG.zh-CN.md`
- Modify: `package.json`
- Delete: `assets/loop-engineering/project-profile.json`
- Delete: `assets/loop-engineering/templates/00-repository-exploration.md`
- Delete: `assets/loop-engineering/templates/01-requirements-contract.md`
- Delete: `assets/loop-engineering/templates/02-initial-plan.md`
- Delete: `assets/loop-engineering/templates/03-plan-review.md`
- Delete: `assets/loop-engineering/templates/04-final-plan.md`
- Delete: `assets/loop-engineering/templates/05-ownership.md`
- Delete: `assets/loop-engineering/templates/06-implementation-log.md`
- Delete: `assets/loop-engineering/templates/07-integration-log.md`
- Delete: `assets/loop-engineering/templates/08-final-verification.md`
- Delete: `assets/loop-engineering/templates/09-delivery-report.md`
- Delete: `assets/loop-engineering/templates/10-lessons-learned.md`
- Delete: `assets/loop-engineering/templates/learning-proposal.md`

**Interfaces:**
- Consumes: every runtime/Schema/Skill/Agent/build API from Tasks 1-13.
- Produces: `validatePlugin(root: string): Promise<ValidationReport>`; plugin `pi-loop-engineering` `0.3.0`; Node 22/24 Windows/Linux/macOS CI; a zero-failure `npm test` delivery gate.

- [ ] **Step 1: Write failing clean-break and delivery-contract tests**

```ts
test("plugin delivery is a Node-only four-command clean break", async () => {
  const report = await validatePlugin(root);
  assert.equal(report.pluginId, "pi-loop-engineering");
  assert.equal(report.version, "0.3.0");
  assert.deepEqual(report.skills, ["knowledge-evolution", "loop-engineering", "release", "status"]);
  assert.deepEqual(report.runtimeLanguages, ["JavaScript"]);
  assert.deepEqual(report.runtimeDependencies, []);
  assert.deepEqual(report.legacyRuntimeFiles, []);
});

test("Source and Runtime manifests bind deterministic reviewed code", async () => {
  const source = await buildSourceManifest(sourceOptions);
  const runtime = await buildRuntimeManifest(root);
  assert.ok(source.entries.some((entry) => entry.path === "package-lock.json"));
  assert.ok(runtime.entries.every((entry) => entry.path.startsWith("dist/")));
  assert.equal(await checkDist(root), true);
});
```

- [ ] **Step 2: Run the delivery test and capture expected branding/template failures**

Run: `npm run test:cli -- --test-name-pattern "plugin delivery|Source and Runtime"`

Expected: FAIL because the manifest is still Superworkflows, legacy templates remain, and the validator/CI are absent.

- [ ] **Step 3: Implement the final plugin validator and clean the legacy surface**

`validatePlugin` verifies:

```ts
export interface ValidationReport {
  pluginId: "pi-loop-engineering";
  version: "0.3.0";
  skills: readonly ["knowledge-evolution", "loop-engineering", "release", "status"];
  runtimeLanguages: readonly ["JavaScript"];
  runtimeDependencies: readonly [];
  legacyRuntimeFiles: readonly [];
  schemaCount: 18;
  markdownLanguages: readonly ["en-US", "zh-CN"];
  distMatchesSource: true;
}
```

It rejects Python/Shell control files, old Skill dirs/command aliases/Tombstones, `sw-*` profiles, `run_id`/`parent_run_id`/`.ai/runs` machine vocabulary, more than four Skill dirs, a Router Skill, npm runtime dependencies, missing license headers, broken Markdown links, non-English plugin-generated Schema fixtures, inconsistent versions, source maps with absolute paths, missing `dist` entry points, or `check:dist` mismatch.

Add the final validator to the aggregate only after `dist/cli/validate-plugin.js` exists:

```json
{
  "scripts": {
    "validate:plugin": "node dist/cli/validate-plugin.js",
    "test": "npm run typecheck && npm run schema:check && npm run test:unit && npm run test:cli && npm run test:faults && npm run check:dist && npm run validate:plugin"
  }
}
```

Delete the exact old templates listed above. Keep only two `LOOP` templates and two Knowledge Proposal templates. Do not add a Shell wrapper.

- [ ] **Step 4: Rewrite brand, compatibility, security, migration, and CI**

`plugin.json` uses name `pi-loop-engineering`, display name `PI Loop Engineering`, version `0.3.0`, tagline `From Prompt Engineering to Loop Engineering for Physical AI.`, Node `>=22` compatibility, and only the four command prompts. README first screens expand `PI = Physical AI`, explain Prompt-to-Loop Engineering, four commands, H0/H1, bounded parallelism, immutable Handoff, Release authorization, English-default/explicit-Chinese Markdown, Node-only committed runtime, CodeGraph fallback, and the clean-break migration. Changelogs state that old commands/state/Python are not supported. Security documents orchestration limits, host enforcement, evidence/hash-chain limits, secret handles, physical-action JIT authorization, and rollback.

CI uses:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
    node: [22, 24]
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: ${{ matrix.node }}
      cache: npm
  - run: npm ci --ignore-scripts
  - run: npm test
  - run: git diff --check
```

- [ ] **Step 5: Run the complete acceptance sequence**

Run: `npm ci --ignore-scripts`

Expected: PASS with a locked development toolchain and zero production dependencies.

Run: `npm run typecheck`

Expected: PASS with strict mode and no ignored diagnostics.

Run: `npm run schema:check`

Expected: PASS with 18 Schemas and workflow/type/validator parity.

Run: `npm run test:unit`

Expected: PASS with zero unexpected skips.

Run: `npm run test:cli`

Expected: PASS against committed `dist/`; a symlink test may skip only with an explicit host permission reason.

Run: `npm run test:faults`

Expected: PASS across atomic, ledger, Harness, dispatch, Handoff, and Release crash boundaries.

Run: `npm run check:dist`

Expected: PASS with byte-identical rebuilt ESM and no local absolute source-map paths.

Run: `npm run validate:plugin`

Expected: PASS with exactly four Skills, no Python/legacy runtime, correct brand/version/links/licenses, and no runtime npm dependencies.

Run: `npm test`

Expected: PASS; this repeats all delivery gates in one command.

Run: `git diff --check`

Expected: PASS.

Run: `git status --short`

Expected: only intentional Task 14 source, generated `dist`, documentation, CI, and deletion changes before commit.

- [ ] **Step 6: Commit the complete v0.3 delivery**

```powershell
git add .codex-plugin .github assets compatibility.json README.md README.zh-CN.md SECURITY.md CHANGELOG.md CHANGELOG.zh-CN.md src/cli/validate-plugin.ts test/cli/plugin-validation.test.ts package.json package-lock.json dist
git diff --cached --check
git commit -m "release: complete PI Loop Engineering v0.3"
```

## Plan Self-Review Checklist

- [ ] Spec sections 1-4 map to Tasks 1, 7, 12, 13, and 14: brand, clean break, exactly four commands, full Loop naming, no Init/aliases, and explicit Markdown language behavior.
- [ ] Spec sections 5-7 map to Tasks 2-7: phase/status split, all cancel/back edges, locale boundaries, canonical paths, WAL truth, snapshots, and fault recovery.
- [ ] Spec sections 8-12 map to Tasks 9-11: immutable/fresh Handoff, optional CodeGraph, independent Release, proposal-only Knowledge Evolution, and convergence errors.
- [ ] Spec section 13 maps to Tasks 5, 6, 8, and 9: H0/H1, Runtime Gate, WaveInput, Coordinator, bounded parallel dispatch, sealed results, independent Review, and environment DAG.
- [ ] Spec section 14 maps to Tasks 1, 2, 3, 5, and 14: strict TypeScript, committed ESM, standalone Validators, Source/Runtime manifests, zero runtime dependencies, and cross-platform process/storage rules.
- [ ] Spec sections 15-17 map to every task's focused tests and Task 14's full Windows/Linux/macOS Node 22/24 gate.
- [ ] No task refers to Python as an active runtime or leaves Shell control logic.
- [ ] Every consumed interface is produced by an earlier task and uses the same name and type.
- [ ] Every state-changing CLI validates Schema, Runtime Gate, Coordinator/lease, and Ledger transaction in that order.
- [ ] The plan contains no deferred implementation markers or unspecified compatibility work.
