# PAI Loop Engineering v0.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the clean-break `pai-loop-engineering` v0.3 plugin with four public commands, `.ai-loop/loop/<loop-id>/LOOP.json` plus `LOOP.md`, evidence-backed Loop/Handoff/Release/Evolution lifecycles, optional CodeGraph, bounded parallel Sub-agents, and cross-platform control-plane behavior.

**Architecture:** Keep `loopctl.py`, `releasectl.py`, `knowledgectl.py`, `triggerctl.py`, and `codegraphctl.py` as thin CLIs. Put reusable standard-library-only runtime logic in focused `scripts/pai_loop/` modules for locking, atomic storage, paths, manifests, ledgers, Harnesses, coordination, dispatch, Handoff, Release, and Knowledge Evolution. Treat JSON/JSONL as English-only machine contracts, render only Markdown in `en-US` or `zh-CN`, and preserve raw evidence verbatim.

**Tech Stack:** Python 3.10+ standard library (`tomli>=2.0` only on Python 3.10), JSON Schema Draft 2020-12 documents, Markdown Skill contracts, TOML Agent profiles, `unittest`, Git CLI, Codex plugin manifest.

## Global Constraints

- Clean break: do not retain aliases, tombstones, runtime migration, or old Skill directories for `$init`, `$run`, `$review`, or `$learn`.
- Public commands are exactly `$loop-engineering`, `$status`, `$release`, and `$knowledge-evolution`.
- Persistent root is exactly `.ai-loop/`; Loop directories are `.ai-loop/loop/<loop-id>/`; primary files are `LOOP.json` and `LOOP.md`.
- Public and machine contracts use `Loop`, `loop-id`, `loop_id`, `parent_loop_id`, `Loop schema`, `Loop ledger`, and `Child Loop`; do not introduce Run terminology.
- Only Markdown supports `en-US` and `zh-CN`; default is `en-US`; plugin-generated JSON/JSONL and every other non-Markdown artifact use English only.
- Raw user input, source text, stdout/stderr, simulator output, and device logs remain opaque/verbatim evidence and are never silently translated.
- CodeGraph is optional unless repository instructions require it; never auto-initialize a missing index.
- No explicit Release action, target, current immutable Handoff, scoped approval, and valid Action Envelope means no external or physical action.
- Harness enforcement claims must say `HOST_ENFORCED`, `RUNTIME_ENFORCED`, or `ORCHESTRATION_ONLY`; never claim OS-level isolation from plugin logic.
- Parallel writers require persistent Loops, disjoint declared read/write sets, independent Worktrees, cross-Loop leases, sealed results, and freshness rechecks; unknown read sets serialize.
- Windows, Linux, and macOS must run the same core tests; symlink tests may skip only when the platform cannot create symlinks.
- Preserve AGPL copyright terms and the dual-license notice in every new Python, Skill, and Agent source file; update the product-name line in active runtime headers to `PAI Loop Engineering`.

## File Responsibility Map

- `scripts/pai_loop/file_lock.py`: one cross-platform lock API used by every controller.
- `scripts/pai_loop/jsonio.py`: canonical JSON bytes, atomic replace, JSONL append, fsync, and English-generated-text checks.
- `scripts/pai_loop/schema.py`: runtime validation for domain records plus JSON Schema document/reference checks.
- `scripts/pai_loop/paths.py`: `.ai-loop` paths, Loop ID validation, symlink containment, Git common-dir resolution, and coordinator roots.
- `scripts/pai_loop/language.py`: Markdown locale selection and `LOOP.md` rendering only.
- `scripts/pai_loop/ledger.py`: event-chain replay, short WAL transactions, compare-and-swap, immutable transaction artifacts, and `LOOP.json` snapshots.
- `scripts/pai_loop/manifests.py`: Source/Tree/Workspace/Artifact manifests and WaveInput materialization.
- `scripts/pai_loop/harness.py`: H0/H1 creation, digesting, drift detection, enforcement classes, environment DAG, and Runtime Gate.
- `scripts/pai_loop/coordinator.py`: Git common-dir repository leases, fixed lock ordering, fencing tokens, and recovery.
- `scripts/pai_loop/dispatch.py`: reservation, Agent request/result validation, sealed bundles, stale-result detection, and serial integration admission.
- `scripts/pai_loop/review.py`: risk classification, independent Reviewer admission, Finding ownership, and Verdict aggregation.
- `scripts/pai_loop/handoff.py`: Checkpoints, transactional Finalize, immutable Handoff, freshness, and Child Loop requirement.
- `scripts/pai_loop/release.py`: readiness, Release records, Action Envelopes, commit packaging, JIT authorization, and reconciliation.
- `scripts/pai_loop/knowledge.py`: completed-Loop selection, proposal construction/review states, and proposal-only application boundary.
- `scripts/loopctl.py`: thin Loop/Harness/Dispatch/Handoff CLI.
- `scripts/releasectl.py`: thin Release CLI.
- `scripts/knowledgectl.py`: thin Knowledge Evolution CLI.
- `scripts/triggerctl.py`: side-effect-free four-route classifier.
- `scripts/codegraphctl.py`: capability resolver and existing-index health/sync controller; no initialization path.
- `scripts/validate_plugin.py`: final manifest, Skill, schema, fixture, Markdown-link, namespace, and clean-break validator.

---

### Task 1: Cross-platform locking and atomic I/O foundation

**Files:**
- Create: `scripts/pai_loop/__init__.py`
- Create: `scripts/pai_loop/errors.py`
- Create: `scripts/pai_loop/file_lock.py`
- Create: `scripts/pai_loop/jsonio.py`
- Create: `tests/test_file_lock.py`
- Create: `tests/test_jsonio.py`
- Modify: `scripts/sync_agents.py:20-110,285-305`
- Modify: `scripts/loopctl.py:20-220`

**Interfaces:**
- Produces: `LoopError`, `exclusive_lock(path: Path, *, blocking: bool = True) -> ContextManager[None]`, `canonical_bytes(value: Any) -> bytes`, `atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None`, `atomic_json(path: Path, value: Any) -> None`, and `append_jsonl(path: Path, value: Any) -> None`.
- Consumes: Python filesystem APIs only; no third-party package.

- [ ] **Step 1: Write failing platform and atomicity tests**

```python
def test_exclusive_lock_serializes_two_processes(self) -> None:
    first = self.spawn_lock_holder("first")
    self.assertEqual("locked:first", first.stdout.readline().strip())
    second = self.spawn_lock_holder("second", blocking=False)
    self.assertEqual(2, second.wait())

def test_atomic_json_preserves_previous_file_when_replace_fails(self) -> None:
    target = self.root / "state.json"
    atomic_json(target, {"sequence": 1})
    with mock.patch("os.replace", side_effect=OSError("injected")):
        with self.assertRaises(OSError):
            atomic_json(target, {"sequence": 2})
    self.assertEqual({"sequence": 1}, json.loads(target.read_text(encoding="utf-8")))
```

- [ ] **Step 2: Run the new tests and confirm the POSIX-only implementation fails on Windows**

Run: `python -m unittest tests.test_file_lock tests.test_jsonio -v`

