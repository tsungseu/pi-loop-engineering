---
title: PI Loop Engineering Multi-Host Delivery v0.3.5
status: approved
date: 2026-08-13
version: 0.3.5
brand: PI Loop Engineering
plugin-id: pi-loop-engineering
hosts: [codex, claude, cursor]
approach: contract-source-plus-host-adapters
codex-regression: forbidden
commands-directory: omitted
implementation: feature-branch-then-pr
---

# PI Loop Engineering 多宿主交付 v0.3.5 设计

## 1. 摘要

v0.3.5 在 **不破坏已验收 Codex 插件面** 的前提下，把同一仓库根交付扩展为同时支持 **Codex、Claude Code、Cursor** 三个宿主：

1. **安装与发现对等** — 根目录同时具备 `.codex-plugin/`、`.claude-plugin/`、`.cursor-plugin/` 正式清单，共用 `skills/`、`dist/`、`assets/`、`schemas/`。
2. **技能与 Agent 对等** — 四个公开 Skill 共享于根目录 `skills/`（`SKILL.md` 为三宿主真源）；Actor 以 `assets/agents/*.toml` 为唯一合约真源；宿主侧 Agent 放在 `agents/{codex,claude,cursor}/`，文案可不同，硬字段必须一致。Codex 专用 `skills/*/agents/openai.yaml` 保留且语义不变。
3. **运行时护栏对等** — Claude/Cursor 增加 session 边界注入与危险动作护栏 `hooks/`；hooks 只提示/拦截，不授予权限。**不交付 `commands/` 目录**；Claude/Cursor 通过共享 `skills/` 发现与调用，不另做 slash command 镜像。

版本号统一为 **0.3.5**。实施在独立功能分支完成，经 PR 合并；不以直接改 `main` 的方式落地。

## 2. 背景与约束

### 2.1 现状（v0.3.0 / rename 后）

- 仅有 `.codex-plugin/plugin.json`。
- 共享 `skills/*/SKILL.md` + Codex 专用 `skills/*/agents/openai.yaml`（由 `sync-agents` 从 TOML 生成）。
- `validate-plugin` 只扫描/断言 Codex 清单与四 Skill 合约。
- 控制面为 committed Node.js JavaScript ESM（`dist/`），`package` / compatibility / plugin 版本当前为 `0.3.0`。

### 2.2 硬约束（用户确认）

- **Codex 零回归**：不得改变已验证通过的 Codex 安装、发现、Skill 调用、`openai.yaml` 生成语义与验收路径。
- Claude/Cursor 为 **纯增量** 交付面。
- Agent 采用 **宿主分目录**（方案 3），不是单一 Markdown 真源。
- 仓库布局采用 **单根三清单**（方案 1）。
- **不交付 `commands/`**；显式意图通过共享 `skills/` 满足；Claude/Cursor 仍交付护栏 **hooks**。
- 实现路线采用 **合约真源 + 宿主适配**（方案 A）。
- 实施流程：**新建分支 → 实现 → PR**。

### 2.3 非目标（v0.3.5）

- 不改 Loop / Release / Knowledge / Dispatch 核心状态机。
- 不把 hooks 做成 JIT 物理授权替代品。
- **不新增根目录 `commands/`**，不为 Claude/Cursor 单独镜像 slash commands。
- 不强制完成各宿主官方 Marketplace 上架审核流程本身（文档可写安装方式）。
- 不引入第二运行时语言或 Python 控制器。

## 3. 目标

- 三宿主均可发现并调用同一套四个公开 Skill 意图：`loop-engineering`、`status`、`release`、`knowledge-evolution`（路径均为共享 `skills/`）。
- Actor 合约字段在三宿主与 TOML 之间机械一致；Reviewer / Release / `physical_action` 硬规则保持。
- Claude/Cursor 具备护栏 hooks（无 `commands/`）。
- Validator 与 CI 同时证明：**(a) Codex-only 回归绿**，**(b) 完整三宿主门禁绿**。
- 全清单与 package / compatibility 版本同号 `0.3.5`。

## 4. 架构

