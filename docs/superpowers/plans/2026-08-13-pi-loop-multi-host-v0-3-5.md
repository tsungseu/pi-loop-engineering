# PI Loop Multi-Host v0.3.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.3.5 so one repo root installs on Codex, Claude Code, and Cursor with shared `skills/` + Node runtime, host-specific agents/hooks, no `commands/`, and zero Codex regression.

**Architecture:** Keep `assets/agents/*.toml` as the Actor contract source of truth. Add `.claude-plugin/` and `.cursor-plugin/` manifests beside the existing `.codex-plugin/`. Put host agent markdown under `agents/{claude,cursor}/`, machine-readable Codex contract snapshots under `agents/codex/`, and host hooks under `hooks/{claude,cursor}/` plus shared `hooks/scripts/`. Extend `sync-agents` and `validate-plugin` with contract checks and `--host codex|full` gates. Bump every version surface to `0.3.5`.

**Tech Stack:** TypeScript source, committed JS ESM `dist/`, Node `>=22`, existing `node:test` suite, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-08-13-pi-loop-multi-host-v0-3-5-design.md`

**Branch:** `feature/pi-loop-multi-host-v0-3-5` → PR into `main`

**Hard constraints:**
- Do not change Codex Skill discovery, `$` prompts, or `openai.yaml` generation semantics.
- Do not create root `commands/`.
- Do not commit `findings.md` / `progress.md` / `task_plan.md`.

---

## File map

| Path | Responsibility |
|------|----------------|
| `.codex-plugin/plugin.json` | Version bump only (`0.3.5`); no new required fields |
| `.claude-plugin/plugin.json` | Claude host manifest |
| `.cursor-plugin/plugin.json` | Cursor host manifest |
| `agents/codex/*.json` | Machine contract snapshots (sync-generated) |
| `agents/claude/pi-loop-*.md` | Claude agent markdown |
| `agents/cursor/pi-loop-*.md` | Cursor agent markdown |
| `hooks/scripts/session-boundary.mjs` | Shared sessionStart injector |
| `hooks/scripts/shell-guard.mjs` | Shared dangerous-shell guard |
| `hooks/claude/hooks.json` | Claude hook wiring |
| `hooks/cursor/hooks.json` | Cursor hook wiring |
| `src/cli/sync-agents.ts` | Keep openai.yaml sync; add snapshot write + host MD contract check |
| `src/cli/validate-plugin.ts` | Version `0.3.5`; multi-host; forbid `commands/`; `--host` |
| `package.json` / `compatibility.json` / lockfile | Version `0.3.5`; add `validate:plugin:codex` |
| `test/cli/plugin-validation.test.ts` | Full + codex + no-commands + host fixtures |
| `test/cli/sync-agents.test.ts` | Contract drift rejection |
| `README.md` / `README.zh-CN.md` / changelogs | Install notes for three hosts |
| `.github/workflows/ci.yml` | Run codex-only + full validate |

**Agent set (exactly 10):**  
`pi-loop-biped-cerebellum-engineer`, `pi-loop-environment-reviewer`, `pi-loop-explorer`, `pi-loop-release-engineer`, `pi-loop-reviewer`, `pi-loop-robot-brain-engineer`, `pi-loop-robot-data-algorithm`, `pi-loop-robot-data-collector`, `pi-loop-safety-reviewer`, `pi-loop-worker`

---

### Task 1: Bump version surfaces to 0.3.5 (Codex-compatible)

**Files:**
- Modify: `package.json`, `package-lock.json`, `compatibility.json`, `.codex-plugin/plugin.json`
- Modify: `src/cli/validate-plugin.ts` (version constant / comparisons currently `"0.3.0"`)
- Modify: `test/cli/plugin-validation.test.ts` (fixture versions + `report.version`)
- Modify: `CHANGELOG.md`, `CHANGELOG.zh-CN.md` (add `## [0.3.5]` stub noting multi-host; fill details in Task 8)

- [ ] **Step 1: Write failing assertion for 0.3.5**

In `test/cli/plugin-validation.test.ts`, change the expected version checks to `"0.3.5"` while leaving package files at `0.3.0` temporarily, **or** first update the test expectation then run:

```bash
npm run test:cli -- --test-name-pattern "plugin delivery"
```

Expected: FAIL on version mismatch until Step 2.

- [ ] **Step 2: Bump all version files to 0.3.5**

Set `"version": "0.3.5"` / `"plugin_version": "0.3.5"` in:
- `package.json`
- `package-lock.json` (root `version` and `packages[""].version`)
- `compatibility.json`
- `.codex-plugin/plugin.json`

In `src/cli/validate-plugin.ts`:
- `ValidationReport.version` type literal → `"0.3.5"`
- comparisons against `"0.3.0"` → `"0.3.5"`
- returned report `version: "0.3.5"`

Update fixture writers in `plugin-validation.test.ts` to emit `0.3.5`.

- [ ] **Step 3: Rebuild and run Codex-facing tests**

```bash
npm run build
npm run test:cli
npm run validate:plugin
```

Expected: PASS (still Codex-only surfaces).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json compatibility.json .codex-plugin/plugin.json src/cli/validate-plugin.ts test/cli/plugin-validation.test.ts CHANGELOG.md CHANGELOG.zh-CN.md dist/cli/validate-plugin.js dist/cli/validate-plugin.js.map
git commit -m "chore: bump plugin version to 0.3.5"
```

---

### Task 2: Add Claude and Cursor plugin manifests

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.cursor-plugin/plugin.json`
- Modify: `src/cli/validate-plugin.ts` (later fully enforced in Task 6; here only create files)

- [ ] **Step 1: Create Claude manifest**

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "pi-loop-engineering",
  "version": "0.3.5",
  "description": "From Prompt Engineering to Loop Engineering for Physical AI.",
  "author": { "name": "xucong" },
  "license": "AGPL-3.0-only",
  "keywords": [
    "physical-ai",
    "pi",
    "loop-engineering",
    "robotics",
    "release",
    "knowledge-evolution",
    "adversarial-review"
  ],
  "skills": "./skills/",
  "agents": "./agents/claude/",
  "hooks": "./hooks/claude/hooks.json"
}
```

- [ ] **Step 2: Create Cursor manifest**

Create `.cursor-plugin/plugin.json`:

```json
{
  "name": "pi-loop-engineering",
  "version": "0.3.5",
  "description": "From Prompt Engineering to Loop Engineering for Physical AI.",
  "author": { "name": "xucong" },
  "license": "AGPL-3.0-only",
  "keywords": [
    "physical-ai",
    "pi",
    "loop-engineering",
    "robotics",
    "release",
    "knowledge-evolution",
    "adversarial-review"
  ],
  "skills": "./skills/",
  "agents": "./agents/cursor/",
  "hooks": "./hooks/cursor/hooks.json"
}
```

Do **not** declare `commands`.

- [ ] **Step 3: Confirm Codex manifest unchanged except version**

Diff `.codex-plugin/plugin.json` against pre-Task-1 content: only `version` may change. Keep `interface.defaultPrompt` with `$loop-engineering` etc.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .cursor-plugin/plugin.json
git commit -m "feat: add Claude and Cursor plugin manifests"
```

---

### Task 3: Author host agent markdown + Codex contract snapshot shape

**Files:**
- Create: `agents/claude/pi-loop-*.md` (10 files)
- Create: `agents/cursor/pi-loop-*.md` (10 files)
- Create: `agents/codex/pi-loop-*.json` (10 files; may be generated in Task 4 — if generated, create one golden example here and let sync fill the rest)

**Frontmatter contract schema (Claude/Cursor MD):**

```yaml
---
name: pi-loop-explorer
description: <host-toned prose; may differ>
role: explorer
source_access: read-only
required_bindings: ["h1", "work_item", "attempt"]
evidence_requirements: ["cited-paths-and-lines", "graph-or-native-navigation-notes"]
stop_conditions: ["required-codegraph-unusable", "write-request-outside-explorer-scope"]
capabilities:
  external_write: false
  network: false
  recursive_dispatch: false
  ledger_write: false
  release: false
  physical_action: false
---
```

Body: short host-specific instructions restating bounds (read-only / no recursive dispatch / no physical action). Include AGPL header comment block matching existing skill style where practical.

**Codex snapshot JSON shape:**

```json
{
  "name": "pi-loop-explorer",
  "role": "explorer",
  "source_access": "read-only",
  "required_bindings": ["h1", "work_item", "attempt"],
  "evidence_requirements": ["cited-paths-and-lines", "graph-or-native-navigation-notes"],
  "stop_conditions": ["required-codegraph-unusable", "write-request-outside-explorer-scope"],
  "capabilities": {
    "external_write": false,
    "network": false,
    "recursive_dispatch": false,
    "ledger_write": false,
    "release": false,
    "physical_action": false
  }
}
```

- [ ] **Step 1: Generate Claude MD files from each TOML**

For every `assets/agents/pi-loop-*.toml`, create matching `agents/claude/<name>.md` with hard fields copied exactly from TOML; `description` may be lightly rephrased for Claude tone but hard fields must match.

- [ ] **Step 2: Copy/adapt Cursor MD files**

Create `agents/cursor/<name>.md` with the same hard fields (description prose may differ from Claude).

- [ ] **Step 3: Spot-check one writer and one reviewer**

Verify `pi-loop-worker` has writer bindings and `h1-write-set`; `pi-loop-reviewer` is read-only with all write caps false; `pi-loop-release-engineer` has `release: true`.

- [ ] **Step 4: Commit**

```bash
git add agents/
git commit -m "feat: add Claude and Cursor host agent profiles"
```

---

### Task 4: Extend `sync-agents` for snapshots + contract check

**Files:**
- Modify: `src/cli/sync-agents.ts`
- Modify: `test/cli/sync-agents.test.ts`
- Rebuild: `dist/cli/sync-agents.js`

- [ ] **Step 1: Write failing tests**

Add to `test/cli/sync-agents.test.ts`:

1. `synchronizeAgents` writes `agents/codex/<name>.json` matching TOML hard fields.
2. `--check` fails when `agents/claude/pi-loop-explorer.md` frontmatter `capabilities.network` is flipped to `true`.
3. Existing openai.yaml determinism tests still pass unchanged.

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm run build
npm run test:cli -- --test-name-pattern "sync-agents"
```

- [ ] **Step 3: Implement helpers in `sync-agents.ts`**

Add:

```ts
export type ContractFields = {
  name: string;
  role: string;
  source_access: string;
  required_bindings: string[];
  evidence_requirements: string[];
  stop_conditions: string[];
  capabilities: AgentProfile["capabilities"];
};

export function contractFromProfile(profile: AgentProfile): ContractFields { /* map fields */ }

