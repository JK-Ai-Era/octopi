# Harness — Layer 2: 领域实现

16 个自包含领域，每个领域有自己的类型、实现、入口文件。

## 领域列表

| 领域 | 目录 | 职责 |
|------|------|------|
| Agent | `agent/` | **可运行门面**：`Agent.run()` = reliability 包装；compact 内存桥键 `(sessionId, agentId)` |
| Agent Building | `agent-building/` | Builder、人格加载、配置桥接；注入 `sessionLease` / `sessionAcl` / `toolIsolation` |
| Context Management | `context/` | 消息窗口压缩入口、Token 估算、七层 ContextLayer 装配、Knowledge、`compact-key`（E4）；**结构压缩算法**委托 `capabilities/compact`，状态键仍 E4 |
| Session ACL | `session-acl/` | 角色目录（五角色出厂）、grant/revoke、`authorizeRun`、`switch(preferred\|handoff)`（E6/I3） |
| Tool Effect | `tool-effect/` | `toolIsolation` cwd 解析（I5；默认 `none`） |
| Security | `security/` | 硬边界 + RiskPolicy（安全不可绕过）；Shell 解析、降级策略；安全事件经 `emitRunEvent` 附带 Run 身份 |
| Reliability | `reliability/` | 可靠性包装、HarnessLoopEvent、断路器、重试；`security_blocked` → Observer |
| Plugin Ecosystem | `plugin-ecosystem/` | Plugin、Tool、Skill、MCP、命令 |
| Multi-Agent | `multi-agent/` | Agent 注册发现、Swarm 编排、AgentProcess |
| Autonomous Subsystem | `autonomous-subsystem/` | Sense/Think/Act/Signal/Boundary 五维子系统框架 |
| Session Tasks | `session-tasks/` | 会话任务 SessionTask（goal/step，默认路径） |
| Run Guard | `run-guard/` | 过程监督（continue/recover/stop） |
| Agent Runtime | `agent-runtime/` | 激活宿主：Trigger → 受监督 Run（arch/agent-runtime.md）；RunRequest 含 Principal 字段位 |
| Orchestration | `orchestration/` | experimental 编排（workflow/scheduler/planner） |
| Concurrency | `concurrency/` | 多 Key 负载均衡、限流、**SessionLease**（E2/E7；Gateway 注入共享实例） |
| Observer | `observer/` | **Run Observatory**：ObserverHub + Run 投影；配置 `observer.level`（缺省 off）；与 Core Telemetry `Observer` 分离 |
| Execution Environment | `execution-environment/` | 沙箱、工作区 |
| Human-in-the-Loop | `human-in-the-loop/` | 审批流程 |
| Memory | `memory/` | 命题记忆（fact/method/norm）、confidence/gates；Steward 在 `subsystems/memory-steward/`；七层组装在 `context/` |

> 表内含 Memory 与 Observer 等；权威分层说明见 [docs/architecture.md](../../docs/architecture.md) 与 [docs/observer-domain.md](../../docs/observer-domain.md)。

## 横切：公用能力（capabilities）

| 模块 | 目录 | 职责 |
|------|------|------|
| **Capabilities** | `capabilities/` | **公用能力**（非业务领域计数）：`summary/`（SummaryPort + Policy + L1/L2 工具门控）与 `compact/`（可配置压缩引擎）。tools 只消费 port；E4 会话 compact 状态不在本目录 |

配置：`summary` / `compact` / `models.level.summary`。设计：内部 `arch/summary-compact.md`；对外摘要见 `docs/context-layer-contracts.md`。

## 其他文件

- `runner.ts` — SessionAwareRunner（编排器：session 锁/lease、toolIsolation cwd、compactSession、可选 ACL authorize；经 `agent.run()` 驱动；Observer 经 `emitObserved` 采样）
- `session-types.ts` / `session-compact.ts` — SessionData 模型 2 字段 + compact 分桶读写
- `run-scope.ts` — RunScope ALS（I1；含 `runId` / toolRuntime / agentRevision）
- `index.ts` — Harness 层统一导出
- `types/` — Harness 层共享类型
- `budget/` — BudgetPolicyEngine 安全阀（wall-clock；无默认 token hard，见 arch/budget-redesign.md）
- `accounting/` — UsageLedger + SessionLedger 账本（P1/P4）
- `process/` — 进程管理

## 依赖规则

- 只依赖 Core（Kernel）和 Loop
- 不依赖 Integration
- 领域间通过对方 **types** 通信，不共享内部状态；Domain 契约定义在本层领域内
- **推荐运行入口是 `harness/agent` 的 `Agent.run()`**，不要在业务路径手拼 `runAgentWithReliability`
