---
name: release
description: Assess Final Handoff release readiness and perform only explicitly authorized Physical AI release actions. Use with $release for readiness or authorized actions; implicit selection remains readiness-only and never grants push, publish, deploy, HIL, or real-robot authority.
---
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

# PI Loop Engineering Release

Separate readiness assessment from external execution. Defaults to readiness-only until an explicit action and target are authorized.

## Before any side effects

1. Resolve `<plugin-root>` as two directories above this `SKILL.md`.
2. Classify with `node <plugin-root>/dist/cli/triggerctl.js classify --prompt "<request>"`.
3. `READINESS_ONLY` and implicit/unknown/denied physical routes (`authority: blocked`) may inspect readiness only. Exact `$release` with physical/external action language yields `READINESS_OR_AUTHORIZED_RELEASE` and `authority: readiness_or_authorized` with `physical_action: requires_authorization` — proceed only after explicit action/target authorization, never as an implicit grant.

## Readiness Check

```bash
node <plugin-root>/dist/cli/releasectl.js readiness --workspace <repo> --loop-id <loop-id>
```

Readiness is in-memory and must not create `.ai-loop/releases/` by itself. Require a fresh Final Handoff, closed Findings gates, rollback proof, and environment evidence honesty. Resolve CodeGraph read-only when helpful; do not create a missing index. Existing-index sync is allowed only on an exact writable release path after readiness authorizes integration work.

## Authorized actions

Mutable actions use:

```bash
node <plugin-root>/dist/cli/releasectl.js action --workspace <repo> --loop-id <loop-id> --action <action> --target <target> --authorization <authorization.json>
```

Require distinct scoped authorization for commit, push, pr, tag, publish, deploy-sim, run-hil, deploy-robot, and run-real-robot. Recheck action, target, Handoff digest, grantor, and expiry immediately before execution. Lost responses must reconcile through `releasectl.js reconcile` rather than blind retry.

## Boundaries

- Implicit selection never grants external or hardware authority.
- Release does not inherit H1 write permissions.
- Source fixes required after a failed action need a new Child Loop, not in-place Handoff mutation.