export function parseMarkdownContract(text: string): ContractFields {
  // Parse YAML frontmatter between --- fences; require all hard keys.
}

export function assertContractsEqual(expected: ContractFields, actual: ContractFields, path: string): void {
  // Deep-equal arrays (order-sensitive as in TOML) and capabilities; throw SyncError on drift.
}
```

In `synchronizeAgents`:
1. Keep existing openai.yaml loop **byte-compatible**.
2. For each profile, write `agents/codex/<name>.json` (unless `check`).
3. For each of `agents/claude` and `agents/cursor`, require file `<name>.md` exists, parse frontmatter, `assertContractsEqual`.
4. Require exactly the same 10 names present in each host dir (no extras).

- [ ] **Step 4: Run sync and tests**

```bash
npm run build
npx tsx src/cli/sync-agents.ts --root .
npm run test:cli -- --test-name-pattern "sync-agents"
```

Expected: PASS; openai.yaml digests unchanged if agent set unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sync-agents.ts dist/cli/sync-agents.js dist/cli/sync-agents.js.map test/cli/sync-agents.test.ts agents/codex
git commit -m "feat: sync-agents validates host agent contracts"
```

---

### Task 5: Add Claude/Cursor guardrail hooks (no commands)

**Files:**
- Create: `hooks/scripts/session-boundary.mjs`
- Create: `hooks/scripts/shell-guard.mjs`
- Create: `hooks/claude/hooks.json`
- Create: `hooks/cursor/hooks.json`

