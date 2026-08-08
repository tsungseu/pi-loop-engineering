<!--
PAI Loop Engineering - Physical AI Coding Loop Engineering.
Copyright (c) 2026 Tsung Xu

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, version 3 of the License.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Dual-licensed: AGPL-3.0-only OR a separate commercial license.
-->

# PAI Loop Engineering Workflow

This file is the sole portable workflow protocol for PAI Loop Engineering. A repository may strengthen gates through project policy; it may never silently weaken higher-authority safety or authorization rules.

## 1. First principles

Engineering is a feedback loop:

```text
observe repository and runtime facts
  -> form an explicit contract
  -> plan and challenge the plan
  -> seal H0/H1 harnesses
  -> implement in bounded ownership
  -> verify with fresh evidence
  -> challenge the implementation
  -> remediate within sealed scope
  -> finalize an immutable Handoff
  -> release only through separately authorized actions
  -> evolve knowledge only through proposals
```

Read repository instructions first. Resolve CodeGraph capability before structural navigation. When CodeGraph MCP tools are available in the host session, call `node dist/cli/codegraphctl.js resolve --workspace <repo> --mcp-available true`; otherwise omit `--mcp-available`. Never create a missing index from this workflow. Graph output is `STRUCTURAL_HINT` only: it cannot close Findings or prove runtime behavior. Prefer MCP when available, then CLI explore, otherwise native Explore/search/source/Git tools.

## 2. Authority and truth

Apply authority in this order:

1. system, developer, sandbox, and explicit user authorization;
2. repository `AGENTS.md` and equivalent local instructions;
3. optional project policy under `.ai-loop/`;
4. plugin `workflow-spec.json` and this baseline;
5. selected Skill and delegated-agent prompt.

Public commands are exactly four: `$loop-engineering`, `$status`, `$release`, and `$knowledge-evolution`. There is no Router Skill. Shared classification lives in `assets/router/trigger-policy.json` and is invoked through `node dist/cli/triggerctl.js` before side effects.

### Activation, persistence, and authority

Keep three decisions independent:

- **route**: which of the four Skills applies, or an internal read-only Review mode;
- **persistence**: forbidden, session-only, or authorized persistent Loop under exact `$loop-engineering`;
- **authority**: read-only, repository-write, readiness-only, readiness_or_authorized, proposal-only, blocked, or pending action-scoped approval.

Implicit selection is session-only: it must not create `.ai-loop/`, mutate an existing CodeGraph index, claim resumability, or perform external/hardware actions. Persistent Loop state requires exact `$loop-engineering`. External and hardware work additionally require `$release`, a fresh Final Handoff, and exact action-scoped authorization.

Natural-language Review requests load `assets/loop-engineering/review.md` and a read-only Reviewer inside session-only `$loop-engineering` mode. Do not expose a separate Review command.

### CodeGraph lifecycle and limits

1. Read repository instructions, then call `codegraphctl` `resolve` / `health` / `sync-existing` only.
2. Missing indexes fall back to native exploration unless repository rules make CodeGraph mandatory, in which case stop as `BLOCKED`.
3. Exact writable Loops may synchronize an already present index with `sync-existing`. Synchronization failure is `DEGRADED` unless CodeGraph is mandatory.
4. Re-read decisive source and current diffs. Graph reachability is never runtime correctness.

## 3. Persistent Loop protocol

Exact `$loop-engineering` automatically bootstraps a persistent Loop under `.ai-loop/loop/<loop-id>/` with `LOOP.json`, `LOOP.md`, harnesses, evidence, checkpoints, and a single Final Handoff. Implicit routes remain session-only and write no `.ai-loop/` state.

Machine phases follow `workflow-spec.json`. Status overlays (`ACTIVE`, `DEGRADED`, `PAUSED`, `BLOCKED`, `NON_CONVERGENT`, `COMPLETE`, `CANCELLED`) do not invent alternate phases. `HANDOFF_READY + COMPLETE` means engineering handoff is finished, not that code was released.

## 4. Harness, dispatch, and review

- Forge read-only `H0` during Bootstrap. Seal immutable `H1` only after required Plan Review.
- No H1 means no source writes and no write Sub-agents.
- Bound Sub-agents with work items, Worktrees, WaveInput, leases, attempts, and fencing tokens. Recursive dispatch is forbidden.
- Risk-adaptive Review is mandatory: Low requires final Diff Review; Medium adds Plan Review; High adds Code and Safety/Environment Evidence Review.
- Implementers may mark Findings `FIXED`; only independent Reviewers may mark `VERIFIED` on current commit and evidence.

## 5. Final Handoff stop

Loop Engineering stops at an immutable Final Handoff. It has no Release authority. `$release` consumes only a fresh Final Handoff through a separate lifecycle. Stale Handoffs require a Child Loop rather than overwriting the completed Loop.

## 6. Evidence and physical actions

Prefer machine-captured evidence with argv, cwd, timing, exit code, digests, and commit identity. Lower environments never prove higher ones. Push, PR/MR, tag, publish, deploy, HIL, and real-robot actions require fresh action/target authorization through `$release` and are never implied by Skill selection.