Expected: FAIL because `scripts.pai_loop` does not exist; on Windows the current unconditional `fcntl` imports also remain unusable.

- [ ] **Step 3: Implement the portable lock and atomic I/O modules**

```python
@contextlib.contextmanager
def exclusive_lock(path: Path, *, blocking: bool = True) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            mode = msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK
            os.lseek(descriptor, 0, os.SEEK_SET)
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"0")
            msvcrt.locking(descriptor, mode, 1)
        else:
            import fcntl
            flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
            fcntl.flock(descriptor, flags)
        yield
    finally:
        unlock(descriptor)
        os.close(descriptor)
```

- [ ] **Step 4: Replace duplicated I/O and `fcntl` code in existing controllers**

```python
from pai_loop.errors import LoopError
from pai_loop.file_lock import exclusive_lock
from pai_loop.jsonio import append_jsonl, atomic_json, atomic_write, canonical_bytes
```

- [ ] **Step 5: Run focused and portability tests**

Run: `python -m unittest tests.test_file_lock tests.test_jsonio tests.test_sync_agents -v`

Expected: PASS; symlink tests skip only when Windows reports insufficient privilege.

- [ ] **Step 6: Commit the foundation**

```bash
git add scripts/pai_loop scripts/loopctl.py scripts/sync_agents.py tests/test_file_lock.py tests/test_jsonio.py tests/test_sync_agents.py
git commit -m "refactor: add portable Loop runtime primitives"
```

### Task 2: Canonical paths and Markdown-only localization

**Files:**
- Create: `scripts/pai_loop/paths.py`
- Create: `scripts/pai_loop/language.py`
- Create: `schemas/preferences.schema.json`
- Create: `tests/test_paths.py`
- Create: `tests/test_language.py`
- Modify: `scripts/loopctl.py:104-147,247-308,423-570`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 1 atomic I/O and `LoopError`.
- Produces: `LoopPaths.for_repo(repo: Path, loop_id: str | None = None) -> LoopPaths`, `validate_loop_id(value: str) -> str`, `resolve_coordinator_root(repo: Path) -> Path`, `select_markdown_language(explicit: str | None, preferences: Path) -> Literal["en-US", "zh-CN"]`, and `render_loop_markdown(state: Mapping[str, Any], language: str) -> str`.

- [ ] **Step 1: Write failing path and localization tests**

```python
def test_complete_loop_paths(self) -> None:
    paths = LoopPaths.for_repo(self.repo, "drive-stack-001")
    self.assertEqual(self.repo / ".ai-loop", paths.control)
    self.assertEqual(self.repo / ".ai-loop" / "loop" / "drive-stack-001", paths.loop)
    self.assertEqual(paths.loop / "LOOP.json", paths.state)
    self.assertEqual(paths.loop / "LOOP.md", paths.markdown)

def test_only_markdown_changes_language(self) -> None:
    english = render_loop_markdown(self.state, "en-US")
    chinese = render_loop_markdown(self.state, "zh-CN")
    self.assertIn("Problem and Contract", english)
    self.assertIn("问题与契约", chinese)
    self.assertEqual("zh-CN", select_markdown_language("zh-CN", self.preferences))
```

- [ ] **Step 2: Run tests and verify missing APIs fail**

Run: `python -m unittest tests.test_paths tests.test_language -v`

Expected: FAIL with missing `scripts.pai_loop.paths` and `scripts.pai_loop.language`.

- [ ] **Step 3: Implement immutable path objects and strict IDs**

```python
@dataclass(frozen=True)
class LoopPaths:
    repo: Path
    control: Path
    loop_root: Path
    loop: Path | None
    state: Path | None
    markdown: Path | None

    @classmethod
    def for_repo(cls, repo: Path, loop_id: str | None = None) -> "LoopPaths":
        control = repo.resolve() / ".ai-loop"
        loop_root = control / "loop"
        current = loop_root / validate_loop_id(loop_id) if loop_id else None
        return cls(repo.resolve(), control, loop_root, current,
                   current / "LOOP.json" if current else None,
                   current / "LOOP.md" if current else None)
```

- [ ] **Step 4: Implement Markdown locale precedence and rendering**

```python
SUPPORTED = ("en-US", "zh-CN")

def select_markdown_language(explicit: str | None, preferences: Path) -> str:
    configured = load_optional_preferences(preferences).get("markdown_language")
    selected = explicit or configured or "en-US"
    if selected not in SUPPORTED:
        raise LoopError("INVALID_MARKDOWN_LANGUAGE: expected en-US or zh-CN")
    return selected
```

- [ ] **Step 5: Remove bootstrap semantics and use `.ai-loop` exclusions**

Change workspace Git pathspec exclusions to `:(exclude).ai-loop`; make `start` create required control directories atomically; reject legacy `.ai/runs/` as unsupported state without reading or migrating it.

- [ ] **Step 6: Run focused tests**

Run: `python -m unittest tests.test_paths tests.test_language tests.test_loopctl.LoopctlTests.test_start_creates_complete_loop_paths -v`

Expected: PASS and no `.ai/` directory is created.

- [ ] **Step 7: Commit path and language contracts**

```bash
git add .gitignore scripts/pai_loop/paths.py scripts/pai_loop/language.py scripts/loopctl.py schemas/preferences.schema.json tests/test_paths.py tests/test_language.py tests/test_loopctl.py
git commit -m "feat: establish complete Loop persistence naming"
```

### Task 3: Workflow spec v2 and schema family

**Files:**
- Delete: `schemas/run-state.schema.json`
- Create: `schemas/loop-state.schema.json`
- Create: `schemas/manifest.schema.json`
- Create: `schemas/repository-coordinator.schema.json`
- Create: `schemas/knowledge-proposal.schema.json`
- Modify: `schemas/event.schema.json`
- Modify: `schemas/agent-result.schema.json`
- Create: `schemas/h0-discovery.schema.json`
- Create: `schemas/h1-execution.schema.json`
- Create: `schemas/wave-input.schema.json`
- Create: `schemas/agent-request.schema.json`
- Create: `schemas/agent-bundle.schema.json`
- Create: `schemas/evidence.schema.json`
- Create: `schemas/checkpoint.schema.json`
- Create: `schemas/handoff.schema.json`
- Create: `schemas/release.schema.json`
- Create: `schemas/release-action.schema.json`
- Create: `scripts/pai_loop/schema.py`
- Modify: `assets/loop-engineering/workflow-spec.json`
- Create: `tests/test_schemas.py`

**Interfaces:**
- Produces: workflow schema version `2`, Loop schema version `2`, the phase/status overlay contract, enforcement classes, environment owners, event types, canonical required fields used by every later task, `validate_record(schema_name: str, value: Mapping[str, Any]) -> None`, and `validate_schema_set(root: Path) -> list[str]`.
- Consumes: exact phases/statuses and persistence language rules from the approved design.

- [ ] **Step 1: Write failing schema contract tests**

