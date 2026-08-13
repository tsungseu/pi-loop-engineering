# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

All notable changes to PI Loop Engineering are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.5] - 2026-08-13

### Added

- Multi-host delivery from one repository root: `.claude-plugin/` and `.cursor-plugin/` manifests alongside the existing `.codex-plugin/`, all sharing `skills/`, `dist/`, `assets/`, and `schemas/`.
- Host agent profiles under `agents/claude/` and `agents/cursor/` with TOML contract sync via extended `sync-agents`; Codex `skills/*/agents/openai.yaml` generation unchanged.
- Guardrail hooks for Claude Code and Cursor (`hooks/claude/`, `hooks/cursor/`) for session-boundary injection and shell-action prompts. Hooks advise or intercept only — they do not authorize Release, ledger writes, or physical actions.
- Codex contract snapshots under `agents/codex/` for mechanical hard-field validation against `assets/agents/*.toml`.

### Changed

- Version bumped to **0.3.5** across `package.json`, `compatibility.json`, and all three host manifests.
- `validate-plugin` extended with `--host codex|full` gates, TOML ↔ host hard-field contract checks, hooks presence validation, and rejection of a root `commands/` directory.
- CI runs both Codex-only (`validate:plugin:codex`) and full multi-host validation.
- `.claude-plugin/plugin.json` `agents` field is now an explicit file array (10 entries). Claude Code's official loader rejects directory values for `agents`; the file array passes `claude plugin validate . --strict`.
- `hooks/cursor/hooks.json` normalized to the official `{ "hooks": { ... } }` shape; the previous `version: 1` wrapper is removed because Cursor's schema does not define a top-level wrapper key.
- `validate-plugin` now enforces the host loader schema differences: Claude `agents` must be a file path/array, Cursor `agents` may be a directory or file array, and both `hooks.json` files must match their host's expected event-key shape.

### Security

- Claude Code and Cursor guardrail hooks are advisory guardrails only; JIT Release authorization and physical-action gates are unchanged.

## [0.3.0] - 2026-08-08

### Added

- Renamed the plugin to **PI Loop Engineering** (`pi-loop-engineering`) with the tagline **From Prompt Engineering to Loop Engineering for Physical AI.**
- Delivered a strict TypeScript control plane and committed deterministic JavaScript ESM runtime under `dist/` for Node.js `>=22`.
- Exposed exactly four public commands: `$loop-engineering`, `$status`, `$release`, and `$knowledge-evolution`.
- Added H0/H1 harnesses, Runtime Gate, WaveInput, Repository Coordinator, Dispatch Broker, immutable Final Handoff, independent Release Action Envelopes, and proposal-only Knowledge Evolution.
- Added Source/Runtime manifests, `check:dist`, and `validate:plugin` delivery gates.
- Added cross-platform CI for Windows, Linux, and macOS on Node.js 22 and 24.
- Added English-default and explicit Simplified Chinese LOOP/Knowledge Markdown templates.

### Changed

- Replaced the Superworkflows router-plus-six-stage model with an internal closed loop and four discoverable Skills.
- Moved shared trigger classification to `assets/router/trigger-policy.json` outside Skills.
- Renamed Agent profiles to the `pi-loop-` namespace with explicit actor capability contracts.

### Removed

- Removed `$superworkflows`, `$init`, `$run`, `$review`, `$learn`, and all command aliases/tombstones.
- Removed the Python control plane, Shell wrappers, dual-runtime bridges, and npm production dependencies.
- Removed legacy numbered LOOP stage templates, `learning-proposal.md`, and `project-profile.json`.
- Removed support for reading or migrating old Superworkflows run state. Archive legacy evidence and Bootstrap a new Loop.

### Security

- Documented orchestration limits versus host enforcement, evidence/hash-chain limits, secret handles, physical-action JIT authorization, and rollback expectations.
- Kept Reviewer actors read-only and blocked write-capable Reviewer contracts.
- Kept Release authority separate from Loop Handoff completion.

## [0.2.5] - 2026-07-16

Historical Superworkflows release retained for audit only. Not supported by the v0.3 runtime.

## [0.2.0] - 2026-07-15

Historical Superworkflows release retained for audit only. Not supported by the v0.3 runtime.

## [0.1.0]

Historical Superworkflows release retained for audit only. Not supported by the v0.3 runtime.
