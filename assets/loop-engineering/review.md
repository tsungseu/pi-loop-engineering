<!--
PI Loop Engineering - Physical AI Coding Loop Engineering.
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

# Internal Read-Only Review

This document is an internal capability used by `$loop-engineering` for risk-adaptive Review and for natural-language read-only review requests. It is not a public Skill or command.

## Mode

- Session-only unless an exact persistent `$loop-engineering` Loop already owns the work.
- Reviewer roles are source read-only and independent from implementers.
- Call `node dist/cli/triggerctl.js` before side effects; Review itself performs no ledger mutation beyond recording Findings/verdicts through the Loop controller when a persistent Loop is authorized.
- Resolve CodeGraph with `node dist/cli/codegraphctl.js resolve --workspace <repo>` and add `--mcp-available true` only when CodeGraph MCP tools are available in the host session. Query an existing healthy index read-only; never synchronize or create an index from Review.
- Graph evidence is `STRUCTURAL_HINT` only and cannot close Findings or prove behavior.

## Procedure

1. Establish scope, claimed behavior, acceptance criteria, base/head SHAs, and reviewer independence.
2. Load contract, plan, Diff coordinates, and a compact verification summary. Do not trust implementer conclusions.
3. Challenge important claims with counterexamples, alternate paths, fault injection, or independent safe commands.
4. Classify Findings as P0/P1/P2 with evidence, impact, reproduction or reasoning, affected scope, and closure criteria.
5. Return `PASS`, `REVISE`, or `BLOCKED`. Absence of observed failure is not proof of safety.

## Closure rules

- Implementers may mark `FIXED`.
- Only an independent Reviewer may mark `VERIFIED` against the current commit and evidence.
- Material workspace changes stale prior verification.
- Do not execute HIL, real-robot, deploy, or actuation actions to obtain stronger evidence; those require `$release` authorization.