```python
def test_workflow_v2_is_closed(self) -> None:
    spec = self.load("assets/loop-engineering/workflow-spec.json")
    self.assertEqual(2, spec["schema_version"])
    self.assertEqual("NEW", spec["initial_phase"])
    self.assertEqual("HANDOFF_READY", spec["complete_phase"])
    self.assertNotIn("INTEGRATING", spec["phases"])
    self.assertEqual(set(spec["phases"]), set(spec["transitions"]))

def test_loop_schema_has_only_loop_identity(self) -> None:
    schema = self.load("schemas/loop-state.schema.json")
    self.assertIn("loop_id", schema["required"])
    self.assertNotIn("run_id", json.dumps(schema))

def test_representative_records_pass_runtime_validation(self) -> None:
    for schema_name, fixture in self.representative_records():
        validate_record(schema_name, fixture)
    self.assertEqual([], validate_schema_set(PLUGIN / "schemas"))
```

- [ ] **Step 2: Run schema tests and verify v1 fails**

Run: `python -m unittest tests.test_schemas -v`

Expected: FAIL because the workflow and schema are still v1.

- [ ] **Step 3: Replace the workflow state machine**

```json
{
  "schema_version": 2,
  "initial_phase": "NEW",
  "complete_phase": "HANDOFF_READY",
  "phases": ["NEW", "ORIENTING", "CONTRACTED", "PLANNED", "PLAN_REVIEW", "HARNESSING", "IMPLEMENTING", "VERIFYING", "REVIEWING", "REMEDIATING", "FINALIZING", "HANDOFF_READY", "CANCELLED"],
  "loop_statuses": ["ACTIVE", "DEGRADED", "PAUSED", "BLOCKED", "NON_CONVERGENT", "COMPLETE", "CANCELLED"]
}
```

- [ ] **Step 4: Write exact Draft 2020-12 schemas and runtime validators**

Require `loop_id`, `parent_loop_id`, `phase`, `status`, `markdown_language`, current H0/H1 digests, `last_event_seq`, `previous_event_hash`, evidence indexes, findings, budgets, and Handoff pointer. Set `additionalProperties: false` for control envelopes; allow explicit `verbatim` evidence payload references without localizing them. Implement standard-library domain validators for required fields, enums, IDs, hashes, and cross-field invariants; validate every schema document, local `$ref`, and representative instance without making a third-party validator a runtime dependency.

- [ ] **Step 5: Run structural schema checks**

Run: `python -m unittest tests.test_schemas -v`

Expected: PASS with no `run_id`, v1 phase, or old persistence path in any v2 schema; every local `$ref` resolves and every representative machine record passes its runtime validator.

- [ ] **Step 6: Commit workflow and schemas**

```bash
git add assets/loop-engineering/workflow-spec.json schemas scripts/pai_loop/schema.py tests/test_schemas.py
git commit -m "feat: define Loop workflow and schema v2"
```

### Task 4: Transactional Loop ledger and CLI core

**Files:**
- Create: `scripts/pai_loop/ledger.py`
- Create: `scripts/pai_loop/harness.py` with H0 discovery only
- Rewrite: `scripts/loopctl.py`
- Rewrite: `tests/test_loopctl.py`
- Create: `tests/test_ledger_recovery.py`

**Interfaces:**
- Consumes: Tasks 1-3 primitives, paths, workflow spec, and schemas.
- Produces: `LoopLedger.create(repo: Path, loop_id: str, title: str, markdown_language: str, parent_loop_id: str | None, actor: str) -> LoopLedger`, `LoopLedger.open(repo: Path, loop_id: str) -> LoopLedger`, `read() -> dict[str, Any]`, `transact(event_type: str, actor: str, expected_seq: int, mutate: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]`, `recover() -> dict[str, Any]`, `forge_h0(repo: Path, loop_id: str, read_scope: Sequence[str]) -> dict[str, Any]`, plus CLI commands `start`, `status`, `resume`, `transition`, `finding-open`, `finding-update`, and `validate` using `--loop-id`.

- [ ] **Step 1: Write failing clean-break and recovery tests**

```python
def test_start_writes_loop_json_and_single_loop_markdown(self) -> None:
    result = self.loopctl("start", "--root", str(self.repo), "--loop-id", "nav-001", "--title", "Navigation")
    self.assertEqual(0, result.returncode, result.stderr)
    loop = self.repo / ".ai-loop" / "loop" / "nav-001"
    self.assertTrue((loop / "LOOP.json").is_file())
    self.assertTrue((loop / "LOOP.md").is_file())
    self.assertFalse((loop / "run.json").exists())

def test_recovery_ignores_uncommitted_transaction_artifacts(self) -> None:
    self.inject_failure("after-rename-before-commit")
    recovered = LoopLedger.open(self.repo, "nav-001").recover()
    self.assertEqual(self.last_committed_sequence, recovered["last_event_seq"])
```

- [ ] **Step 2: Run ledger tests and confirm current controller fails**

Run: `python -m unittest tests.test_loopctl tests.test_ledger_recovery -v`

Expected: FAIL on `.ai/runs`, `run.json`, v1 state, and missing WAL APIs.

- [ ] **Step 3: Implement the ledger transaction API**

```python
class LoopLedger:
    def transact(self, event_type: str, actor: str, expected_seq: int,
                 mutate: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
        with exclusive_lock(self.paths.lock):
            current = self.read()
            if current["last_event_seq"] != expected_seq:
                raise LoopError("STALE_LOOP_SEQUENCE")
            intent = self._append_intent(event_type, actor, expected_seq)
            candidate = mutate(copy.deepcopy(current))
            self._write_pending(intent["transaction_id"], candidate)
            self._commit_intent(intent, candidate)
            atomic_json(self.paths.state, candidate)
            return candidate
```

- [ ] **Step 4: Implement automatic start and exact resume**

`start` must select `markdown_language` before any write, forge and persist immutable H0 discovery, write one `LOOP_STARTED` transaction, and render `LOOP.md`. `resume` accepts only exact `--loop-id`, checks lineage/repository/workspace/spec/H0 facts, and refuses completed Loops. Task 6 extends the same Harness module with H1 and Runtime Gate; it does not replace the H0 contract.

- [ ] **Step 5: Implement phase/status overlay transitions**

Allow only workflow-spec v2 edges; treat `PAUSED`, `BLOCKED`, and `DEGRADED` as overlays; make `NON_CONVERGENT`, `COMPLETE`, and `CANCELLED` terminal; require Child Loop creation after terminal status.

- [ ] **Step 6: Run fault-injection and core tests**

Run: `python -m unittest tests.test_loopctl tests.test_ledger_recovery -v`

Expected: PASS for every intent/write/rename/commit/snapshot injection point and exact-resume case.

- [ ] **Step 7: Commit the Loop ledger**

```bash
git add scripts/pai_loop/ledger.py scripts/pai_loop/harness.py scripts/loopctl.py tests/test_loopctl.py tests/test_ledger_recovery.py
git commit -m "feat: implement transactional Loop ledger"
```

### Task 5: Reproducible manifests and evidence capture

**Files:**
- Create: `scripts/pai_loop/manifests.py`
- Modify: `scripts/loopctl.py`
- Create: `tests/test_manifests.py`
- Create: `tests/test_evidence.py`

