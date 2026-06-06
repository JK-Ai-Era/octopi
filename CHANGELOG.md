# Changelog

## v0.2.3 (2026-06-06)

### Harness 层 — Planner + TaskScheduler（Phase 2）

新增规划器和任务调度器，让 Agent 能自主规划和调度任务。

**新增 Planner 模块：**
- `RulePlanner` — 规则驱动的规划器（快速、低成本、可预测）
  - 支持通配符匹配、自定义条件、优先级、once 规则
  - 内置规则：用户消息、安全事件、空闲事件
- `LLMPlanner` — LLM 驱动的规划器（灵活、处理复杂场景）
  - 事件分析 → 结构化计划（JSON）
  - 目标分解 → 可执行步骤
- `HybridPlanner` — 混合规划器（规则优先，LLM fallback）

**新增 Scheduler 模块：**
- `TaskScheduler` — 任务调度器
  - `scheduleOnce` — 延迟执行一次
  - `scheduleInterval` — 按间隔重复执行
  - `scheduleCron` — cron 表达式定时
  - `scheduleAt` — 指定时间执行
  - 支持：暂停/恢复/取消、事件发射

### 测试

- 测试总数：381 → 410（+29）
- 新增 `tests/harness/planner.test.ts` — 29 个测试

## v0.2.2 (2026-06-06)

### Harness 层 — AgentSupervisor（Phase 1）

新增 AgentSupervisor 模块，让 Agent 从“单次对话”进化为“持续运行的进程”。

**新增模块：**
- `AgentSupervisor` — 持续运行的 Agent 核心（认知循环：感知→思考→执行→反思）
- `EventCollector` — 事件收集器（聚合 EventBus + EventSource + 手动注入）
- `Planner` 接口 — 规划器接口（决定 Agent 做什么）
- `Reflector` 接口 — 反思器接口（评估执行质量、识别模式）
- `SupervisorConfig` / `AgentState` / `Plan` / `PlanStep` / `StepResult` 等类型

**设计原则：**
- 基于 Core ProcessModel 实现，有独立生命周期
- Planner 可替换（LLM 驱动、规则驱动、混合）
- Reflector 可选（没有反思器也能运行）
- 与 AgentEngine 共存（单次推理仍由 AgentEngine 完成）

### 测试

- 测试总数：367 → 381（+14）
- 新增 `tests/harness/supervisor.test.ts` — 14 个测试

## v0.2.1 (2026-06-06)

### Core 层架构升级 — 异步原语 + 进程模型

在 Core 层新增两个底层原语，为 Agent 的高级能力（异步任务、多进程协作、消息传递）打基础。

**新增核心原语：**
- `AsyncTask` — 异步任务原语（420 行）
  - 状态机：pending → running → completed | failed | cancelled
  - 支持：取消（AbortSignal）、超时、重试、事件发射、持久化
  - `spawnTask()` 便捷方法：发射后不管
- `ProcessModel` — Agent 进程模型（502 行）
  - 状态机：born → running → sleeping → waiting → dead
  - 支持：父子进程（spawn）、进程间通信（send/receive）、sleep、kill、事件
  - `spawnProcess()` 便捷方法

**新增接口：**
- `EventSource` — 外部事件源协议（webhook、file watcher、timer 等）
- `TaskStore` — 任务持久化协议（内存、文件、Redis 等）
- `MessageChannel` — 进程间通信协议（内存队列、WebSocket、消息队列等）

**设计原则：**
- 内核提供机制（mechanism），Harness 提供策略（policy）
- 内核只做“如果它不做，别人就没法做”的事
- Planner、Reflector、KnowledgeStore 等高级能力全部放 Harness 层

### 测试

- 测试总数：326 → 367（+41）
- 新增 `tests/core/async-task.test.ts` — 22 个测试
- 新增 `tests/core/process-model.test.ts` — 19 个测试

## v0.2.0 (2026-06-06)

### 架构重构 — 三层洋葱模型

完成从单体架构到三层分离的全面重构：

**Core 层（Layer 1）— 纯引擎 + 接口契约**
- `AgentEngine` — 无状态循环引擎，回调槽扩展机制
- `EventBus` — 内置事件总线（`DefaultEventBus` + `NoopEventBus`）
- `SecurityGuard` — 内置安全守卫（注入检测、敏感信息过滤，不可禁用）
- `IterationBudget` — 资源约束（迭代次数、工具调用、token、时间）
- 核心接口：`ModelProvider`、`ToolExecutor`、`ContextPipeline`、`ErrorStrategy`、`Observer`

