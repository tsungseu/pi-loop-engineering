# PI Loop Engineering

**PI = Physical AI（物理 AI）。** 从提示工程到物理 AI 的循环工程。

PI Loop Engineering 是一个多宿主插件（Codex、Claude Code、Cursor），把提示词变成一个受控的工程闭环 —— 规划、绑约、实现、验证、评审、交付、发布、进化 —— 全程在显式的权限边界内运行。它面向机器人与具身 AI 场景：在这里"模型回答了"远远不够，每一次改动都必须有证据、可评审、经过发布门禁。

[![License](https://img.shields.io/github/license/tsungseu/pi-loop-engineering)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.5-blue)]

> 🌐 [English](README.md) | 简体中文

---

## 为什么需要循环工程

提示工程优化的是**单次对话**。循环工程管理的是模型周围的**闭环系统**，让它能在很多轮里自主、安全地工作：

| 提示工程 | 循环工程 |
|---|---|
| 一个请求 → 一个回答 | 目标 → 受控循环 → 不可变 Handoff |
| 上下文只存在你脑子里 | 持久状态写入 `.ai-loop/` |
| "看起来对" | 有证据的验证门禁 |
| 你自己决定何时发布 | 风险自适应评审 + 独立授权的发布 |
| 经验随会话丢失 | 知识进化把完成的工作蒸馏成提案 |

对于物理 AI，这一点比任何地方都关键：一个没验证完的控制改动可能损坏硬件。PI Loop Engineering 在模型改动任何东西之前先把它绑定到一个 harness 上，把每个子 agent 限制在一个显式的写集合里，并且永远不让实现循环自己给自己授予发布或物理动作权限。

---

## 循环原理

```text
观察仓库 + 运行时事实
  └→ 形成显式契约
      └→ 规划，并挑战这个规划
          └→ 封印 H0 / H1 harness
              └→ 在受限所有权内实现（子 agent）
                  └→ 用新鲜证据验证
                      └→ 独立评审（风险自适应）
                          └→ 在封印范围内修复
                              └→ 不可变 Final Handoff
                                  └→ 发布（独立授权）
                                      └→ 知识进化（仅提案）
```

**核心概念：**

- **H0 / H1 harness** —— 任何源码写入之前，循环先绑定仓库身份、策略摘要和可写面。没有 H1 就没有写入。
- **受限子 agent** —— 每个实现任务都作为一个隔离的子 agent 运行，带有工作项、worktree、Allowed Files 写集合、租约、尝试次数和停止条件。禁止递归派发。
- **风险自适应评审** —— 评审深度随变更风险伸缩。评审者只读，且独立于实现。
- **不可变 Final Handoff** —— 循环以冻结一个 Handoff 结束。发布永远不能消费暂存或过时的工作。
- **独立授权的发布** —— 完成一个循环不会授予发布权限。物理动作和硬件门禁始终归 `release` 技能。
- **知识进化** —— 已完成的 Handoff 被蒸馏成*提案*。应用提案需要一个全新的工程循环。

---

## 四个技能

一共只有四个公开技能。在 Codex 上用 `$` 前缀调用；在 Claude Code 和 Cursor 上按名字调用或让语义匹配自动选择。

| 技能 | 用途 |
|---|---|
| `loop-engineering` | 启动或恢复一个循环；锻造 H0/H1；派发受限子 agent；运行风险自适应评审；在不可变 Final Handoff 处停止。精确 `$loop-engineering` 授权持久化 `.ai-loop/` 状态；隐式选择只在本会话内运行。 |
| `status` | 只读检查候选项、harness 漂移、发现、证据、阻塞项和下一个安全动作。不改动任何东西。 |
| `release` | 评估 Final Handoff 的发布就绪度。外部/硬件动作需要显式的 Action Envelope 和即时授权 —— 循环本身永远不会授予。 |
| `knowledge-evolution` | 把已完成的 Handoff/发布蒸馏成人工评审的改进*提案*。应用已批准的提案需要一个新的循环。 |

**没有**公开的 `review` 技能或 `init` 命令。自然语言评审会加载一个内部的只读评审者契约。公开意图只通过这四个技能被发现。

---

## 十个受限 Agent

Agent 携带硬能力契约（frontmatter 来自权威 TOML）。每个 agent 都被隔离：都不能派发其他 agent，都不能写循环账本，所有物理动作权限都被保留。

| Agent | 角色 | 职责 |
|---|---|---|
| `pi-loop-worker` | worker | 已批准工作项的受限 H1 实现（显式 worktree、Allowed Files、测试、停止条件）。 |
| `pi-loop-explorer` | explorer | 只读、CodeGraph 优先的仓库探索者，用于符号追踪、接口、归属、测试、爆炸半径证据。 |
| `pi-loop-reviewer` | reviewer | 独立只读评审者：计划质量、发现归属、残留风险、Verified/Inferred/Not-Run 标注。 |
| `pi-loop-environment-reviewer` | environment-reviewer | 物理 AI 环境 DAG 的只读评审者 —— 低层环境不能证明高层环境。 |
| `pi-loop-safety-reviewer` | safety-reviewer | 独立只读机器人安全评审者：控制边界、故障、执行器限制、实时行为、灰度风险。 |
| `pi-loop-release-engineer` | release-engineer | 信封式发布顾问：出处、可复现、串行集成、回滚、分阶段灰度。（唯一拥有 `release` 能力的 agent。） |
| `pi-loop-robot-brain-engineer` | robot-brain-engineer | 机器人大脑规划、导航、感知到决策流、指令仲裁、大脑↔小脑契约的 H1 作者。 |
| `pi-loop-biped-cerebellum-engineer` | biped-cerebellum-engineer | 双足运动、RL 策略推理、关节映射、PD/MPC/WBC 接口、sim2real 安全的 H1 作者。 |
| `pi-loop-robot-data-collector` | robot-data-collector | 遥操作和自主大规模数据采集流水线、同步、触发、存储、质量门禁的 H1 作者。 |
| `pi-loop-robot-data-algorithm` | robot-data-algorithm | 具身 AI 数据集、预处理、清洗、标注、指标、RL/IL 反馈、分布分析的 H1 作者。 |

---

## 安装

v0.3.5 以一个仓库根目录交付三个宿主清单。三个宿主共享 `skills/`、`dist/`、`assets/`、`schemas/`。环境要求：**Node.js ≥ 22** 和 Git。

### Claude Code

**第 1 步 —— 添加 marketplace**

```
/plugin marketplace add tsungseu/pi-loop-engineering
```

**第 2 步 —— 安装插件**

```
/plugin install pi-loop-engineering@pi-loop-engineering
```

**第 3 步 —— 验证**

```
/plugin details pi-loop-engineering
```

你应该看到 `Skills (4)`、`Agents (10)`、`Hooks (2)`。显式调用某个技能（例如"用 loop-engineering 来……"），或让 Claude 从技能描述里语义匹配自动选择。

### Cursor

Cursor 在 IDE 重启时从 `~/.cursor/plugins/local/` 加载本地插件。

**第 1 步 —— 把仓库链接到本地插件目录**

```powershell
# Windows（目录联接 —— 不需要管理员权限）
mklink /J "%USERPROFILE%\.cursor\plugins\local\pi-loop-engineering" "D:\path\to\pi-loop-engineering"
```

```bash
# macOS / Linux（符号链接）
ln -s /path/to/pi-loop-engineering ~/.cursor/plugins/local/pi-loop-engineering
```

**第 2 步 —— 重载 IDE**

运行命令面板 → `Developer: Reload Window`（或重启 Cursor）。

**第 3 步 —— 验证**

四个技能和十个 agent 出现在插件命名空间下。按名字调用或依赖语义选择。

### Codex

把仓库根目录加载为 Codex 插件（`.codex-plugin/plugin.json`）。用法与 v0.3.0 一致 —— 用 `$` 前缀调用四个公开技能：

```text
$loop-engineering    启动并运行这个物理 AI 编码循环
$status              只读查看当前循环状态
$release             评估当前循环 Final Handoff 的发布就绪度
$knowledge-evolution  从已完成的 Handoff 提炼改进提案
```

Codex 专属的 agent 绑定位于 `skills/*/agents/openai.yaml`；合约快照缓存在 `agents/codex/`。

---

## 快速开始

安装后，用一个明确的指令启动一个循环：

```text
用 loop-engineering 为双足机器人新增一个步态切换控制器，
限制在 src/locomotion/，带单元测试和 sim2real 安全评审。
```

这个技能会：分类请求 → 启动一个持久化的 `.ai-loop/` 循环 → 锻造 H0 → 挑战计划（H1 封印）→ 派发受限 worker → 验证 → 评审 → 冻结 Final Handoff。

随时：

```text
用 status 给我看循环状态和下一个安全动作。
```

Handoff 就绪后：

```text
用 release 评估双足步态切换 Handoff 的发布就绪度。
```

---

## 核心运行时契约

- **受限并行**使用 DAG 就绪度、读/写集合、WaveInput、租约、worktree、fencing token、预算和封印结果准入。
- **Markdown 语言**默认英文（`en-US`），显式支持简体中文（`zh-CN`）。JSON/JSONL 等非 Markdown 输出保持英文。
- **仅 Node 运行时**以确定性 JavaScript ESM 形式交付于 `dist/`，零生产环境 npm 依赖。`npm run check:dist` 把已评审的 TypeScript 绑定到实际执行的字节。
- **CodeGraph 回退**按 MCP → 已有 CLI 索引 → 原生探索的顺序解析。缺失 CodeGraph 永远不会凭空创造 Init 路径；仓库强制规则仍可拦截。
- **护栏钩子**（Claude Code、Cursor）注入会话边界并拦截危险的 shell / 物理动作 —— 它们永远不会授予额外权限。

---

## 环境要求

- Node.js `>=22`（CI 覆盖 22 和 24）
- Git
- 宿主沙箱、审批和文件系统权限，用于硬隔离（Codex、Claude Code 或 Cursor）

---

## 开发

```bash
git clone https://github.com/tsungseu/pi-loop-engineering
cd pi-loop-engineering
npm ci --ignore-scripts
```

验证门禁：

```text
npm run typecheck
npm run schema:check
npm run test:unit
npm run test:cli
npm run test:faults
npm run check:dist
npm run validate:plugin:codex   # 仅 Codex 门禁
npm run validate:plugin         # 完整多宿主门禁
npm test
```

---

## 许可证

Copyright (c) 2026 Tsung Xu。**双授权 —— 任选其一：**

- **GNU AGPL-3.0-only** —— [`LICENSE`](LICENSE) 中的开源许可证。你可以使用、修改和分发本软件（包括商用），**前提是：你基于它构建并通过网络对外提供的软件，也必须以 AGPL-3.0 开源**（强 copyleft）。
- **商业许可证** —— 当你的使用无法满足 AGPL-3.0 时（例如嵌入闭源或专有产品而不开源自己的代码），可获取单独的商业许可证。
