# PI Loop Engineering

[English](README.md) | [简体中文](README.zh-CN.md)

**PI = Physical AI.**

**From Prompt Engineering to Loop Engineering for Physical AI.**

PI Loop Engineering is a Codex plugin that treats prompts as components inside a controlled engineering loop: goals, context, tools, durable state, bounded parallelism, verification, independent Review, stop conditions, immutable Handoff, separately authorized Release, and proposal-only Knowledge Evolution.

## Quickstart

Use one of the four public commands:

```text
$loop-engineering Bootstrap and run this Physical AI coding loop
$status inspect the active Loop without changing it
$release assess Final Handoff readiness for this Loop
$knowledge-evolution propose improvements from completed Handoffs
```

Exact `$loop-engineering` authorizes persistent `.ai-loop/` state. Implicit selection of a complex implementation stays session-only and must not claim resumability. There is no Init command, no Router Skill, and no Python/Shell control plane.

## Why Loop Engineering

Prompt Engineering optimizes a single turn. Loop Engineering manages a closed system that can plan, harness, implement, verify, review, remediate, hand off, and evolve under explicit authority boundaries. That is the difference between “the model answered” and “the robot-facing change is evidence-backed and release-gated.”

## Four Commands

| Command | Purpose |
|---|---|
| `$loop-engineering` | Bootstrap or resume a Loop; forge H0/H1; dispatch bounded Sub-agents; run risk-adaptive Review; stop at an immutable Final Handoff. |
| `$status` | Read-only inspection of candidates, harness drift, findings, evidence, blockers, and next safe actions. |
| `$release` | Defaults to readiness-only; external/hardware actions require an explicit Action Envelope and just-in-time authorization. |
| `$knowledge-evolution` | Writes proposals only; applying an approved proposal requires a new engineering Loop. |

Natural-language Review loads the internal reviewer contract and read-only Reviewer agents. There is no public `$review` Skill.

## Core Runtime Contracts

- **H0 / H1 harnesses** bind repository identity, policy digests, and writable surfaces before mutation.
- **Bounded parallelism** uses DAG readiness, read/write sets, WaveInput, leases, worktrees, fencing tokens, budgets, and sealed result admission.
- **Immutable Final Handoff** ends the Loop. Release cannot consume staged or stale Handoffs.
- **Release authorization** is independent of Loop completion. Physical-action gates stay with Release.
- **Markdown languages** are English by default (`en-US`) with explicit Simplified Chinese (`zh-CN`). JSON/JSONL and other non-Markdown plugin output stay English.
- **Node-only committed runtime** ships as deterministic JavaScript ESM under `dist/` with zero production npm dependencies. Source and Runtime manifests plus `npm run check:dist` bind reviewed TypeScript to the bytes that execute.
- **CodeGraph fallback** resolves MCP, existing CLI index, or native exploration. Missing CodeGraph does not invent an Init path; mandatory repository rules can still block.

## Clean-Break Migration from Superworkflows

v0.3.0 does not resume or migrate old Superworkflows state:

- Old commands (`$superworkflows`, `$init`, `$run`, `$review`, `$learn`) are removed.
- Old Python controllers and Shell wrappers are removed.
- Old run directories and project profiles are not readable by `loopctl`.
- Archive legacy evidence outside the plugin if you still need it, then Bootstrap a new Loop under `.ai-loop/`.

## Requirements

- Node.js `>=22` (CI covers 22 and 24)
- Git
- Codex host sandboxing, approvals, and filesystem permissions for hard isolation

## Development Gates

```text
npm ci --ignore-scripts
npm run typecheck
npm run schema:check
npm run test:unit
npm run test:cli
npm run test:faults
npm run check:dist
npm run validate:plugin
npm test
```

## License

Copyright (c) 2026 Tsung Xu. **Dual-licensed — choose one:**

- **GNU AGPL-3.0-only** — the open-source license in [`LICENSE`](LICENSE). You may use, modify, and distribute the software, including commercially, **provided that any software you build from it and expose over a network is also released under AGPL-3.0** (strong copyleft).
- **Commercial license** — for use that cannot comply with AGPL-3.0, for example embedding in a closed-source or proprietary product without open-sourcing your own code, a separate commercial license is available.
