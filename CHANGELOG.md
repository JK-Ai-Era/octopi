# Changelog

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