**Interfaces:**
- Consumes: Loop paths/ledger and evidence schema.
- Produces: `build_workspace_manifest(repo: Path, policy: Mapping[str, Any]) -> dict[str, Any]`, `build_wave_input_manifest(repo: Path, policy: Mapping[str, Any]) -> dict[str, Any]`, `capture_evidence(repo: Path, loop_id: str, request: Mapping[str, Any]) -> dict[str, Any]`, and `verify_evidence(repo: Path, record: Mapping[str, Any]) -> dict[str, Any]`. Task 7 owns reservation-safe WaveInput sealing.

- [ ] **Step 1: Write failing dirty-workspace and evidence tests**

```python
def test_manifest_binds_tracked_untracked_ignored_and_external_inputs(self) -> None:
    manifest = build_workspace_manifest(self.repo, self.policy)
    self.assertEqual({"tracked.py", "new.yaml", "model.bin"}, set(manifest["behavior_paths"]))
    self.assertNotIn(".ai-loop", json.dumps(manifest))
    self.assertNotIn(".codegraph", json.dumps(manifest))

def test_verbatim_stdout_does_not_localize_metadata(self) -> None:
    evidence = self.capture(stdout="测试通过\n")
    self.assertEqual("测试通过\n", Path(evidence["stdout_path"]).read_text(encoding="utf-8"))
    self.assertEqual("PASS", evidence["result"])
```

- [ ] **Step 2: Run the tests and confirm manifest coverage is missing**

Run: `python -m unittest tests.test_manifests tests.test_evidence -v`

Expected: FAIL because current snapshots hash Git status/diff without a content manifest or WaveInput.

- [ ] **Step 3: Implement shared inclusion/exclusion rules**

Use one schema for Source/Tree/Workspace manifests. Always exclude `.git/`, `.ai-loop/`, `.codegraph/`, declared Scratch/Cache, and only those items. Record path, mode, kind, digest, provenance, materialization method, and behavior relevance for tracked, untracked, ignored, submodule, symlink, and external artifacts.

- [ ] **Step 4: Implement evidence execution and freshness**

Bind every Evidence record to `loop_id`, `work_item_id`, `attempt`, actor role, H1 digest, WaveInput digest, output tree, exact argv/cwd, timestamps, exit code, sanitized environment fingerprint, tool versions, stdout/stderr digests, and artifact digests.

- [ ] **Step 5: Run focused tests**

Run: `python -m unittest tests.test_manifests tests.test_evidence -v`

Expected: PASS for clean/dirty repositories, ignored model assets, non-ASCII raw logs, tampering, stale WaveInput, symlinks, and external read-only inputs.

- [ ] **Step 6: Commit manifests and evidence**

```bash
git add scripts/pai_loop/manifests.py scripts/loopctl.py tests/test_manifests.py tests/test_evidence.py
git commit -m "feat: bind Loop evidence to reproducible manifests"
```

### Task 6: H0/H1 Harness Foundry and Runtime Gate

**Files:**
- Modify: `scripts/pai_loop/harness.py`
- Modify: `scripts/loopctl.py`
- Create: `tests/test_harness.py`
- Create: `tests/fixtures/harness/valid-h0.json`
- Create: `tests/fixtures/harness/valid-h1.json`

**Interfaces:**
- Consumes: Ledger, manifests, workflow spec, H0/H1 schemas.
- Produces: frozen `GateRequest(loop_id: str, kind: str, path: str | None, actor_id: str | None, wave_input_digest: str | None)` and `GateDecision(status: str, code: str)` records; `forge_h1(repo: Path, loop_id: str, plan: Mapping[str, Any], plan_review: Mapping[str, Any]) -> dict[str, Any]`; `detect_harness_drift(h1: Mapping[str, Any], changed_paths: set[str], changed_facts: Mapping[str, Any]) -> dict[str, Any]`; and `RuntimeGate(repo: Path).admit(request: GateRequest) -> GateDecision`. `forge_h0(...)` remains the Task 4 interface; `plan_review` must bind the reviewed plan digest, reviewer, verdict, and risk class rather than accepting a Boolean bypass.

- [ ] **Step 1: Write failing Harness admission tests**

```python
def test_no_h1_no_engineering_write(self) -> None:
    decision = self.gate.admit(GateRequest(kind="SOURCE_WRITE", path="src/control.py"))
    self.assertEqual("REJECT", decision.status)
    self.assertEqual("NO_CURRENT_H1", decision.code)

def test_plan_scope_change_requires_replanning(self) -> None:
    drift = detect_harness_drift(self.h1, changed_paths={"new/module.py"}, changed_facts={})
    self.assertEqual("PLANNED", drift["required_phase"])
```

- [ ] **Step 2: Run Harness tests and confirm missing runtime gate**

Run: `python -m unittest tests.test_harness -v`

Expected: FAIL with missing Harness module.

- [ ] **Step 3: Implement immutable H0 and H1 forging**

H0 binds repository/read scope/repository rules/retrieval/network/prohibited actions. H1 binds Loop identity, initial/WaveInput policy, allowed/denied paths, artifacts, DAG, actors, capabilities, enforcement class, budgets, gates, stop rules, and result schemas. Normalize and SHA-256 each revision; never overwrite an old revision.

- [ ] **Step 4: Implement Runtime Gate enforcement**

```python
class RuntimeGate:
    def admit(self, request: GateRequest) -> GateDecision:
        harness = self.current_harness(request.loop_id)
        if request.kind in WRITE_KINDS and harness.kind != "H1":
            return GateDecision("REJECT", "NO_CURRENT_H1")
        if request.path and not harness.scope.allows(request.path):
            return GateDecision("REJECT", "PATH_OUTSIDE_HARNESS")
        return GateDecision("ADMIT", "OK")
```

- [ ] **Step 5: Add environment DAG ownership validation**

Validate the repository-defined DAG and support the default vocabulary `SOURCE/STATIC`, `UNIT/COMPONENT`, `REPLAY`, `SIMULATION`, `SIL`, `HIL`, `BENCH`, `CLOSED_COURSE`, and `REAL_VEHICLE/ROBOT` without treating it as a linear maturity ladder. Require every node to declare `LOOP_REQUIRED`, `RELEASE_REQUIRED`, or `NOT_APPLICABLE`; require a reason for `NOT_APPLICABLE`; reject any node needing a new physical action when marked `LOOP_REQUIRED`.

- [ ] **Step 6: Run Harness and transition tests**

Run: `python -m unittest tests.test_harness tests.test_loopctl -v`

Expected: PASS for H0 read-only behavior, H1 creation after plan review, drift, scope checks, enforcement labels, and environment ownership.

- [ ] **Step 7: Commit Harness Foundry**

```bash
git add scripts/pai_loop/harness.py scripts/loopctl.py tests/test_harness.py tests/fixtures/harness
git commit -m "feat: enforce per-Loop Runtime Harnesses"
```

### Task 7: Repository coordinator and WaveInput leases

**Files:**
- Create: `scripts/pai_loop/coordinator.py`
- Modify: `scripts/pai_loop/manifests.py`
- Create: `tests/test_coordinator.py`

