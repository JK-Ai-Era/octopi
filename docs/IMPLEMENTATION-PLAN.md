# Octopi 核心架构重构 — 实施规划（跨 Session 交接文档）

> **地位**：**tracked 交接文档**。  
> **读者**：新 Session / 新会话中的实现 Agent。你可能没有此前讨论的上下文——**以本文 + `docs/north-star.md`（架构宪法）为准**，不要凭感觉改架构。  
> **日期**：2026-09-26  
> **宪法**：**`docs/north-star.md`**。  
> **代码基线**：I1 已合并 `main`（v0.35.0+）。

---

## 0. 开工前 5 分钟（必做）

在**动手改代码之前**，按顺序读完：

| 顺序 | 文档 | 作用 |
|------|------|------|
| 1 | 仓库根 `AGENTS.md` | 分层、测试、提交、配置约定 |
| 2 | **`docs/north-star.md`** | 架构宪法：本体、不变量 I1–I6 / E1–E7、Reserved 位 |
| 3 | 本文 §1–§5 | 现状、目标、阶段、验收 |
| 4 | 当前阶段对应的专题章节（§6+） | 本阶段要改什么 |

然后：

```text
1. 确认工作区：优先在 feat/run-scope-i1 worktree 上继续，或从该分支开新 worktree
   - worktree 路径：C:\Users\James\Projects\octopi-run-scope
   - 若在新机器/新 session：git worktree list 查看；不要直接在 main 上堆未合并的重构
2. 确认 node：Windows 上用 Get-Command node；项目要求 Node >= 24（node:sqlite）
3. npm install（worktree 可能需单独 install）
4. npm test 基线：应为 1634 passed（I1 落地后，见 §3）
```

**依赖工具（MiMo Desktop 环境）**：`$env:MIMO_NODE` / `$env:MIMO_NPM`；PowerShell 下用 `& $env:MIMO_NODE $env:MIMO_NPM test`。

---

## 1. 一句话背景（你在修什么）

Octopi 是**可嵌入 Agent 引擎**。原实现把 **Agent 实例当成「当前 session 的上下文工作区」**（`SessionAwareRunner` 写 `agent.context.messages` 等），导致同 Agent 多 Session 并发时 **消息串味、落盘污染**。

架构结论（已定稿，勿再重开讨论）：

- **Session** = 对话/任务连续性一等 ID  
- **Agent** = 能力与行为模板 + 学习基质（Memory 等）  
- **Run** = `(sessionId, agentId, …)` 一次 episode  
- **可变运行上下文只活在 RunScope**（宪法 **I1**）  
- 锁键 = **sessionId**（同 Agent 多 Session 真并发是产品需求）  
- 产品八层 = system ContextLayer（1–7，含 Runtime）+ Information（消息窗口）  
- Session↔Agent：模型 2 数据形态 + 模型 3 运行面（primary + 显式 Run；Router 在宿主）

**不要做的事**：把锁改成 agentId 当默认语义；用「每 session 一个 Agent 副本」解决并发；在权限热路径做 NLU；把 `agent.workspace`（工具 cwd）和 Run 上下文混名。

---

## 2. 权威文档地图（改架构前先读）

| 文档 | 内容 | git |
|------|------|-----|
| **`docs/north-star.md`** | **架构宪法**：本体、I1–I6、E1–E7、Reserved 位、过度设计边界 | **tracked** |
| `docs/IMPLEMENTATION-PLAN.md` | 跨 session 实施规划 | tracked |
| `docs/architecture.md` / `docs/KNOWN-ISSUES.md` | 对外架构与已知问题 | tracked |
| `arch/north-star.md` | 内部指针 → docs 宪法 | gitignore |
| `arch/session-agent-run.md` 等 | 内部专题稿 | gitignore |
| `arch/session-agent-run.md` | Session/Agent/Run/RunScope 术语与所有权 | gitignore |
| `arch/session-acl.md` | 角色目录（owner/specialist/reviewer/operator/steward）、权限、意图 | gitignore |
| `arch/context-model.md` | 八层 × Scope 叉乘 | gitignore |
| `arch/open-problems.md` OP-AR-3 | Run 物理实现专题与关门条件 | gitignore |
| **`arch/IMPLEMENTATION-PLAN.md`（本文）** | 跨 session 实施规划 | gitignore |
| `CHANGELOG.md` | 每 commit 必更；版本 X.Y.Z | tracked |
| `docs/KNOWN-ISSUES.md` | 对外已知问题摘要 | tracked |
| `docs/architecture.md` | 产品向架构说明 | tracked |
| `docs/context-layer-contracts.md` | Assembler / 层契约 | tracked |