- [ ] **Step 1: Shared session boundary script**

`hooks/scripts/session-boundary.mjs` must print a short English boundary message to stderr or stdout (host-appropriate) reminding:
- Four public skills only: loop-engineering, status, release, knowledge-evolution
- Classify with `node dist/cli/triggerctl.js classify` before side effects
- No physical action authority from hooks or skills alone
- Exit `0`

- [ ] **Step 2: Shared shell guard script**

`hooks/scripts/shell-guard.mjs`:
- Read JSON from stdin (Cursor `beforeShellExecution` / Claude `PreToolUse` payload).
- Extract command string from known fields (`command`, `tool_input.command`, etc.).
- If command matches high-risk patterns (deploy/robot/hil/`releasectl` mutate without documented auth, `rm -rf`, firmware flash heuristics), exit non-zero **or** emit host deny JSON — prefer fail-closed deny/ask; never grant auth.
- Otherwise exit `0`.

Keep pattern list conservative and documented in script header comments.

- [ ] **Step 3: Wire Claude hooks**

`hooks/claude/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-boundary.mjs\""
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/shell-guard.mjs\""
          }
        ]
      }
    ]
  }
}
```

Adjust to the current Claude Code plugin hooks schema if the nested shape differs — prefer official `hooks.json` examples, but keep the two intents.