**Interfaces:**
- Consumes: Cross-platform locks, paths, manifests, ledger.
- Produces: `Lease(lease_id: str, fencing_token: int, expires_at: str).release() -> None`; `RepositoryCoordinator.for_repo(repo: Path) -> RepositoryCoordinator`; `reserve_paths(loop_id: str, paths: set[str], ttl_seconds: int = 300) -> Lease`; `reserve_integration(loop_id: str, branch: str, ttl_seconds: int = 300) -> Lease`; `next_fencing_token() -> int`; `seal_wave_input(loop_id: str, policy: Mapping[str, Any]) -> dict[str, Any]`; and `reconcile(now: datetime) -> dict[str, Any]`.

- [ ] **Step 1: Write failing cross-Worktree lease tests**

```python
def test_two_worktrees_share_one_git_common_coordinator(self) -> None:
    left = RepositoryCoordinator.for_repo(self.worktree_a)
    right = RepositoryCoordinator.for_repo(self.worktree_b)
    self.assertEqual(left.root, right.root)
    lease = left.reserve_paths("loop-a", {"src/control.py"})
    with self.assertRaises(LoopError):
        right.reserve_paths("loop-b", {"src/control.py"})
    lease.release()
```

- [ ] **Step 2: Run tests and verify per-Worktree state fails**

Run: `python -m unittest tests.test_coordinator -v`

Expected: FAIL because no Git common-dir coordinator exists.

- [ ] **Step 3: Implement fixed lock ordering and leases**

Resolve `<git-common-dir>/pai-loop-engineering/coordination/` for Git repositories and `.ai-loop/coordination/` otherwise. Always acquire Repository Coordinator before Loop ledger locks. Store short lease transactions and monotonic fencing tokens in `repository.json` plus `events.jsonl`.

- [ ] **Step 4: Implement immutable WaveInput sealing**

Seal a content-addressed manifest only when no write Wave is active. Verify each Worktree materializes the same WaveInput without changing the user's index.

- [ ] **Step 5: Run concurrency and recovery tests**

Run: `python -m unittest tests.test_coordinator -v`

Expected: PASS for conflicting paths, branch/integration leases, expired lease reconciliation, monotonic fencing, dirty Worktrees, and interrupted transactions.

- [ ] **Step 6: Commit coordinator support**

```bash
git add scripts/pai_loop/coordinator.py scripts/pai_loop/manifests.py tests/test_coordinator.py
git commit -m "feat: coordinate Loops across Git worktrees"
```

### Task 8: Dispatch Broker and sealed Agent results

**Files:**
- Create: `scripts/pai_loop/dispatch.py`
- Modify: `scripts/loopctl.py`
- Create: `tests/test_dispatch.py`

**Interfaces:**
- Consumes: H1, Runtime Gate, Repository Coordinator, WaveInput, Agent schemas.
- Produces: frozen `Reservation(reservation_id: str, fencing_token: int, attempt_root: Path)` with `cancel() -> None`, `SealedBundle(digest: str, path: Path)`, and `IntegrationDecision(status: str, code: str)`; `DispatchBroker(repo: Path, loop_id: str).reserve(request: Mapping[str, Any]) -> Reservation`; `accept_result(result_path: Path) -> SealedBundle`; `admit_integration(bundle_digest: str) -> IntegrationDecision`; and CLI commands `dispatch-reserve`, `dispatch-accept`, `dispatch-integrate`, `dispatch-reconcile`.

- [ ] **Step 1: Write failing DAG/read-write conflict tests**

```python
def test_unknown_read_set_serializes(self) -> None:
    first = self.broker.reserve(self.request("a", reads={"src/a.py"}, writes={"src/b.py"}))
    with self.assertRaisesRegex(LoopError, "DISPATCH_REJECTED"):
        self.broker.reserve(self.request("b", reads=None, writes={"src/c.py"}))
    first.cancel()

def test_intervening_integration_stales_result(self) -> None:
    bundle = self.complete_agent(reads={"schema/api.json"}, writes={"src/client.py"})
    self.integrate_change({"schema/api.json"})
    self.assertEqual("STALE_AGENT_RESULT", self.broker.admit_integration(bundle.digest).code)
```

- [ ] **Step 2: Run Dispatch tests and verify missing Broker**

Run: `python -m unittest tests.test_dispatch -v`

Expected: FAIL with missing Dispatch Broker.

- [ ] **Step 3: Implement atomic reservation**

Validate H1, dependency readiness, WaveInput, Actor role/model class, concurrency/attempt budgets, environment ownership, declared read/write sets, Worktree mapping, and repository leases in one short transaction. Release all locks before starting the Agent.

- [ ] **Step 4: Implement independent result sealing**

Inspect the Attempt root and allowed external roots independently; enumerate tracked/untracked/ignored/rename/symlink/submodule changes; reject undeclared writes; seal a content-addressed patch/output-tree/artifact bundle; never integrate from a mutable live Worktree.

- [ ] **Step 5: Implement serial integration admission**

Recheck fencing token, current tree, intervening integrations, declared reads, actual writes, Evidence, and bundle digest. Mark stale bundles without automatic rebase/merge. Keep the parent as the sole Loop ledger writer and integrator.

- [ ] **Step 6: Run Broker tests**

Run: `python -m unittest tests.test_dispatch -v`

Expected: PASS for ready-set DAGs, disjoint parallel writers, unknown reads, external write containment, fencing, forged results, stale bundles, crash recovery, and serial integration.

- [ ] **Step 7: Commit Dispatch Broker**

```bash
git add scripts/pai_loop/dispatch.py scripts/loopctl.py tests/test_dispatch.py
git commit -m "feat: add bounded parallel Dispatch Broker"
```

### Task 9: Checkpoints, Final Handoff, and read-only status

**Files:**
- Create: `scripts/pai_loop/review.py`
- Create: `scripts/pai_loop/handoff.py`
- Modify: `scripts/loopctl.py`
- Modify: `skills/status/SKILL.md`
- Modify: `skills/status/agents/openai.yaml`
- Create: `tests/test_handoff.py`
- Create: `tests/test_review.py`
- Create: `tests/test_status.py`

**Interfaces:**
- Consumes: Ledger, manifests, Harness, Dispatch bundles, Evidence.
- Produces: `classify_risk(contract: Mapping[str, Any], diff: Mapping[str, Any]) -> Literal["LOW", "MEDIUM", "HIGH"]`; `admit_reviewer(repo: Path, loop_id: str, reviewer_id: str, source_digest: str) -> dict[str, Any]`; `record_finding(repo: Path, loop_id: str, finding: Mapping[str, Any]) -> dict[str, Any]`; `verify_finding(repo: Path, loop_id: str, finding_id: str, reviewer_id: str, evidence_digest: str) -> dict[str, Any]`; `write_checkpoint(repo: Path, loop_id: str, reason: str) -> dict[str, Any]`; `finalize_loop(repo: Path, loop_id: str) -> dict[str, Any]`; `verify_handoff(repo: Path, loop_id: str) -> dict[str, Any]`; `require_child_loop(repo: Path, loop_id: str) -> None`; and read-only status summaries.

