# Changelog

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

All notable changes to PI Loop Engineering are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.5]

### Added

- Multi-host delivery surfaces (details in Task 8).

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