```
repo root
├── .codex-plugin/plugin.json          # 既有 Codex 面（兼容演进，零回归）
├── .claude-plugin/plugin.json         # 新增
├── .cursor-plugin/plugin.json         # 新增
├── skills/                            # 三宿主共享 Skill 真源（SKILL.md）
│   └── */agents/openai.yaml           # 仅 Codex 绑定（sync-agents 既有输出，语义不变）
├── assets/agents/pi-loop-*.toml       # Actor 合约真源
├── agents/
│   ├── codex/                         # Codex 机读合约快照（旁路校验，不替代 openai.yaml）
│   ├── claude/pi-loop-*.md            # Claude agents
│   └── cursor/pi-loop-*.md            # Cursor agents
├── hooks/
│   ├── claude/hooks.json + ...
│   ├── cursor/hooks.json + ...
│   └── scripts/                       # 可选共享护栏脚本
├── dist/cli/*                         # 共享 Node runtime
├── compatibility.json                 # plugin_version = 0.3.5
└── package.json                       # version = 0.3.5
```

**说明：** 仓库根 **不包含** `commands/`。Claude/Cursor 的 Skill 发现与调用完全依赖共享 `skills/`；Codex 继续 `$skill` + `openai.yaml`。

### 4.1 不变式

| 项 | 值 |
|----|----|
| plugin id | `pi-loop-engineering` |
| display name | `PI Loop Engineering` |
| version | `0.3.5` |
| tagline | `From Prompt Engineering to Loop Engineering for Physical AI.` |
| public skills | 恰好四个，位于共享 `skills/` |
| `commands/` | **禁止交付** |
| runtime | Node.js `>=22`，JavaScript ESM，无 runtime dependencies |
| physical / release authority | 仍走现有 JIT 授权与 `releasectl`；hooks 不授权 |

### 4.2 Skill 绑定关系（澄清）

| 路径 | Codex | Claude | Cursor |
|------|-------|--------|--------|
| `skills/*/SKILL.md` | 使用 | 使用 | 使用 |
| `skills/*/agents/openai.yaml` | 使用（必须，零回归） | 不使用 | 不使用 |
| `agents/claude/*.md` | 不使用 | 使用 | 不使用 |
| `agents/cursor/*.md` | 不使用 | 不使用 | 使用 |
| `commands/` | 不使用 | **不交付** | **不交付** |

## 5. Agent 分目录与合约校验

### 5.1 真源

`assets/agents/pi-loop-*.toml` 定义：

- `name`, `role`, `source_access`
- `required_bindings`, `evidence_requirements`, `stop_conditions`
- `capabilities.*`（含 `external_write`, `network`, `recursive_dispatch`, `ledger_write`, `release`, `physical_action`）

### 5.2 宿主产物

| 宿主 | 路径 | 说明 |
|------|------|------|
| Codex | `skills/*/agents/openai.yaml` | **既有路径，生成语义不变** |
| Codex | `agents/codex/` | 机读合约快照，仅供校验/对照 |
| Claude | `agents/pi-loop-*.md`（**顶级**，非子目录） | frontmatter 含硬字段 + 可差异正文 |
| Cursor | `agents/cursor/pi-loop-*.md` | 同上 |

