---
name: status
description: Inspect PAI Loop Engineering state without changing it. Use explicitly with $status or when selected session-only to list Loop candidates, check harness drift, findings, evidence, blockers, and the next safe action.
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

# PAI Loop Engineering Status

Provide a strictly read-only, evidence-grounded status view.

## Before any side effects

1. Resolve `<plugin-root>` as two directories above this `SKILL.md`.
2. Classify with `node <plugin-root>/dist/cli/triggerctl.js classify --prompt "<request>"` and continue only for `READ_ONLY_STATUS`.

## Procedure

1. Resolve the repository root and read local instructions.
2. Query status through `node <plugin-root>/dist/cli/loopctl.js status --workspace <repo>` or add `--loop-id <id>` for an exact Loop.
3. Optionally resolve CodeGraph health read-only with `node <plugin-root>/dist/cli/codegraphctl.js health --workspace <repo>`; never synchronize or create an index.
4. Report candidates, selected Loop phase/status, harness digest/drift, open findings, stale evidence, active leases, handoff freshness, residual risks, and next actions.

## Boundaries

- Do not create, resume, transition, repair, or rewrite a Loop.
- Do not select a Loop from semantic title similarity. Report exact IDs and ambiguity.
- Do not spawn write-capable agents.
- Never infer success from a document's existence. Distinguish recorded claims from independently verified evidence.