> `arch/` 在 `.gitignore` 中（内部设计）。**交接靠磁盘上的 arch 文件 + 本文**；对外叙事在 `docs/`。  
> 若新 session 在 **主仓库** `C:\Users\James\Projects\octopi` 看不到 I1 代码，说明 worktree 分支尚未合并——见 §3。

---

## 3. 当前状态（截至 2026-09-26）

### 3.1 已完成

| 项 | 说明 |
|----|------|
| 宪法定稿 | **`docs/north-star.md`** |
| 八层 / ACL / Session 模型 | arch 专题文档 |
| **I1 Run 物理（代码）** | **已合并 main**：commit `ff75fd0`，**v0.35.0**（原 worktree `feat/run-scope-i1`） |

**Phase A 状态：已完成（2026-09-26）** — worktree 提交 → fast-forward 合并 main → main 上 `npm run build` + `npm test` **1634 passed**。

**I1 代码落点（worktree）：**

| 文件 | 变更 |
|------|------|
| `src/harness/run-scope.ts` | **新增** RunScope ALS：`withRunScope` / `getRunScope` / `getRunSessionId`；字段 `sessionId` / `agentId` / `systemPrompt` / `toolRuntime` |
| `src/harness/agent/agent.ts` | `run(..., options)` 支持 `context` + `runScope`；经 `withRunScope` + `withResolvedModel` 驱动 `runAgentWithReliability` |
| `src/harness/runner.ts` | `handle` **不再**写 `agent.context.messages`；构造 `runContext` + `runScope` 传入 `agent.run`；system 装配结果只进 Run 工作区 |
| `src/harness/agent-building/builder.ts` | `convertToLlm` / `afterTurn` 优先读 `getRunScope()`；`RuntimeToolContextProvider.get()` 优先 ALS `toolRuntime` |
| `src/harness/reliability/run-agent.ts` | RunGuard checkpoint 的 sessionId/agentId 优先 ALS |
| `src/harness/index.ts` | 导出 `withRunScope` / `getRunScope` / `RunScope` |
| `tests/harness/run-scope-isolation.test.ts` | **新增**：并发 ALS + 同 Agent 双 Session 交错不串味 |
| 部分既有测试 | 改为断言 **LLM 所见 system**（Run 产物），不再断言共享 `agent.context.systemPrompt` |

**验证基线（I1）：**

```text
npm run build   # tsc 通过
npm test        # 1634 passed（全量）
```

### 3.2 交接时注意