> **Claude 路径特殊**：Claude Code 只按约定发现**插件根 `agents/` 顶级 `*.md`**，不递归子目录；显式声明 `agents` 字段在 marketplace 安装时静默失败（[anthropics/claude-code#21598](https://github.com/anthropics/claude-code/issues/21598)）。因此 Claude agent 直接放 `agents/` 顶级，manifest 不声明 `agents` 字段。Codex/Cursor 仍各用子目录。三方覆盖**同一组** 10 个 `pi-loop-*` 名称，由 `sync-agents` 与 `validate-plugin` 强制一致。

### 5.3 允许 / 禁止差异

- **允许**：description 正文、示例、宿主语气、Markdown 结构。
- **禁止**：`name`、`role`、`source_access`、全部 `capabilities.*`、`required_bindings`、`evidence_requirements`、`stop_conditions`。

### 5.4 硬规则（继承 v0.3）

- 全员 `physical_action = false`、`recursive_dispatch = false`、`ledger_write = false`。
- Reviewer：`source_access = read-only`，且不得 `external_write` / `network` / `release`。
- 仅 `release-engineer` 可 `release = true`，且只读源访问。

### 5.5 工具

扩展 `sync-agents`：

- 继续更新 Codex `openai.yaml`（输出字节级语义与既有测试兼容）。
- 校验（或刷新）`agents/{codex,claude,cursor}` 硬字段相对 TOML。
- `--check` 在任一宿主硬字段漂移时失败。

## 6. Hooks（无 Commands）

### 6.1 Commands：明确省略

- **不创建** 根目录 `commands/`。
- 四公开意图仅通过共享 `skills/*/SKILL.md` 表达；Skill 正文仍要求先 `triggerctl classify`，再调用同一 `dist/cli/*`。
- **显式调用**与**语义命中**都走 `skills/`：
  - 显式：用户点名某一 Skill（宿主命名空间 / `$skill` 等价入口）。
  - 语义：模型依据 Skill frontmatter `description` 自动选用（不得依赖 `commands/`）。
- `commands/` 是另一条 slash-command 面，对语义命中无增益，本版本禁止交付以免双入口漂移。
- Validator 若发现意外出现的 `commands/` 目录，应 **失败**（防止后续误加破坏「无 commands」合约）；默认推荐：**拒绝存在非空 `commands/`**。

### 6.2 Hooks（仅 Claude / Cursor）

| 意图 | Claude | Cursor |
|------|--------|--------|
| 会话边界注入（四 Skill、无物理权限、先 classify） | `SessionStart` | `sessionStart` |
| 危险 shell / 疑似物理或外部动作前拦截提示 | `PreToolUse`（Bash 等） | `beforeShellExecution`（必要时 `preToolUse`） |

- 布局：`hooks/claude/`、`hooks/cursor/` 各自 `hooks.json`；共享逻辑可放 `hooks/scripts/`。
- Hooks **只提示或 deny 建议**，不得写 ledger、不得授权 Release、不得执行物理动作。
- Codex 清单 **不挂载** 这些 hooks。

### 6.3 清单字段

- `.claude-plugin/plugin.json` / `.cursor-plugin/plugin.json`：声明 `skills`、`agents`、`hooks` 路径（按宿主 schema 允许的字段）；**不声明 `commands`**。
- `.codex-plugin/plugin.json`：**字段集与现网兼容**；不得新增会改变 Codex 加载语义的必填项。版本升至 `0.3.5` 与品牌字段保持一致。

### 6.4 宿主加载期 schema 差异（实施期发现，必须遵守）

实施时通过 `claude plugin validate`、`claude plugin details`（marketplace 安装后实测）与 Cursor 官方文档确认了下列宿主加载期硬约束，self-host validator 必须强制执行：

- **Claude `agents` 必须靠约定发现，不得声明字段**。Claude Code 只扫描插件根 `agents/` 顶级 `*.md`，不递归子目录；显式声明 `agents` 字段（无论字符串、目录还是文件数组）虽能通过 `claude plugin validate`，但 marketplace 安装时 **静默失败**，`claude plugin details` 报 Agents (0) —— 见 [anthropics/claude-code#21598](https://github.com/anthropics/claude-code/issues/21598)。因此 Claude agent 文件直接放 `agents/` 顶级，`.claude-plugin/plugin.json` 完全不声明 `agents` 字段。
- **Cursor `agents` 字段接受目录**，schema 明确允许 "agent files or directories"；当前 `.cursor-plugin/plugin.json` 用 `"agents": "./agents/cursor/"`，Cursor 正常加载全部 10 个 agent。
- **Cursor `hooks/hooks.json` 不接受顶层 `version` 包装**。官方 schema 仅为 `{ "hooks": { ... } }`，任何额外顶层键都被视为非法。因此 `hooks/cursor/hooks.json` 不得含 `version`、`$schema` 等顶层键。
- 上述差异由 `validate-plugin`（`assertClaudeAgentsConvention` / `assertCursorAgentsField` / `assertClaudeHooksShape` / `assertCursorHooksShape`）固化。Claude 侧额外要求：`agents/` 顶级必须正好包含 10 个 `pi-loop-*.md`，与 TOML 名单一一对应。

## 7. Validator、版本与回归门禁

### 7.1 版本同号

以下全部为 `0.3.5`：

- `package.json` / `package-lock.json`
- `compatibility.json`
- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- `.cursor-plugin/plugin.json`
- validator 期望常量
- CHANGELOG 条目

### 7.2 `validate-plugin` 分层

1. **Core** — 插件 id、四 Skill、tagline、Node/runtime、无 legacy；**Codex 清单仍必检**；版本 `0.3.5`；**无 `commands/`**。
2. **Host:Claude** — Claude 清单、十 agents、hooks 可解析且脚本存在；skills 指向共享 `skills/`。
3. **Host:Cursor** — 同上。
4. **Contract** — TOML ↔ 三宿主硬字段一致。

默认完整门禁 = Core + Claude + Cursor + Contract。

另提供 **Codex-only** 入口（`validate:plugin:codex` 或 `--host codex`）：仅 Core + Codex 路径，用于证明 Codex 面未回归。

### 7.3 CI

- 必须同时跑 **codex-only** 与 **full** 两道门。
- 保留并扩展现有 plugin-validation / sync-agents 测试。
- **Codex 金丝雀**：对 `.codex-plugin/plugin.json` 结构兼容性、四 Skill frontmatter 关键字段、`openai.yaml` agent 列表做回归断言，防止无意改动破坏 Codex。

### 7.4 文档

- README / CHANGELOG（中英）说明三宿主安装入口。
- 明确：**Codex 安装与用法不变**；Claude/Cursor 为新增面；**无 `commands/`，Skill 即公开入口**。

## 8. 错误处理与失败语义

- 合约漂移、缺 agent、hooks 坏路径、意外出现 `commands/` → validator / `sync-agents --check` **失败关闭**。
- Hooks 脚本自身异常不得提升权限；失败应偏向 **拦截或明确告警**，而不是静默放行危险动作（具体 deny/ask 策略在实现计划中按宿主 API 落地）。
- Codex-only 校验不得因 Claude/Cursor 文件缺失以外的“可选增量”而改变既有通过条件；完整门禁则要求增量面齐全。  
  说明：v0.3.5 完整交付默认三宿主齐全；若实现阶段需要过渡开关，必须以显式 flag 控制，且不得成为 CI 默认。

## 9. 测试计划（设计级）

- 单元/CLI：扩展 `sync-agents` 合约校验正反例。
- Plugin validation：三清单版本、hooks 存在性、无 `commands/`、Codex 金丝雀。
- 手动烟测清单（实现后）：Codex 仍可用四 `$` 命令；Claude/Cursor 经共享 Skill 发现与调用。
- `npm test` 全绿；Windows `EBUSY` 清理抖动按既有环境策略重试，不放宽断言。

## 10. 实施与发布流程

1. 本设计合入（本分支 PR 或作为同一功能分支的首个提交）。
2. 在 **`feature/pi-loop-multi-host-v0-3-5`**（或后续等价分支）实施。
3. 本地通过 full + codex-only 门禁后开 PR → 审查 → 合并 `main`。
4. 不在未审查的情况下直接推送破坏性改动到 `main`。

## 11. 决策记录

| 决策 | 选择 |
|------|------|
| 对等层级 | 安装发现 + Agent + hooks 护栏；**不含 commands/** |
| Skill 布局 | 共享根 `skills/`；`openai.yaml` 仅 Codex |
| Agent 布局 | 宿主分目录 `agents/{codex,claude,cursor}/` |
| 仓库布局 | 单根三清单 |
| Commands | **省略，不交付**（显式 + 语义均靠共享 `skills/`） |
| Hooks | Claude/Cursor 护栏 hooks |
| 实现路线 | 合约真源 + 宿主适配（A） |
| Codex | 零回归；增量面不得破坏既有验收 |
| 版本 | 0.3.5 |
| 落地方式 | 新分支 + PR |

## 12. 开放实现细节（不阻塞设计，写入计划时钉死）

- Claude/Cursor `plugin.json` 的精确 schema 字段名以各宿主当前官方文档为准。
- `agents/codex/` 快照文件格式（JSON vs YAML）在实现计划中选定一种并测试锁死。
- Hooks 在各宿主上的 deny vs ask 默认策略，以实现时宿主 API 能力为准，但不得授权。
- 对意外 `commands/` 目录：推荐完整门禁直接拒绝；实现计划锁死断言。
