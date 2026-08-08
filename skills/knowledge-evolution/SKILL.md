---
name: knowledge-evolution
description: Distill completed PAI Loop Engineering Handoffs and Releases into human-reviewed improvement proposals only. Use with $knowledge-evolution to write proposals; implicit selection remains response-only and must not apply changes.
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

# PAI Knowledge Evolution

Learning is proposal-driven. This Skill writes proposals only and never applies them directly.

## Before any side effects

1. Resolve `<plugin-root>` as two directories above this `SKILL.md`.
2. Classify with `node <plugin-root>/dist/cli/triggerctl.js classify --prompt "<request>"`.
3. `RESPONSE_ONLY` may summarize candidate lessons in the reply without writing proposals. Writing proposals requires exact `$knowledge-evolution` / `PROPOSAL_ONLY_EVOLUTION`.

## Proposal flow

```bash
node <plugin-root>/dist/cli/knowledgectl.js propose --workspace <repo> --loop-id <completed-loop-id>
```

1. Accept only completed `HANDOFF_READY` Loops and finished Releases as sources.
2. Separate project knowledge, project policy, and workflow/Skill/harness candidates.
3. Require source digests, observation counts, corrections, counterexamples, privacy review, expected benefit, safety impact, offline evaluation, canary, rollback, and review date.
4. Transition proposals with `knowledgectl.js transition`; mark applied only after a later implementation Loop completes via `knowledgectl.js mark-applied`.

## Boundaries

- Do not apply a proposal to production files from this Skill.
- Approved application must create a new `$loop-engineering` Loop, then mark the proposal applied after that Loop finishes.
- Do not weaken repository-instruction precedence, implicit persistence prohibition, external/hardware authority, reviewer independence, or stale-evidence gates without a named safety exception and explicit human approval.