- **主仓库 `main` 可能还没有 I1 代码**。开工前：`git worktree list`；在 `octopi-run-scope` 上工作，或 `git merge` / 开新分支自 `feat/run-scope-i1`。
- I1 **尚未 commit** 时，worktree 为脏工作区（见 `git status`）。合并/提交策略见 §5。
- `arch/` 变更不会进 git；**代码 + CHANGELOG + docs/** 才进提交。

---

## 4. 宪法不变量（实现与 Code Review 门禁）

摘自 **`docs/north-star.md`**，**完整版以该宪法为准**。

### 宪法级

| # | 不变量 |
|---|--------|
| **I1** | 可变对话/运行上下文只存在于 RunScope；Agent 是模板与基质 |
| **I2** | Discourse 权威 = Session 追加日志；投影可重建 |
| **I3** | Accountability ≠ Agency；切换执行 ≠ 移交主责 |
| **I4** | 上下文 = 八层类型 × Scope 叉乘 |
| **I5** | 效应面与认知面同等受策略约束（工具 cwd/副作用） |
| **I6** | 引擎消费结构化 Intent；Principal 进审计；人级 IAM 归宿主 |

### 工程级

| # | 不变量 |
|---|--------|
| **E1** | 同 `sessionId` Run 串行；同 Agent 不同 Session 可并发 |
| **E2** | 锁/租约键 = `sessionId` |
| **E3** | Memory 只写本 Agent 库 |
| **E4** | Compact 键 = `(sessionId, agentId)` |
| **E5** | Loop 无状态；生产路径 per-run context |
| **E6** | 角色有效权限 = 底线 ∩ 角色 max ∩ Agent max ∩ 绑定覆盖 |
| **E7** | v1 单进程假设；跨进程必须 Session Lease |

**PR 门禁建议：** 违反 I1/E1/E5 的改动直接打回；战术排期不能否定不变量。

---

## 5. 工作方式（每个 session 都应遵守）

### 5.1 Git / Worktree

- 重构类工作 **优先独立 worktree**，避免污染 main 与并行 agent。
- Conventional Commits：`feat|fix|refactor|test|docs|chore(<scope>): <description>`
- **每个 commit 必须更新 `CHANGELOG.md`**；架构级功能升 **Y**（minor），修 bug 升 **Z**（patch）。
- 内部研发：**不做**向后兼容 shim（与仓库策略一致）。
- 提交前：`npm test` + `npm run build`；有条件再 `npm run lint`。

### 5.2 测试原则（AGENTS.md）

- 测试描述**行为**；行为因架构变更而过时 → **同 PR 改测试**。
- 只 mock 外部服务/不确定输入；不 mock 项目内模块协作。
- 并发类行为必须有**交错**用例（可控 delay mock），不能只测串行 happy path。

### 5.3 命令

```powershell
# 定位 node（勿假设 PATH）
Get-Command node

# 在 worktree 内
npm install
npm run build
npm test
npm run lint

# 定向
npm test -- tests/harness/run-scope-isolation.test.ts
```

### 5.4 新 Session 开工检查清单

- [ ] 已读 `AGENTS.md` + **`docs/north-star.md`** + 本文
- [ ] `git worktree list` / 当前分支正确
- [ ] `npm test` 与 §3 基线一致（或已知差异写进任务说明）
- [ ] 只做一个阶段（§6）的一个子任务；完成即更新任务列表与 CHANGELOG
- [ ] 不在未设计的情况下扩大 ACL/存储范围

---

## 6. 分阶段实施规划

> **总原则**：理念层已定稿；实现按层推进。每阶段有 **目标 / 改动面 / 验收 / 非目标**。  
> 新 session **一次只领一个子任务**，做完勾选，避免半成品横跨多阶段。

---

### 阶段总览

```text
Phase A  I1 收尾与合并          ← 当前优先（worktree 上已有代码）
Phase B  I5 工具效应面（最小）
Phase C  Session 一等数据形态（模型 2 最小集）
Phase D  Compact 与 run 互斥 + 键位
Phase E  ACL / 角色目录（配置种子）
Phase F  preferred / handoff / Principal 审计位
Phase G  预留位硬化（Lease 接口、AgentRevision 字段）
Phase H  文档与宪法验收对齐
```

依赖关系：**A → B/C 可并行 → D 依赖 C 最小字段 → E 依赖 C → F 依赖 E → G/H 贯穿**。  
B（I5）不依赖 C，可与 C 并行。

---

### Phase A — I1 收尾与合并（优先）✅ 已完成

**状态**：2026-09-26 完成。`feat/run-scope-i1` @ `ff75fd0` 已 fast-forward 进 `main`；main 基线 build + 1634 tests 绿。

| 子任务 | 状态 |
|--------|------|
| A1 脏区复核 | ✅ |
| A2 CHANGELOG / package v0.35.0 | ✅ |
| A3 worktree 全量 test + build | ✅ |
| A4 提交 `feat(harness): run-scope isolation...` | ✅ `ff75fd0` |
| A5 合并 main + main 回归 | ✅ FF + 1634 passed |
| A6 文档/CHANGELOG 随提交进入 main | ✅ |

**改动面**：已在 §3.1；A 阶段原则上**不再扩功能**。

**验收（宪法）**：I1/E1/E5；`run-scope-isolation.test.ts` 通过。

**非目标**：ACL、存储键重构、工具沙箱策略、多进程。

**给新 session 的提示**：若 main 已含 I1，跳过 A，从 B 或 C 开始；若 worktree 未合并，**先完成 A**。

---

### Phase B — I5 工具效应面（最小）

**目标**：同 Agent 多 Session 并发时，工具不再默认共享「裸 cwd 踩踏」；至少给出 **策略与可配置隔离**。

| 子任务 | 内容 |
|--------|------|
| B1 | 调研 `agent.workspace` / tool handler 如何取 cwd（builder `RuntimeToolContextProvider.cwd`、shell/file 工具） |
| B2 | 配置面：例如 `toolIsolation: 'none' \| 'session-subdir' \| 'session-lock'`（名可定，但须进 Zod + `octopi.schema.json` + `octopi.example.json`） |
| B3 | `session-subdir`：Run/工具 cwd = `workspace/<agentId>/<sessionId>/`（或宿主指定根下 session 子目录）；创建目录；写入 `toolRuntime.cwd` |
| B4 | `session-lock`：同 sessionId 工具与 run 同锁即可；跨 session 默认 **不**共享写锁——文档写清 |
| B5 | 文档：`docs/KNOWN-ISSUES.md` / architecture 简述 I5 策略 |
| B6 | 测试：两 session 并行调用「写文件」工具，断言写入路径不交叉 |

**验收**：I5 有实现 + 配置 + 测试；默认行为需在 CHANGELOG 写明（建议默认 `none` 或 `session-subdir`——**实现前在任务说明中选定并记录**）。

**非目标**：完整 capability 安全模型、多进程文件锁集群。

---

### Phase C — Session 一等数据形态（模型 2 最小集）

**目标**：存储语义向 `sessionId` 一等 + `primaryAgentId` 演进，消息可归因；**不破坏 I1**。

| 子任务 | 内容 |
|--------|------|
| C1 | 盘点 `SessionStore` 实现：`InMemory` / `Jsonl` / `Sqlite` 的 `load(agentId, sessionId)` 形状 |
| C2 | `SessionData` 增加（可选渐进）：`primaryAgentId?`；assistant 消息 `metadata.agentId` 或等价字段 |
| C3 | API 演进（内部可 breaking）：优先 `loadSession(sessionId)` / 或保持双键但 **primary 字段必填于 create** |
| C4 | Jsonl/目录布局：**设计目标**见 `arch/session-agent-run.md`（sessions 与 agents home 解耦）；实施可分两步：先字段与 create API，再迁路径 |
| C5 | Runner 写回消息时带 `agentId`（来自 RunScope） |
| C6 | 测试：create 带 primary；存盘后 load 可读；消息归因存在 |

**验收**：E4 相关键位为后续 D 铺路；单 agent 行为兼容（primary = 唯一 agent）。

**非目标**：完整 Participant ACL 表、DB 角色目录、历史迁移工具（可后续）。

---

### Phase D — Compact 互斥与键位

**目标**：compact 与 run 不交错覆盖；compact 键 = `(sessionId, agentId)`（E4）。

| 子任务 | 内容 |
|--------|------|
| D1 | `Gateway.compactSession`：与 `SessionAwareRunner.handle` **共用 session 锁**（或迁到 Runner 方法）；仅 `status==='processing'` 不够 |
| D2 | `contextCompact` / `agent.getSessionCompactState` 键位确认含 agentId（I1 后 convertToLlm 已用 ALS sessionId；确认写回 session 时结构） |
| D3 | 测试：同 session compact 与 handle 交错 → 排队或明确拒绝；无静默覆盖 |
| D4 | 多 agent（若 C 已有 primary/guest 运行）：compact 不互相借用（E4） |

**验收**：E4 + compact⊗run 回归。

---

### Phase E — ACL / 角色目录（配置种子）

**目标**：角色可配置；出厂五角色；Run 前强制裁决。

| 子任务 | 内容 |
|--------|------|
| E1 | 实现角色目录加载：内置种子 + 配置文件覆盖（**v1 不做 DB 表**，见宪法「避免过度」） |
| E2 | 配置 schema：`sessionAcl.roles` / `switchDefaults`（Zod + schema.json + example.json） |
| E3 | 出厂角色（**已拍板**，见 `arch/session-acl.md`）：owner / specialist / reviewer / operator / steward；**specialist 与 reviewer 的 readScope 默认 `full`**；specialist `writeMemory=true`、`canManageTasks=true`；**无出厂 canHandoff** |
| E4 | `Participant` 最小：sessionId+agentId → roleId + rights 覆盖；grant/revoke API |
| E5 | `authorizeRun`：effective = L0 ∩ role.max ∩ agent.max ∩ 绑定；未授权 deny |
| E6 | 测试：非法 grant 拒绝；specialist 可 full 读；operator 最小暴露；handoff 默认非 agent |

**验收**：E6 权限测试；不破坏 I1 并发。

**非目标**：角色 DB 表、控制台、consultant 出厂角色（自定义即可）。

---

### Phase F — preferred / handoff / Principal

**目标**：路由提示与问责分离；审计位进 Run。

| 子任务 | 内容 |
|--------|------|
| F1 | Session 字段：`preferredAgentId?`（Activation 缺省执行者）≠ `primaryAgentId`（Accountability） |
| F2 | API：`switch(mode=preferred\|handoff)`；handoff 默认仅宿主 |
| F3 | RunRequest / RunRecord：`actor?` / `tenantId?` / `intent?` 字段位（Principal，I6） |
| F4 | 测试：preferred 变更不改 primary；handoff 审计事件 |

**验收**：I3 + I6 字段位存在且有测试。

---

### Phase G — 预留位硬化（按需穿插）

| 子任务 | 内容 |
|--------|------|
| G1 | Session 锁抽象为可替换接口（in-process 实现 = 现队列；**Lease** 仅接口位） |
| G2 | RunRecord：`agentRevision?` 字段位 |
| G3 | Budget/Quota 挂载点文档化（不强制实现配额 UI） |

---

### Phase H — 文档与验收

| 子任务 | 内容 |
|--------|------|
| H1 | `docs/KNOWN-ISSUES.md`：随阶段关闭条目 |
| H2 | `docs/architecture.md`：并发/RunScope/八层与实现一致 |
| H3 | OP-AR-3 关门条件对照 `arch/open-problems.md` + north-star §8 |
| H4 | `arch/*` 实现状态表更新（磁盘文档） |

---

## 7. 验收测试清单（宪法 §7 落地）

实现任一相关阶段后，至少保持/新增：

| # | 行为 | 状态 |
|---|------|------|
| 1 | 同 agent 双 session 交错 handle，历史零交叉 | **I1 已有** `run-scope-isolation.test.ts` |
| 2 | RunScope 身份：assemble/tool 得到本 run sessionId | I1 部分；E 阶段可加强 tool |
| 3 | compact 键正确、不进错 session | Phase D |
| 4 | 工具上下文 sessionId/messages/cwd 隔离 | Phase B |
| 5 | compact ⊗ run 排队/拒绝 | Phase D |
| 6 | 单会话回归、persona 热更新、reset、abort | 持续 |
| 7 | 无新增「workspace 指代 run 状态」API | 持续 code review |

---

## 8. 明确非目标（勿在实现中「顺手」扩大）

1. 同 Agent 多 Session 用 **agent 级锁** 当默认  
2. **每 session Agent 副本** 作为并发方案  
3. 引擎内 **NLU 权限意图**  
4. 角色 **DB 双通道**（无控制台前）  
5. 完整分布式共识 / 多实例锁（仅 Lease **接口位**）  
6. 把人级 IAM 做进引擎（只留 actor 字段与宿主钩子）  
7. 八层 UI 大改先于 Run 物理与数据语义  
8. 重开 Session/Agent/Run 定义或八层归属（已定稿）

---

## 9. 建议任务领取方式（新 Session）

向当前 Agent 这样描述即可：

```text
请阅读 **docs/IMPLEMENTATION-PLAN.md** 与 **docs/north-star.md**。
在 worktree C:\Users\James\Projects\octopi-run-scope（分支 feat/run-scope-i1 或自该分支新开）
完成 Phase X 子任务 Xn：…
验收：…（粘贴该子任务验收行）
遵守 AGENTS.md：Conventional Commits + CHANGELOG + npm test。
若 main 已合并 I1，请说明并基于 main 继续。
```

一次领取 **一个 Phase 的一至数个子任务**；完成后再领下一个。

---

## 10. 与 memory / 任务面板

- 长期公理以 **`docs/north-star.md`** 为准，不依赖聊天记忆。  
- 实现进度以 **本文 §3 / §6 勾选 + CHANGELOG + git 分支** 为准。  
- Session memory 可记「当前领取了哪个 Phase」，但 **不要**用 memory 替代本文。

---

## 11. 变更记录

| 日期 | 内容 |
|------|------|
| 2026-09-26 | 初版：交接用实施规划；记录 I1 已在 feat/run-scope-i1；Phase A–H |
| 2026-09-26 | Phase A 完成：I1 `ff75fd0` 已并入 main，v0.35.0 |
| 2026-09-26 | 架构宪法权威路径：`docs/north-star.md` |
