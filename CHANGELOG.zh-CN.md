# 变更日志

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

本文件记录 PI Loop Engineering 的重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.3.5] - 2026-08-13

### 新增

- 单仓库根多宿主交付：在既有 `.codex-plugin/` 旁新增 `.claude-plugin/` 与 `.cursor-plugin/`，共用 `skills/`、`dist/`、`assets/`、`schemas/`。
- 宿主 Agent 配置位于 `agents/claude/` 与 `agents/cursor/`，经扩展的 `sync-agents` 与 TOML 合约同步；Codex 的 `skills/*/agents/openai.yaml` 生成语义不变。
- Claude Code 与 Cursor 护栏 hooks（`hooks/claude/`、`hooks/cursor/`）：会话边界注入与 shell 动作前提示。Hooks 仅提示或拦截，不授权 Release、ledger 写入或物理动作。
- Codex 合约快照位于 `agents/codex/`，用于相对 `assets/agents/*.toml` 的硬字段机械校验。

### 变更

- 版本统一升至 **0.3.5**（`package.json`、`compatibility.json` 及三宿主清单）。
- 扩展 `validate-plugin`：支持 `--host codex|full` 门禁、TOML ↔ 宿主硬字段合约校验、hooks 存在性校验，并拒绝根目录 `commands/`。
- CI 同时运行 Codex-only（`validate:plugin:codex`）与完整多宿主校验。
- `.claude-plugin/plugin.json` 的 `agents` 字段改为显式文件数组（10 条）。Claude Code 官方加载器拒绝目录形式的 `agents`；改为文件数组后可通过 `claude plugin validate . --strict`。
- `hooks/cursor/hooks.json` 规范化为官方 `{ "hooks": { ... } }` 形态；移除先前的 `version: 1` 包装，因为 Cursor 的 schema 未定义顶层包装键。
- `validate-plugin` 现固化宿主加载期 schema 差异：Claude 的 `agents` 必须为文件路径/数组，Cursor 的 `agents` 允许目录或文件数组，且两份 `hooks.json` 必须符合各自宿主的事件键形态。

### 安全

- Claude Code 与 Cursor 的护栏 hooks 仅为提示性护栏；即时 Release 授权与物理动作门禁保持不变。

## [0.3.0] - 2026-08-08

### 新增

- 将插件重命名为 **PI Loop Engineering**（`pi-loop-engineering`），品牌主张为 **From Prompt Engineering to Loop Engineering for Physical AI.**
- 交付严格 TypeScript 控制面，以及面向 Node.js `>=22` 的已提交确定性 JavaScript ESM 运行时（`dist/`）。
- 仅暴露四个公开命令：`$loop-engineering`、`$status`、`$release`、`$knowledge-evolution`。
- 新增 H0/H1 Harness、Runtime Gate、WaveInput、Repository Coordinator、Dispatch Broker、不可变 Final Handoff、独立 Release Action Envelope，以及仅提案的 Knowledge Evolution。
- 新增 Source/Runtime Manifest、`check:dist` 与 `validate:plugin` 交付门禁。
- 新增 Windows/Linux/macOS × Node.js 22/24 的跨平台 CI。
- 新增默认英文、可显式选择简体中文的 LOOP/Knowledge Markdown 模板。

### 变更

- 用内部闭环与四个可发现 Skill，替换 Superworkflows “路由器 + 六个阶段命令”模型。
- 将共享触发分类移到 Skills 之外的 `assets/router/trigger-policy.json`。
- 将 Agent 配置重命名为 `pi-loop-` 命名空间，并声明明确的 Actor 能力契约。

### 移除

- 移除 `$superworkflows`、`$init`、`$run`、`$review`、`$learn` 及全部命令别名/Tombstone。
- 移除 Python 控制面、Shell 包装、双运行时桥接，以及 npm 生产依赖。
- 移除旧的编号 LOOP 阶段模板、`learning-proposal.md` 与 `project-profile.json`。
- 不再支持读取或迁移旧 Superworkflows 运行状态。请归档旧证据并 Bootstrap 新 Loop。

### 安全

- 文档化编排边界与宿主强制边界、证据/哈希链限制、Secret Handle、物理动作即时授权，以及回滚预期。
- 保持 Reviewer Actor 只读，并拒绝具备写能力的 Reviewer 契约。
- 保持 Release 权限与 Loop Handoff 完成相互独立。

## [0.2.5] - 2026-07-16

历史 Superworkflows 版本，仅供审计；v0.3 运行时不支持。

## [0.2.0] - 2026-07-15

历史 Superworkflows 版本，仅供审计；v0.3 运行时不支持。

## [0.1.0]

历史 Superworkflows 版本，仅供审计；v0.3 运行时不支持。
