# 变更日志

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

本文件记录 PI Loop Engineering 的重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.3.5]

### 新增

- 多宿主交付面（细节在 Task 8 补全）。

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