- [ ] **Step 4: Wire Cursor hooks**

`hooks/cursor/hooks.json`:

```json
{
  "hooks": {
    "sessionStart": [
      { "command": "node ./hooks/scripts/session-boundary.mjs" }
    ],
    "beforeShellExecution": [
      {
        "command": "node ./hooks/scripts/shell-guard.mjs",
        "matcher": ".*"
      }
    ]
  }
}
```

- [ ] **Step 5: Smoke the scripts**

```bash
node hooks/scripts/session-boundary.mjs
echo {"command":"echo safe"} | node hooks/scripts/shell-guard.mjs
echo {"command":"releasectl action --physical"} | node hooks/scripts/shell-guard.mjs
```

Expected: first two exit 0; third exits non-zero (or deny).

- [ ] **Step 6: Commit**

```bash
git add hooks/
git commit -m "feat: add Claude and Cursor guardrail hooks"
```

---

### Task 6: Extend `validate-plugin` for multi-host + forbid `commands/`

**Files:**
- Modify: `src/cli/validate-plugin.ts`
- Modify: `package.json` scripts
- Modify: `test/cli/plugin-validation.test.ts`
- Rebuild dist

- [ ] **Step 1: Add failing tests**

1. Full validate on repo root passes only when Claude/Cursor manifests, 10+10 agents, hooks, and no `commands/` exist.
2. Fixture with a non-empty `commands/` directory is rejected.
3. `--host codex` (or `validatePlugin(root, { host: "codex" })`) still passes without requiring Claude/Cursor files.
4. Codex canary: `.codex-plugin/plugin.json` still has exactly four `$` prompts and displayName `PI Loop Engineering`.

- [ ] **Step 2: Implement API**

```ts
export type ValidateHost = "codex" | "full";

export async function validatePlugin(
  root: string,
  options: { host?: ValidateHost } = {},
): Promise<ValidationReport> {
  const host = options.host ?? "full";
  // existing core + codex checks always run
  // if host === "full": also assert claude/cursor manifests, agents dirs, hooks, and !exists(commands)
}
```

CLI argv: `--host codex|full` (default `full`).

`package.json` scripts:

```json
"validate:plugin": "node dist/cli/validate-plugin.js",
"validate:plugin:codex": "node dist/cli/validate-plugin.js --host codex"
```

Keep `npm test` calling full validate (or both). Prefer:

```json
"test": "... && npm run validate:plugin:codex && npm run validate:plugin"
```

- [ ] **Step 3: Core additions**

- Require `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` when `host === "full"`.
- Versions must all be `0.3.5`.
- Reject if `commands/` exists as a directory with any files.
- Require `hooks/claude/hooks.json`, `hooks/cursor/hooks.json`, and both scripts.
- Require 10 agent files each under `agents/claude` and `agents/cursor`.
- Optionally call contract check (import from sync-agents) so validate fails on drift.
- Extend `SCAN_ROOTS` carefully: include new host dirs for license/legacy scans without breaking Codex.