**Harness 层（Layer 2）— 装具层**
- `AgentBuilder` — Fluent API 组装器，一行代码启动 Agent
- `SessionAwareRunner` — Session 生命周期管理（锁、持久化、并发控制）
- `PersonaLoader` — 文件式人格系统（AGENTS.md、SOUL.md 等）
- `DefaultContextPipeline` — 可插拔上下文管道（Persona → Skill → Task → History → Filter）
- `TaskStage` — Task 系统集成到 ContextPipeline
- `OutputQualityGate` — 输出质量检测迁移到 Harness 层
- `CapabilityEnforcer` + `SecurityPresets` — 安全策略预设

**Integration 层（Layer 3）— 集成层**
- `JsonlSessionStore` / `InMemorySessionStore` — 存储后端
- `NoopObserver` / `LogObserver` — 可观测性

### 新增

- `DefaultEventBus` — 全链路事件系统（`ENGINE_START`、`MODEL_CALL_END`、`INJECTION_DETECTED` 等）
- `DefaultSecurityGuard` — 注入检测 + 敏感信息过滤 + 不可信内容标记
- `IterationBudget` — 迭代次数/工具调用/token/时间四维约束
- `AgentBuilder` — Fluent API，支持 `.model()`、`.persona()`、`.store()`、`.plugin()`、`.budget()` 等
- `SessionAwareRunner` — Session 锁、持久化、Daily/Idle Reset
- `PersonaLoader` — 从目录加载 `.md` 文件，支持多 Persona 叠加
- `DefaultContextPipeline` — 管道模型，每个阶段独立可替换
- `TaskStage` — Task 系统作为 ContextPipeline 阶段注入
- `LegacyAgentRunner` — v0.1.x API 兼容层
- Plugin SDK 子路径导出：`octopi/plugin-sdk/plugin-entry`、`octopi/plugin-sdk/api` 等
- 安全预设：`SecurityPresets.development/testing/production/maximum`

### 变更

- `AgentRunner` 标记为 deprecated，推荐使用 `AgentBuilder` + `SessionAwareRunner`
- `SessionManager` 标记为 deprecated，推荐使用 `SessionAwareRunner`
- `LegacyContextEngine` 标记为 deprecated，推荐使用 `DefaultContextPipeline`
- `LLMRouter` 标记为 deprecated，推荐使用 `ModelProvider` 接口
- Task 系统从 Plugin hook 迁移到 ContextPipeline Stage
- Output Quality 从 Loop 层迁移到 Harness 层

### 测试

- 测试总数：313 → 325
- 新增 `core-engine.test.ts` — AgentEngine 核心循环测试
- 新增 `harness.test.ts` — AgentBuilder + SessionAwareRunner 测试
- 新增 `security.test.ts` — SecurityGuard + CapabilityEnforcer 测试
- 新增 `task-stage.test.ts` — TaskStage ContextPipeline 集成测试

### 文档

- 重写 `README.md` — 反映 v0.2.0 架构
- 更新 `docs/ARCHITECTURE.md` — 完整的三层架构设计文档
- 更新 `docs/REFACTORING-PLAN.md` — 重构方案 v2.0
- 更新 `docs/MIGRATION-AUDIT.md` — 代码迁移审计
- 更新 `docs/plugin-system.md` — Plugin 系统文档
- 更新 `docs/task-system.md` — Task 系统文档
- 更新 `docs/development-guide.md` — 开发指南

---

## v0.1.1 (2026-06-04)

### 重构

- **TaskTracker 异步化** — 所有 CRUD 方法改为 async，文件操作用 stat/readFile/appendFile 替代同步版本
- **applyDecision 去重** — 新建 `src/tasks/shared.ts` 提取共享函数
- **AgentLoop 命名区分** — 重命名为 AgentRunner，保留向后兼容别名
- **plugin.ts 迁移到迭代级 hook** — 从 OpenClaw per-message hook 改为 Octopi 迭代级 hook
- **advisor.ts 删除** — 移除 LoopAdvisor 模式，统一使用 Plugin hook

### 测试

- 新增 JSON 解析边界 case 测试
- 新增并发 session 隔离压力测试
- 测试总数：145 → 150

### 文档

- 新增 `src/tasks/README.md` — Task 系统架构文档
- 新增 `docs/agent-loop-architecture.md` — Agent Loop 对比分析
- 新增 `docs/architecture-refactor-analysis.md` — 架构重构分析
- 更新架构文档 v3，同步实际代码状态

## v0.1.0 (2026-06-02)

### 核心功能

- Agent Loop（消息 → 上下文组装 → 模型推理 → 工具执行 → 回复）
- Session 管理（生命周期、持久化、并发控制）
- 多 Provider 支持（OpenAI / Anthropic）
- Plugin 系统（对齐 OpenClaw 架构）
- Skill 系统（Tool 之上的结构化经验层）
- Task 系统（任务追踪与管理）
- 内置工具（shell、file_read、file_write、file_list）