- [ ] **Step 1: Write failing immutable-Handoff tests**

```python
def test_finalize_writes_one_committed_handoff(self) -> None:
    handoff = finalize_loop(self.repo, self.loop_id)
    self.assertEqual(handoff["digest"], verify_handoff(self.repo, self.loop_id)["digest"])
    with self.assertRaisesRegex(LoopError, "COMPLETE_LOOP_IMMUTABLE"):
        finalize_loop(self.repo, self.loop_id)

def test_release_state_does_not_stale_handoff(self) -> None:
    before = verify_handoff(self.repo, self.loop_id)
    self.write_release_record()
    self.assertEqual(before["digest"], verify_handoff(self.repo, self.loop_id)["digest"])

def test_implementer_cannot_verify_own_finding(self) -> None:
    finding = self.record_finding(owner="implementer")
    with self.assertRaisesRegex(LoopError, "INDEPENDENT_REVIEW_REQUIRED"):
        verify_finding(self.repo, self.loop_id, finding["finding_id"], "implementer", self.evidence_digest)
```

- [ ] **Step 2: Run Handoff/status tests and verify missing Finalize**

Run: `python -m unittest tests.test_review tests.test_handoff tests.test_status -v`

Expected: FAIL because current controller completes inside the monolithic state machine and has no immutable Handoff.

- [ ] **Step 3: Implement risk-adaptive independent Review**

Classify every change as Low/Medium/High from contract, affected paths, safety/security surface, and physical impact. All levels retain independent Review; risk changes review breadth and required specialists, not whether Review occurs. Give Reviewer a read-only Source snapshot, specification/acceptance, Base/Head coordinates, Diff, and compact evidence—not the implementer's conclusions. Redirect Cache/Temp/Coverage/output; any source/shared-resource side effect requires a dedicated Worktree and lease. Only an independent Reviewer may move a Finding from `FIXED` to `VERIFIED` against the current digest.

- [ ] **Step 4: Implement transactional Checkpoint and Finalize**

Use `handoff.pending.<transaction-id>.json`, `FINALIZE_INTENT`, atomic rename, `FINALIZE_COMMIT`, then the `LOOP.json` pointer. Bind Markdown Language, Source/Tree/Workspace manifests, Project Policy, `LOOP.md`, H0/H1, sealed bundles, fixed Loop Evidence, findings/review, rollback, residual risk, environment gates, and event sequence.

- [ ] **Step 5: Implement freshness and Child Loop behavior**

Source/config/H1/Loop Evidence changes return `STALE_HANDOFF`. Release and coordinator records are outside the freshness domain. A completed stale Loop is never resumed or rewritten; create a Child Loop referencing the original Loop/Handoff.

- [ ] **Step 6: Rewrite `$status` as a read-only consumer**

Require exact `loop-id` for deep inspection; list candidates otherwise. Report phase/status, Harness digest/drift, reservations/leases, budgets, Evidence, findings, Handoff, Release state, blockers, and next action without creating or repairing state.

- [ ] **Step 7: Run Review/Handoff/status tests**

Run: `python -m unittest tests.test_review tests.test_handoff tests.test_status -v`

Expected: PASS for Low/Medium/High classification, independent Reviewer ownership, read-only Source snapshots, Finding closure, partial Checkpoints, crash recovery, one immutable Final Handoff, stale detection, Child Loop, read-only status, and Markdown display language without persistent rewrite.

- [ ] **Step 8: Commit Review, Handoff, and status**

```bash
git add scripts/pai_loop/review.py scripts/pai_loop/handoff.py scripts/loopctl.py skills/status tests/test_review.py tests/test_handoff.py tests/test_status.py
git commit -m "feat: finalize Loops through immutable Handoffs"
```

### Task 10: Separate Release lifecycle and Action Envelopes

**Files:**
- Create: `scripts/pai_loop/release.py`
- Create: `scripts/releasectl.py`
- Rewrite: `skills/release/SKILL.md`
- Modify: `skills/release/agents/openai.yaml`
- Create: `tests/test_releasectl.py`

**Interfaces:**
- Consumes: Immutable Handoff and Release schemas.
- Produces: `readiness(repo: Path, loop_id: str) -> dict[str, Any]`; `create_action_envelope(repo: Path, loop_id: str, action: str, target: str, approval: Mapping[str, Any]) -> dict[str, Any]`; `begin_action(repo: Path, envelope_id: str) -> dict[str, Any]`; `reconcile_action(repo: Path, action_id: str) -> dict[str, Any]`; and CLI commands `readiness`, `authorize`, `begin`, `reconcile`.

- [ ] **Step 1: Write failing readiness/action tests**

```python
def test_readiness_is_memory_only(self) -> None:
    result = self.release("readiness", "--loop-id", self.loop_id)
    self.assertEqual(0, result.returncode)
    self.assertFalse((self.repo / ".ai-loop" / "releases").exists())

def test_commit_requires_content_identical_tree(self) -> None:
    envelope = self.authorize("commit")
    self.edit_source_after_handoff()
    self.assertEqual("STALE_HANDOFF", self.begin(envelope)["code"])
```

- [ ] **Step 2: Run Release tests and confirm monolithic actions fail**

Run: `python -m unittest tests.test_releasectl -v`

Expected: FAIL because approvals/actions still live inside the Loop state machine.

- [ ] **Step 3: Implement memory-only readiness**

Implement Readiness-only verification of terminal Handoff, freshness, rollback, unresolved findings, Release-required environment nodes, and recommended actions. Do not create `.ai-loop/releases/` until an explicit action is requested.

- [ ] **Step 4: Implement Release records and Action Envelopes**

Bind action, target, Handoff digest, source head, reviewed tree, expected parent, commit metadata digest, allowed tools, authorization identity/time/expiry, and environment node. Release Evidence chains to Handoff but never mutates its digest.

- [ ] **Step 5: Implement commit packaging and reconciliation**

Permit `commit` only when the resulting Git Tree equals `reviewed_tree_digest`. Require the verified Release Commit for push/PR/tag/publish/deploy. Before hardware actions, require a fresh JIT confirmation. Record Intent before execution; reconcile `PENDING`/`UNKNOWN` instead of blind retry. Keep mutable Release records and Release Evidence outside the immutable Handoff freshness domain, while rechecking the Handoff-bound source/H1/Loop Evidence before every action so Release never invalidates itself merely by recording progress.

- [ ] **Step 6: Run Release tests**

Run: `python -m unittest tests.test_releasectl -v`

Expected: PASS for readiness-only, stale/partial Handoff refusal, content-identical commit, action/target/expiry binding, idempotency, unknown-result reconciliation, and JIT hardware confirmation.

- [ ] **Step 7: Commit Release lifecycle**

```bash
git add scripts/pai_loop/release.py scripts/releasectl.py skills/release tests/test_releasectl.py
git commit -m "feat: separate Release from Loop execution"
```

### Task 11: Proposal-only Knowledge Evolution

