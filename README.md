# PI Loop Engineering

**PI = Physical AI.** From Prompt Engineering to Loop Engineering for Physical AI.

PI Loop Engineering is a multi-host plugin (Codex, Claude Code, Cursor) that turns prompts into a controlled engineering loop — plan, harness, implement, verify, review, hand off, release, and evolve — under explicit authority boundaries. It is built for robot-facing and embodied-AI work where "the model answered" is not enough: changes must be evidence-backed, reviewable, and release-gated.

[![License](https://img.shields.io/github/license/tsungseu/pi-loop-engineering)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.5-blue)]

> 🌐 English | [简体中文](README.zh-CN.md)

---

## Why Loop Engineering

Prompt Engineering optimizes a single turn. Loop Engineering manages the **closed system** around the model so it can work autonomously and safely over many turns:

| Prompt Engineering | Loop Engineering |
|---|---|
| One request → one response | Goal → controlled loop → immutable Handoff |
| Context lives in your head | Durable state under `.ai-loop/` |
| "Looks right" | Evidence-backed verification gates |
| You decide when to ship | Risk-adaptive Review + separately authorized Release |
| Learnings are lost | Knowledge Evolution distills proposals for the next loop |

For Physical AI this matters more than anywhere else: a half-verified control change can damage hardware. PI Loop Engineering binds the model to a harness before it mutates anything, bounds every sub-agent to an explicit write-set, and never lets the implementation loop grant itself release or physical-action authority.

---

## How the Loop Works

```text
observe repository + runtime facts
  └→ form an explicit contract
      └→ plan, and challenge the plan
          └→ seal H0 / H1 harnesses
              └→ implement in bounded ownership (sub-agents)
                  └→ verify with fresh evidence
                      └→ independent Review (risk-adaptive)
                          └→ remediate within sealed scope
                              └→ immutable Final Handoff
                                  └→ Release (separately authorized)
                                      └→ Knowledge Evolution (proposals only)
```

**Key ideas:**

- **H0 / H1 harnesses** — Before any source write, the loop binds repository identity, policy digests, and the writable surface. No H1 means no writes.
- **Bounded sub-agents** — Each implementation task runs as a fenced sub-agent with a work item, a worktree, an Allowed Files write-set, leases, attempts, and stop conditions. Recursive dispatch is forbidden.
- **Risk-adaptive Review** — Review depth scales with change risk. Reviewers are read-only and independent from implementation.
- **Immutable Final Handoff** — The loop ends by freezing a Handoff. Release can never consume staged or stale work.
- **Separately authorized Release** — Completing a loop never grants release authority. Physical-action and hardware gates stay with the `release` skill.
- **Knowledge Evolution** — Completed Handoffs are distilled into *proposals*. Applying a proposal requires a fresh engineering loop.

---

## Four Skills

Exactly four public Skills exist. On Codex they are invoked with a `$` prefix; on Claude Code and Cursor they are invoked by name or selected semantically.

| Skill | Purpose |
|---|---|
| `loop-engineering` | Bootstrap or resume a Loop; forge H0/H1; dispatch bounded sub-agents; run risk-adaptive Review; stop at an immutable Final Handoff. Exact `$loop-engineering` authorizes persistent `.ai-loop/` state; implicit selection stays session-only. |
| `status` | Read-only inspection of candidates, harness drift, findings, evidence, blockers, and the next safe action. Changes nothing. |
| `release` | Assesses Final Handoff readiness. External/hardware actions require an explicit Action Envelope and just-in-time authorization — the loop never grants this by itself. |
| `knowledge-evolution` | Distills completed Handoffs/Releases into human-reviewed improvement *proposals* only. Applying an approved proposal requires a new Loop. |

There is **no** public `review` Skill or `init` command. Natural-language Review loads an internal read-only reviewer contract. Public intent is discovered only through these four Skills.

---

## Ten Bounded Agents

Agents ship with hard capability contracts (frontmatter derived from canonical TOML). Every agent is fenced: none may dispatch other agents, none may write the loop ledger, and all physical-action authority is reserved.

| Agent | Role | Responsibility |
|---|---|---|
| `pi-loop-worker` | worker | Bounded H1 implementation for an approved work item (explicit worktree, Allowed Files, tests, stop conditions). |
| `pi-loop-explorer` | explorer | Read-only, CodeGraph-first repository explorer for symbol tracing, interfaces, ownership, tests, blast-radius evidence. |
| `pi-loop-reviewer` | reviewer | Independent read-only reviewer for plan quality, finding ownership, residual risk, Verified/Inferred/Not-Run labeling. |
| `pi-loop-environment-reviewer` | environment-reviewer | Read-only reviewer of the Physical AI environment DAG — no lower environment may prove a higher one. |
| `pi-loop-safety-reviewer` | safety-reviewer | Independent read-only robotics safety reviewer: control boundaries, faults, actuator limits, real-time behavior, rollout risk. |
| `pi-loop-release-engineer` | release-engineer | Envelope-mediated release adviser: provenance, reproducibility, serial integration, rollback, staged rollout. (The only agent with `release` capability.) |
| `pi-loop-robot-brain-engineer` | robot-brain-engineer | H1 writer for robot-brain planning, navigation, perception-to-decision flow, command arbitration, brain↔cerebellum contracts. |
| `pi-loop-biped-cerebellum-engineer` | biped-cerebellum-engineer | H1 writer for biped locomotion, RL policy inference, joint mapping, PD/MPC/WBC interfaces, sim2real safety. |
| `pi-loop-robot-data-collector` | robot-data-collector | H1 writer for teleoperation and autonomous mass data-collection pipelines, synchronization, triggers, storage, quality gates. |
| `pi-loop-robot-data-algorithm` | robot-data-algorithm | H1 writer for embodied-AI datasets, preprocessing, curation, labeling, metrics, RL/IL feedback, distribution analysis. |

---

## Install

v0.3.5 ships one repository root with three host manifests. All three hosts share `skills/`, `dist/`, `assets/`, and `schemas/`. Requirement: **Node.js ≥ 22** and Git.

### Claude Code

**Step 1 — Add the marketplace**

```
/plugin marketplace add tsungseu/pi-loop-engineering
```

**Step 2 — Install the plugin**

```
/plugin install pi-loop-engineering@pi-loop-engineering
```

**Step 3 — Verify**

```
/plugin details pi-loop-engineering
```

You should see `Skills (4)`, `Agents (10)`, and `Hooks (2)`. Invoke a skill explicitly (e.g. "use loop-engineering to …") or let Claude select it semantically from the skill descriptions.

### Cursor

Cursor loads local plugins from `~/.cursor/plugins/local/` on IDE restart.

**Step 1 — Link the repo into the local plugins directory**

```powershell
# Windows (directory junction — no admin needed)
mklink /J "%USERPROFILE%\.cursor\plugins\local\pi-loop-engineering" "D:\path\to\pi-loop-engineering"
```

```bash
# macOS / Linux (symlink)
ln -s /path/to/pi-loop-engineering ~/.cursor/plugins/local/pi-loop-engineering
```

**Step 2 — Reload the IDE**

Run the command palette → `Developer: Reload Window` (or restart Cursor).

**Step 3 — Verify**

The four skills and ten agents appear under the plugin namespace. Invoke them by name or rely on semantic selection.

### Codex

Load the repository root as a Codex plugin (`.codex-plugin/plugin.json`). Usage is unchanged from v0.3.0 — invoke the four public Skills with the `$` prefix:

```text
$loop-engineering   Bootstrap and run this Physical AI coding loop
$status             Inspect the active Loop without changing it
$release            Assess Final Handoff readiness for this Loop
$knowledge-evolution  Propose improvements from completed Handoffs
```

Codex-specific agent bindings live under `skills/*/agents/openai.yaml`; contract snapshots are cached under `agents/codex/`.

---

## Quickstart

After install, start a loop with an explicit instruction:

```text
Use loop-engineering to add a new gait-transition controller for the biped,
bounded to src/locomotion/, with unit tests and a sim2real safety review.
```

The skill will: classify the request → bootstrap a persistent `.ai-loop/` loop → forge H0 → challenge the plan (H1 seal) → dispatch bounded workers → verify → review → freeze the Final Handoff.

At any time:

```text
Use status to show me the loop state and the next safe action.
```

When the Handoff is ready:

```text
Use release to assess readiness for the biped gait-transition Handoff.
```

---

## Core Runtime Contracts

- **Bounded parallelism** uses DAG readiness, read/write sets, WaveInput, leases, worktrees, fencing tokens, budgets, and sealed result admission.
- **Markdown languages** are English by default (`en-US`) with explicit Simplified Chinese (`zh-CN`). JSON/JSONL and other non-Markdown output stay English.
- **Node-only runtime** ships as deterministic JavaScript ESM under `dist/` with zero production npm dependencies. `npm run check:dist` binds reviewed TypeScript to the bytes that execute.
- **CodeGraph fallback** resolves MCP, existing CLI index, or native exploration. Missing CodeGraph never invents an Init path; mandatory repository rules can still block.
- **Guardrail hooks** (Claude Code, Cursor) inject session boundaries and intercept dangerous shell / physical actions — they never grant additional authority.

---

## Requirements

- Node.js `>=22` (CI covers 22 and 24)
- Git
- Host sandboxing, approvals, and filesystem permissions for hard isolation (Codex, Claude Code, or Cursor)

---

## Development

```bash
git clone https://github.com/tsungseu/pi-loop-engineering
cd pi-loop-engineering
npm ci --ignore-scripts
```

Validation gates:

```text
npm run typecheck
npm run schema:check
npm run test:unit
npm run test:cli
npm run test:faults
npm run check:dist
npm run validate:plugin:codex   # Codex-only gate
npm run validate:plugin         # full multi-host gate
npm test
```

---

## License

Copyright (c) 2026 Tsung Xu. **Dual-licensed — choose one:**

- **GNU AGPL-3.0-only** — the open-source license in [`LICENSE`](LICENSE). You may use, modify, and distribute the software, including commercially, **provided that any software you build from it and expose over a network is also released under AGPL-3.0** (strong copyleft).
- **Commercial license** — for use that cannot comply with AGPL-3.0, for example embedding in a closed-source or proprietary product without open-sourcing your own code, a separate commercial license is available.
