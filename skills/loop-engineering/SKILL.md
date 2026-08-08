---
name: loop-engineering
description: Run Physical AI Coding Loop Engineering with automatic Bootstrap, H0/H1 harnesses, bounded Sub-agents, risk-adaptive Review, and an immutable Final Handoff. Use explicitly with $loop-engineering for persistent Loops, or when selected session-only for complex multi-module robotics implementation or natural-language read-only Review.
---
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

# PAI Loop Engineering

Execute the engineering closed loop. Exact `$loop-engineering` authorizes persistent `.ai-loop/` state. Implicit selection stays session-only.

## Before any side effects

1. Resolve `<plugin-root>` as two directories above this `SKILL.md`.
2. Classify the request with:

```bash
node <plugin-root>/dist/cli/triggerctl.js classify --prompt "<request>"
```

3. Obey the classifier decision. `SESSION_ONLY_LOOP` and `SESSION_ONLY_READ_ONLY_REVIEW` must not create `.ai-loop/` or claim resumability. Only `PERSISTENT_LOOP` may Bootstrap or resume an exact Loop ID.
4. Resolve CodeGraph through `node <plugin-root>/dist/cli/codegraphctl.js resolve --workspace <repo>` before structural navigation. Never create a missing index from this Skill.

## Persistent exact invocation

For `PERSISTENT_LOOP`:

1. Follow `<plugin-root>/assets/loop-engineering/workflow.md` and `workflow-spec.json`.
2. Start or resume with `node <plugin-root>/dist/cli/loopctl.js` using an exact Loop ID when resuming.
3. Forge H0 during Bootstrap. Seal H1 only after required Plan Review. No H1 means no source writes and no write Sub-agents.
4. Bound Sub-agents with work items, Worktrees, WaveInput, leases, attempts, and fencing tokens. Recursive dispatch is forbidden.
5. Apply risk-adaptive Review. Natural-language or internal Review loads `<plugin-root>/assets/loop-engineering/review.md` with a read-only Reviewer.
6. Stop at Final Handoff. This Skill has no Release authority and must not push, publish, deploy, run HIL, or operate robots.

Optional Markdown language: `--markdown-language en-US|zh-CN` (or an explicit user request for Chinese Markdown).

## Session-only implicit mode

For implicit complex implementation or read-only Review:

- Keep all work in the current session.
- Do not write `.ai-loop/`, synchronize CodeGraph, or perform external/hardware actions.
- Use temporary harness semantics and parallel read-only agents only; no parallel write Sub-agents.
- For Review-only decisions, load `assets/loop-engineering/review.md` and remain source read-only.

## Boundaries

- Final Handoff ends Loop Engineering; `$release` is a separate lifecycle.
- Graph evidence is `STRUCTURAL_HINT` only.
- Physical actions always require later `$release` authorization bound to action and target.