**Files:**
- Create: `scripts/pai_loop/knowledge.py`
- Create: `scripts/knowledgectl.py`
- Create: `assets/loop-engineering/templates/knowledge-proposal.md`
- Create: `skills/knowledge-evolution/SKILL.md`
- Create: `skills/knowledge-evolution/agents/openai.yaml`
- Delete: `skills/learn/`
- Create: `tests/test_knowledgectl.py`

**Interfaces:**
- Consumes: completed Loop/Handoff and completed Release records.
- Produces: `collect_observations(repo: Path, loop_ids: Sequence[str]) -> list[dict[str, Any]]`; `build_proposal(repo: Path, observations: Sequence[Mapping[str, Any]]) -> dict[str, Any]`; `review_proposal(repo: Path, proposal_id: str, verdict: str, reviewer: str) -> dict[str, Any]`; `mark_applied(repo: Path, proposal_id: str, child_loop_id: str) -> dict[str, Any]`; and CLI commands `propose`, `review`, `mark-applied`.

- [ ] **Step 1: Write failing evolution-boundary tests**

```python
def test_active_loop_cannot_be_promoted(self) -> None:
    result = self.knowledge("propose", "--loop-id", self.active_loop)
    self.assertEqual(2, result.returncode)
    self.assertFalse(list((self.repo / ".ai-loop" / "knowledge").rglob("*.md")))

def test_single_loop_proposal_is_provisional(self) -> None:
    proposal = self.propose(self.completed_loop)
    self.assertEqual("PROVISIONAL", proposal["status"])
    self.assertFalse(proposal["applies_changes"])
```

- [ ] **Step 2: Run Knowledge tests and verify old Learn behavior fails**

Run: `python -m unittest tests.test_knowledgectl -v`

Expected: FAIL because no proposal-only controller or `$knowledge-evolution` Skill exists.

- [ ] **Step 3: Implement evidence-backed proposal construction**

Require source Loop/Handoff digests, observation count, user-correction provenance, counterexamples, privacy review, benefit, safety impact, offline evaluation, Canary, Rollback, and review date. Mark one-Loop candidates `PROVISIONAL` unless they encode an explicit user correction.

- [ ] **Step 4: Enforce proposal-only application**

Never edit Policy, Skill, Agent, template, or active Loop. An approved proposal is applied only by a new `$loop-engineering` Child Loop; mark `APPLIED` only after that Loop has a valid Final Handoff.

- [ ] **Step 5: Run Knowledge tests**

Run: `python -m unittest tests.test_knowledgectl -v`

Expected: PASS for active-loop refusal, provenance/privacy fields, Provisional/Review states, no self-modification, and new-Loop application linkage.

- [ ] **Step 6: Commit Knowledge Evolution**

```bash
git add scripts/pai_loop/knowledge.py scripts/knowledgectl.py assets/loop-engineering/templates/knowledge-proposal.md skills/knowledge-evolution tests/test_knowledgectl.py
git rm -r skills/learn
git commit -m "feat: add proposal-only Knowledge Evolution"
```

### Task 12: Optional CodeGraph and four-command routing surface

**Files:**
- Modify: `scripts/codegraphctl.py`
- Modify: `scripts/triggerctl.py`
- Move: `assets/loop-engineering/trigger-policy.json` -> `assets/router/trigger-policy.json`
- Modify: `tests/trigger-cases.json`
- Rewrite: `tests/test_codegraphctl.py`
- Rewrite: `tests/test_triggerctl.py`
- Create: `skills/loop-engineering/SKILL.md`
- Create: `skills/loop-engineering/agents/openai.yaml`
- Delete: `skills/init/`
- Delete: `skills/run/`
- Delete: `skills/review/`
- Delete: `skills/superworkflows/`
- Create: `assets/loop-engineering/review.md`

**Interfaces:**
- Consumes: working Loop/Handoff/Release/Knowledge controllers.
- Produces: routes `loop-engineering`, `status`, `release`, `knowledge-evolution`; CodeGraph capability results `MCP`, `CLI`, `NATIVE`, `BLOCKED`, `DEGRADED`.

- [ ] **Step 1: Write failing route and capability tests**

```python
def test_public_surface_has_exactly_four_routes(self) -> None:
    self.assertEqual({"loop-engineering", "status", "release", "knowledge-evolution"}, set(self.policy["routes"]))

def test_missing_codegraph_uses_native_fallback(self) -> None:
    result = self.resolve(index=False, cli=False, required=False)
    self.assertEqual("NATIVE", result.mode)
    self.assertEqual([], result.actions)
```

- [ ] **Step 2: Run route/CodeGraph tests and verify old taxonomy fails**

Run: `python -m unittest tests.test_triggerctl tests.test_codegraphctl -v`

Expected: FAIL on seven routes, initialization behavior, and old Skill names.

- [ ] **Step 3: Remove CodeGraph initialization from the lifecycle**

Replace `prepare` with a read-only `resolve`; retain `status` and `sync` only for an existing index and exact persistent write-capable Loop. If repository instructions require CodeGraph and no healthy index exists, return `BLOCKED`; otherwise select native Explore/source/Git without error.

- [ ] **Step 4: Rewrite the side-effect-free classifier**

Recognize exact `$loop-engineering`, `$status`, `$release`, and `$knowledge-evolution`. Complex implementation may activate session-only Loop Engineering; review-only requests route to session-only/read-only Loop Engineering plus `assets/loop-engineering/review.md`; external action language routes to readiness-only Release until explicit authorization.

- [ ] **Step 5: Replace the Skill surface**

Keep only four Skill directories. Put shared classifier policy under `assets/router/`; do not create a Router Skill. Make exact `$loop-engineering` the persistence boundary and keep implicit routing session-only. Remove every old Skill directory physically.

- [ ] **Step 6: Run contract tests**

Run: `python -m unittest tests.test_triggerctl tests.test_codegraphctl tests.test_plugin_contract -v`

Expected: PASS for four routes, missing/stale/required CodeGraph paths, no auto-init, natural-language read-only Review, and physical absence of old Skills.

- [ ] **Step 7: Commit public routing and CodeGraph fallback**

```bash
git add scripts/codegraphctl.py scripts/triggerctl.py assets/router assets/loop-engineering/review.md skills tests/test_codegraphctl.py tests/test_triggerctl.py tests/trigger-cases.json tests/test_plugin_contract.py
git commit -m "feat: expose four PAI Loop Engineering commands"
```

### Task 13: Agent namespace, actor contracts, and synchronization

**Files:**
- Rename: `assets/agents/sw-*.toml` -> `assets/agents/pai-loop-*.toml`
- Modify: `scripts/sync_agents.py`
- Rewrite: `tests/test_sync_agents.py`
- Modify: `tests/test_plugin_contract.py`

**Interfaces:**
- Consumes: H1 Actor schema and enforcement classes.
- Produces: ten `pai-loop-*` Agent profiles classified as read-only reviewer/explorer, bounded writer, or physical-action-prohibited; `sync_agents.py` validates and installs the new namespace transactionally.

- [ ] **Step 1: Write failing namespace and actor-contract tests**