- [ ] **Step 4: Build and test**

```bash
npm run build
npm run validate:plugin:codex
npm run validate:plugin
npm test
```

Expected: all PASS. On Windows EBUSY flakes, retry once.

- [ ] **Step 5: Commit**

```bash
git add src/cli/validate-plugin.ts dist/cli/validate-plugin.js dist/cli/validate-plugin.js.map package.json test/cli/plugin-validation.test.ts
git commit -m "feat: validate multi-host delivery and forbid commands/"
```

---

### Task 7: CI dual gates

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add explicit validate steps**

After `npm test` (or inside it if already covered), ensure CI runs both:

```yaml
- run: npm run validate:plugin:codex
- run: npm run validate:plugin
```

If `npm test` already includes both, keep a redundant explicit `validate:plugin:codex` step as the Codex canary signal in CI logs.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: require Codex-only and full plugin validation"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`, `README.zh-CN.md`
- Modify: `CHANGELOG.md`, `CHANGELOG.zh-CN.md`
- Modify: `SECURITY.md` only if hooks/orchestration wording needs a one-line host note

- [ ] **Step 1: README install section**

Document:
- Codex: existing install via `.codex-plugin` (unchanged usage of `$loop-engineering` etc.)
- Claude Code: install/load plugin root; skills from `skills/`; agents from `agents/claude/`
- Cursor: install/load plugin root; skills from `skills/`; agents from `agents/cursor/`
- Explicit statement: no `commands/` directory; explicit + semantic invocation both use `skills/`
- Version `0.3.5`

- [ ] **Step 2: Changelog entries**

English + Chinese `0.3.5` sections summarizing multi-host delivery, hooks, contract sync, Codex zero-regression, no commands.

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-CN.md CHANGELOG.md CHANGELOG.zh-CN.md SECURITY.md
git commit -m "docs: document Codex/Claude/Cursor multi-host v0.3.5"
```

---

### Task 9: Full acceptance + PR

- [ ] **Step 1: Final local gates**

```bash
npm run build
npm run validate:plugin:codex
npm test
```

Expected: PASS. Confirm `validate:plugin` report `version` is `0.3.5` and `pluginId` is `pi-loop-engineering`.

- [ ] **Step 2: Codex regression spot-check**

Confirm unchanged semantics:
- `.codex-plugin/plugin.json` still lists four `$` prompts
- `skills/*/agents/openai.yaml` agent lists still match TOML names
- No root `commands/` directory

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "feat: multi-host v0.3.5 (Codex/Claude/Cursor)" --body "$(cat <<'EOF'
## Summary
- Add `.claude-plugin` / `.cursor-plugin` manifests sharing `skills/` + Node runtime
- Host agents under `agents/{claude,cursor}` with TOML contract checks; Codex `openai.yaml` unchanged
- Guardrail hooks for Claude/Cursor; no `commands/`
- Version bump to 0.3.5 with Codex-only + full validation gates

## Test plan
- [x] `npm run validate:plugin:codex`
- [x] `npm test` (includes full validate)
- [ ] CI green on ubuntu/windows/macos × node 22/24
EOF
)"
```

- [ ] **Step 4: Do not merge until user reviews PR**

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Single-root three manifests | 2, 6 |
| Shared `skills/`; `openai.yaml` Codex-only | 4, 6, 9 |
| Host agent dirs + hard-field parity | 3, 4 |
| No `commands/` | 5, 6, 8 |
| Hooks Claude/Cursor | 5 |
| Version 0.3.5 everywhere | 1, 6, 8 |
| Codex zero-regression + codex-only gate | 1, 6, 7, 9 |
| Docs | 8 |
| Branch + PR | 9 |

## Placeholder / consistency notes

- Claude hooks.json exact nesting must match current Claude Code docs at implementation time; intents remain SessionStart + Bash PreToolUse.
- Shell-guard deny mechanism must follow host stdin/stdout contracts; exit non-zero is the minimum portable fail-closed behavior.
- Do not invent a fifth public skill or Router skill.
