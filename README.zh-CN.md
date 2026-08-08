# PAI Loop Engineering

[English](README.md) | [简体中文](README.zh-CN.md)

**PAI = Physical AI（具身/物理 AI）。**

**From Prompt Engineering to Loop Engineering for Physical AI.**

PAI Loop Engineering 是面向 Codex 的插件：把 Prompt 视为受控工程闭环中的组件，覆盖目标、上下文、工具、持久状态、有界并行、验证、独立 Review、停止条件、不可变 Handoff、独立授权的 Release，以及仅提案的 Knowledge Evolution。

## 快速开始

只使用四个公开命令：

```text
$loop-engineering 启动并运行当前 Physical AI 编码闭环
$status 只读检查当前 Loop
$release 评估 Final Handoff 的发布就绪状态
$knowledge-evolution 基于已完成 Handoff 提出改进提案
```

精确调用 `$loop-engineering` 才授权持久化 `.ai-loop/` 状态。复杂实现的隐式选择保持 Session-only，不得声称可恢复。没有 Init 命令，没有 Router Skill，也没有 Python/Shell 控制面。

## 为什么是 Loop Engineering

Prompt Engineering 优化单次问答；Loop Engineering 管理可规划、装载 Harness、实现、验证、审查、修复、交接并演进的闭环系统，并保持明确权限边界。这是“模型回答了”与“面向机器人的变更有证据且可发布门禁”之间的差别。

## 四个命令

| 命令 | 作用 |
|---|---|
| `$loop-engineering` | Bootstrap 或恢复 Loop；锻造 H0/H1；派发有界 Sub-agent；执行风险自适应 Review；在不可变 Final Handoff 停止。 |
| `$status` | 只读检查候选 Loop、Harness 漂移、Finding、证据、阻塞和下一步安全动作。 |
| `$release` | 默认仅就绪评估；外部/硬件动作需要显式 Action Envelope 与即时授权。 |
| `$knowledge-evolution` | 只写提案；批准后的应用必须重新进入工程闭环。 |

自然语言 Review 加载内部 Reviewer 契约与只读 Reviewer Agent；没有公开的 `$review` Skill。

## 核心运行时契约

- **H0 / H1 Harness** 在变更前绑定仓库身份、策略摘要和可写面。
- **有界并行** 依赖 DAG 就绪、读写集合、WaveInput、Lease、Worktree、Fencing、预算与密封结果准入。
- **不可变 Final Handoff** 结束 Loop；Release 不能消费阶段性或陈旧 Handoff。
- **Release 授权** 独立于 Loop 完成；物理动作门禁由 Release 持有。
- **Markdown 语言** 默认英文（`en-US`），可显式选择简体中文（`zh-CN`）；JSON/JSONL 等非 Markdown 插件输出保持英文。
- **仅 Node 的已提交运行时**：确定性 JavaScript ESM `dist/`，生产环境零 npm 依赖；Source/Runtime Manifest 与 `npm run check:dist` 绑定已审查 TypeScript 与实际执行字节。
- **CodeGraph 回退** 依次解析 MCP、既有 CLI 索引或原生探索；缺失 CodeGraph 不会发明 Init 路径，仓库强制规则仍可阻断。

## 相对 Superworkflows 的 Clean Break

v0.3.0 不恢复、不迁移旧 Superworkflows 状态：

- 旧命令（`$superworkflows`、`$init`、`$run`、`$review`、`$learn`）已删除。
- 旧 Python 控制器与 Shell 包装已删除。
- `loopctl` 不读取旧 Run 目录与项目配置。
- 如仍需旧证据，请在插件外归档，然后在 `.ai-loop/` 下 Bootstrap 新 Loop。

## 环境要求

- Node.js `>=22`（CI 覆盖 22 与 24）
- Git
- Codex 宿主沙箱、审批与文件系统权限提供硬隔离

## 开发门禁

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

## 许可

Copyright (c) 2026 Tsung Xu。**双许可 — 二选一：**

- **GNU AGPL-3.0-only**——[`LICENSE`](LICENSE) 中的开源协议。你可以使用、修改和分发本软件（含商用），**前提是：基于本软件构建并通过网络对外提供的任何衍生软件，也必须以 AGPL-3.0 开源**（强 copyleft）。
- **商业许可**——若无法满足 AGPL-3.0 的要求（例如嵌入闭源/专有产品而不愿开源自有代码），可获取单独的商业许可。