```python
def test_all_agents_use_pai_loop_namespace(self) -> None:
    agents = list((PLUGIN / "assets" / "agents").glob("*.toml"))
    self.assertEqual(10, len(agents))
    self.assertTrue(all(path.stem.startswith("pai-loop-") for path in agents))
    self.assertTrue(all("sw-" not in path.read_text(encoding="utf-8") for path in agents))
```

- [ ] **Step 2: Run Agent tests and confirm old namespace fails**

Run: `python -m unittest tests.test_sync_agents tests.test_plugin_contract -v`

Expected: FAIL because all bundled Agent files still use `sw-*`.

- [ ] **Step 3: Rename and classify Agent profiles**

Preserve domain specialties, rename every internal identifier, keep reviewers/explorers read-only, limit writer paths/tools through the H1 request envelope, forbid recursive delegation/router/ledger/release/hardware actions, and declare enforcement class honestly.

- [ ] **Step 4: Update transactional synchronization**

Use Task 1's portable lock, explicit UTF-8 decoding, new namespace validation, rollback safety, and Windows privilege-aware symlink tests.

- [ ] **Step 5: Run Agent synchronization tests**

Run: `python -m unittest tests.test_sync_agents tests.test_plugin_contract -v`

Expected: PASS for namespace, semantic model catalog checks, transactional install/rollback, path containment, symlink behavior, and actor contracts.

- [ ] **Step 6: Commit Agent migration**

```bash
git add assets/agents scripts/sync_agents.py tests/test_sync_agents.py tests/test_plugin_contract.py
git commit -m "refactor: namespace PAI Loop agents"
```

### Task 14: Brand, compatibility, documentation, and full delivery gate

**Files:**
- Modify: `.codex-plugin/plugin.json`
- Modify: `compatibility.json`
- Rewrite: `README.md`
- Rewrite: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh-CN.md`
- Modify: `assets/loop-engineering/workflow.md`
- Create: `scripts/validate_plugin.py`
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
- Modify: `tests/test_plugin_contract.py`
- Create: `tests/test_docs.py`

**Interfaces:**
- Consumes: all completed controllers, schemas, Skills, and Agent resources.
- Produces: plugin `pai-loop-engineering` version `0.3.0`, final docs, compatibility declaration, single `LOOP.md` narrative contract, and `validate_plugin(root: Path) -> list[str]` covering manifest shape, the exact four-Skill surface, local schema references, JSON and line-delimited JSON fixtures, Markdown links, Agent namespace, active runtime branding, and physical absence of legacy Skill directories.

- [ ] **Step 1: Write failing final contract tests**

```python
def test_manifest_identity_and_prompts(self) -> None:
    manifest = self.load(".codex-plugin/plugin.json")
    self.assertEqual("pai-loop-engineering", manifest["name"])
    self.assertEqual("0.3.0", manifest["version"])
    self.assertEqual("PAI Loop Engineering", manifest["interface"]["displayName"])
    self.assertTrue(any(prompt.startswith("$loop-engineering") for prompt in manifest["interface"]["defaultPrompt"]))

def test_no_legacy_runtime_tokens(self) -> None:
    corpus = self.active_runtime_text()  # .codex-plugin, skills, scripts, schemas, active assets
    for token in ("Superworkflows", "run_id", "sw-"):
        self.assertNotIn(token, corpus)
    for directory in ("init", "run", "review", "learn", "superworkflows"):
        self.assertFalse((PLUGIN / "skills" / directory).exists())
    self.assertEqual(
        {"loop-engineering", "status", "release", "knowledge-evolution"},
        set(self.load("assets/router/trigger-policy.json")["routes"]),
    )
    self.assertNotRegex((PLUGIN / "scripts" / "loopctl.py").read_text(encoding="utf-8"), r"load_legacy|migrate_v1")
```

- [ ] **Step 2: Run final contract tests and confirm branding/docs fail**

Run: `python -m unittest tests.test_plugin_contract tests.test_docs -v`

Expected: FAIL on old manifest identity, version, templates, names, README, and compatibility fields.

- [ ] **Step 3: Update manifest and compatibility declaration**

Set plugin/display identity to `pai-loop-engineering` / `PAI Loop Engineering`, version `0.3.0`, workflow and Loop schemas `[2]`, agent namespace `pai-loop-`, Python `>=3.10`, and default prompts for the four commands. Do not advertise aliases or v1 migration.

- [ ] **Step 4: Rewrite user and security documentation**

Lead both READMEs with `PAI = Physical AI` and `From Prompt Engineering to Loop Engineering for Physical AI.` Document four commands, exact persistence boundary, `.ai-loop` tree, Markdown-only Chinese, CodeGraph fallback, H0/H1/Broker limits, Handoff/Release split, physical authorization, and Knowledge Proposal boundary. Preserve the statement that plugin enforcement is not an OS sandbox.

- [ ] **Step 5: Delete numbered templates and finish the compact workflow**

Make `workflow.md` the compact Loop contract and use only generated `LOOP.md` plus `knowledge-proposal.md` for human narrative. Confirm every machine artifact has a schema and English-only generated fields.

- [ ] **Step 6: Run the complete verification suite**

Run: `python -m unittest discover -s tests -v`

Expected: PASS with zero unexpected failures/errors on Windows, Linux, and macOS; privilege-dependent symlink tests may report an explained Skip.

Run: `python scripts/validate_plugin.py`

Expected: exit `0`; every JSON file parses, every JSONL fixture parses line by line, every local schema reference resolves, Markdown links resolve, the plugin manifest and four Skill directories are valid, and no active legacy runtime surface remains. Historical migration notes in README/Changelog and explicit unsupported-state diagnostics may name the removed surface but provide no alias or migration implementation.

Run: `python scripts/sync_agents.py --check --check-json`

Expected: exit `0`, `valid: true`, all bundled Agent contracts compatible.

Run: `git diff --check`

Expected: no output and exit `0`.

- [ ] **Step 7: Perform final adversarial review**

Review the implementation against all 13 acceptance conclusions in the design. Specifically challenge Handoff freshness, Release self-staleness, no-H1 writes, unknown read sets, cross-Loop leases, raw-evidence localization, missing CodeGraph, JIT physical approval, Windows locking, and old command deletion. Record every P0/P1 as a failing regression test before fixing it.

- [ ] **Step 8: Commit the v0.3 delivery surface**

```bash
git add .codex-plugin compatibility.json README.md README.zh-CN.md SECURITY.md CHANGELOG.md CHANGELOG.zh-CN.md assets/loop-engineering scripts/validate_plugin.py tests
git commit -m "feat: release PAI Loop Engineering v0.3"
```

## Plan Self-Review Checklist

- [x] Every design section 1-17 maps to at least one task above.
- [x] All created/modified/deleted files have an owning task.
- [x] Every cross-task API is introduced before consumption.
- [x] Every task begins with a failing test, proves the failure, implements the minimum contract, proves the pass, and commits.
- [x] No task retains old command aliases, v1 state migration, Run terminology, `.ai/runs`, or `sw-*` runtime resources.
- [x] Full verification includes Windows portability, schemas, docs, Agent synchronization, and `git diff --check`.
