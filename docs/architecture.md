# Octopi 架构设计文档

> 版本：v0.36.0 | 日期：2026-09-21
>
> 本文档是 Octopi 的完整架构设计。
> 长期不变量见 [架构宪法](./north-star.md)。
> 与实现对齐：Observer Run Observatory（v0.43.3+）见 [observer-domain.md](./observer-domain.md)；公用能力 Summary/Compact（v0.44.0+）见 [context-layer-contracts.md](./context-layer-contracts.md) 与 `src/harness/capabilities/`。

---

## 1. 设计哲学

### 1.1 Agent 是一个运行时，不是一个类

传统框架把 Agent 做成一个 class。但真实的 Agent 需要的是一个**完整的运行时环境**：

- 一个消息循环引擎
- 一套上下文组装策略
- 一个模型调用能力
- 一组工具执行能力
- 一个状态持久化后端
- 一套安全策略
- 一个记忆和学习系统

这些组件的组合方式是无穷的。框架不预设组合方式，而是提供**清晰的接口**和**可替换的组件**。

### 1.2 四层分离

```
Loop（循环）       → 纯执行循环，零外部依赖
Core（核心）       → 机制原语 + 接口契约 + 核心类型
Harness（装具）    → 领域实现，每个领域自包含
Integration（集成）→ 外部系统适配
```

**依赖方向：外 → 内。内层不知道外层的存在。**

### 1.3 面向未知进化

AI 在早期阶段，应用构建思路在不断发展。架构设计的核心目标：

- **可孤立理解** — 每个模块能被独立理解，不需要全局上下文
- **领域自包含** — 修改一个领域不影响其他领域
- **显式依赖** — 模块间通过接口通信，影响范围可静态分析
- **渐进式扩展** — 新能力作为新领域加入，不改变已有结构

### 1.4 安全是内置的，不是附加的

安全不是"加一个安全模块"，而是每一层都有安全职责。Core 层定义 SecurityGuard 接口，Harness 层实现安全策略，两者共同构成不可绕过的安全防线。

---

## 2. 四层架构

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 3: Integration — 外部适配                                  │
│  LLM Provider · Web Search · 存储 · 可观测性 · 协议 · Gateway · TUI · Web Runtime │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  Layer 2: Harness — 16 个自包含领域 + capabilities 横切      ││
│  │                                                              ││
│  │  ┌──────────────────────────────────────────────────────────┐││
│  │  │  Layer 1: Core — 机制原语 + 接口契约 + 核心类型           │││
│  │  │                                                          │││
│  │  │  ┌──────────────────────────────────────────────────────┐│││
│  │  │  │  Layer 0: Loop — 纯执行循环                          ││││
│  │  │  │  agentLoop · callModel · classifyError           ││││
│  │  │  └──────────────────────────────────────────────────────┘│││
│  │  └──────────────────────────────────────────────────────────┘││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### Layer 0: Loop — 纯执行循环

**职责**：调用 LLM → 解析响应 → 执行工具 → 循环。通过 async generator yield 事件流。

**特性**：零外部依赖。不依赖 EventBus、SecurityGuard、Budget。所有扩展通过 AgentLoopConfig 回调注入。

**关键不变量**：
- LLM 业务失败永不 throw（`onError` 仅 `retry`/`abort`；终止必 yield `agent_end`）
- 工具批次内全部 `terminate=true` → `agent_end(should_stop)`
- `tool_results` 与 `tool_calls` 一一对应（含中止占位）
- 流式优先使用 provider 透传的 `finishReason`（`done` chunk）
- `turn_end.phase`：`pre_tools`（工具即将执行）/ `final`（本轮无工具路径结束）
- 事件词表仅 Loop 协议；budget/run_guard 事件在 `HarnessLoopEvent`
- 进入 `ModelProvider` 的 messages 已规范化（toolResults 展开、tool_calls 字符串化）
- 引擎只托管 `metadata.source === 'systemPrompt'` 的 system；无 metadata 一律保留

#### `turn_end.phase` — UI / 上层消费约定

| phase | 含义 | UI 应做什么 |
|-------|------|-------------|
| `pre_tools` | 本轮 LLM 返回 tool_calls，消息已入历史，**工具尚未/正在执行** | 保持「进行中」；可展示工具列表；**不要**把 run 置为 idle |
| `final` | 本轮无工具路径结束（纯文本 / followUp / 截断回灌 / 错误重试） | 可 finalize 助手消息；可置 idle |

**不要**把每一次 `turn_end` 都当成「本轮 run 结束」。工具路径下 `pre_tools` 之后还有 `tool_*` 事件；终止时可能直接 `agent_end`，**不会再补** final turn_end。

Runner 映射到 EventBus 的 `turn.end` 时会带上 `data.phase`。Web `runStatus`：`pre_tools → 'tools'`，`final → 'idle'`。TUI 在 `pre_tools` 时保持 processing。

```
src/loop/
├── agent-loop.ts         # agentLoop() — 纯函数
├── call-model.ts         # callModel() — LLM 调用（watchdog + finishReason）
├── error-classifier.ts   # classifyError() — 错误分类
├── types.ts              # AgentLoopConfig, AgentLoopEvent 等
└── index.ts
```

可运行 Agent 门面在 `src/harness/agent/`（`run()` = reliability 包装）。

### Layer 1: Core — 机制原语 + 接口契约

**职责**：定义框架的所有契约（接口），提供基础设施原语（EventBus 等），定义核心类型。

**特性**：不依赖任何外层。不包含策略实现。**不 re-export Loop**（`agentLoop` / `AgentLoopEvent` 从 `loop/` 导入；Agent 门面从 `harness/agent/` 导入）。

```
src/core/
├── interfaces/           # Kernel + Product port 类型
│   ├── kernel.ts
│   ├── model-provider.ts
│   ├── security-guard.ts
│   ├── session-store.ts
│   ├── observer.ts
│   ├── error-strategy.ts
│   ├── run-guard.ts
│   ├── reliability.ts
│   ├── tool-bus.ts
│   └── index.ts
├── types/                # Kernel 词汇表
│   ├── messages.ts
│   ├── agent-definition.ts  # ModelInfo / ToolPolicy
│   ├── session.ts
│   ├── turn.ts
│   ├── tools.ts
│   ├── queue-mode.ts
│   ├── thinking-level.ts
│   └── index.ts
├── primitives/           # EventBus、StateMachine、Cron（纯机制）
│   ├── event-bus.ts
│   ├── state-machine.ts
│   └── index.ts
├── security-guard.ts
└── index.ts              # octopi/core — Kernel
```

产品事件词表在 `harness/events/`（AgentEventMap / AgentEvents / scenario-events）。

Domain 契约在 **harness 领域内**（memory、mcp、multi-agent、orchestration…），不在 Core。

### Layer 2: Harness — 16 个自包含领域 + 横切 capabilities

**职责**：实现 Core Kernel ports 的具体策略，提供框架的全部高级功能；持有 Domain 产品契约与实现。

**特性**：每个领域有自己的类型、实现、入口文件。领域间通过对方 **types** 通信，不共享内部状态。

（详见第 3 节）

### Layer 3: Integration — 外部适配

**职责**：对接外部系统（LLM 提供商、存储后端、可观测性、协议、UI）。

**特性**：只做适配转换，不做业务逻辑决策。

```
src/integration/
├── providers/            # LLM Provider（OpenAI, Anthropic）
├── web-search/           # Web Search Provider（DuckDuckGo, Tavily, Brave, Serper, MiMo）
├── storage/              # 存储后端（JSONL, SQLite, Memory）
├── observability/        # Telemetry：Trace、Metrics、Exporters（Core Observer 适配）
├── gateway/              # 网关
├── protocols/            # 协议适配（HTTP）
├── tui/                  # 终端 UI
├── web/                  # Web Runtime / WebUI 骨架
└── index.ts
```

> **Observer Domain**：Telemetry（上表 `observability/` + Core `Observer`）与 **Run Observatory**（`harness/observer/`，配置键 `observer`）同属观测领域、实现分离。见 [docs/observer-domain.md](./observer-domain.md)。Run Observatory 缺省 `observer.level=off`；调试 REST 为根路径 `/debug/run/*`（非 `/api/v1`）。

---

## 3. Harness 领域

### 3.1 Agent Building — Agent 构建

**职责**：组装 Agent 运行时，加载人格配置，桥接配置文件。产出已 `setHarness` 的 `harness/agent` Agent。

```
harness/agent-building/
├── builder.ts            # AgentBuilder — Fluent API
├── persona.ts            # 人格加载（根目录 AGENTS.md + persona/*.md）
├── config-bridge.ts      # 配置文件 → 新架构桥接
└── index.ts
```

Agent home 目录约定（由 `initOctopi` / `ensureAgentDirs` 脚手架）：

```
<agentHome>/
  AGENTS.md              # 主 persona，最先加载
  persona/               # 补充 persona（字母序；数字前缀控制顺序）
  skills/                # 技能（可由 skillDirectory 指向）
# 注意：sessions 不在 agent home —— 见 OCTOPI_HOME/sessions/
```

Memory / Cognition / Wisdom / Knowledge **不按目录落盘**，统一由 per-agent SQLite `AgentDatabase`（`agent.db`）承载。

Jsonl 会话目录为 **sessionId 一等** `OCTOPI_HOME/sessions/`；`SessionData` 含模型 2 字段（`primaryAgentId` / `preferredAgentId` / `participants` / `contextCompacts`）。`SessionStore.load(sessionId)` 已实现；**无** `agents/<id>/sessions/` 兼容回退。运行时 **唯一** Session 后端是 `JsonlSessionStore`（`SqliteSessionStore` 已删除）。可选投影 `sessions.index.db`（可重建）仅供 `session_search` 预筛，**不是**第二权威（`arch/session-history-search.md`）。

> 旧 `extract/`（JsonlExtractorStore）目录已随 memory ETL 提取器移除；补录/治理走 `memory.steward.*` 子系统，素材读 SessionStore。

### 3.2 Context Management — 上下文管理

**职责**：消息选择、压缩、Token 估算、智能路由；以及七层 system prompt 内容层契约与装配。

```
harness/context/
├── layer-types.ts          # ContextLayer 契约（七层）
├── assembler.ts            # DefaultContextAssembler
├── layers.ts               # 薄适配层 + createDefaultLayers
├── system-prompt-assembler.ts
├── summarize.ts
├── compact-key.ts          # E4：compact 键 (sessionId, agentId)
├── default-context-engine.ts   # 消息窗口入口（状态键含 agentId）
├── smart-router.ts             # 智能路由决策
├── message-selector.ts         # 四区域消息选择
├── hybrid-compressor.ts        # 混合压缩器
├── llm-summarizer.ts           # LLM 摘要压缩
├── truncate-compressor.ts      # 截断兜底
├── budget-allocator.ts         # Token 预算分配
├── token-estimator.ts          # HeuristicTokenEstimator
├── token-estimate-fns.ts
├── token-constants.ts
├── knowledge/                  # KnowledgeStore + KnowledgeContextEngine
└── （结构压缩算法已委托 harness/capabilities/compact；E4 状态仍在本引擎）

harness/capabilities/          # 横切公用能力：SummaryPort + CompactEngine
harness/session-acl/        # E6：角色目录 + authorizeRun + switch
harness/tool-effect/        # I5：toolIsolation cwd
harness/observer/           # Run Observatory：ObserverHub + Run 投影（observer.level）
harness/concurrency/session-lease.ts  # E2/E7：SessionLease
harness/capabilities/       # 横切公用能力（不计入业务领域计数）：summary + compact
```

领域导出见 `harness/index.ts`。设计说明见 [docs/context-layer-contracts.md](./context-layer-contracts.md)、[docs/observer-domain.md](./observer-domain.md)。

**公用能力（capabilities，横切）**：`harness/capabilities/summary|compact` 提供可注入的 LLM 摘要/信息提取与可配置压缩管道。与 `plugin-ecosystem/tools` 边界：tools **只消费** `SummaryPort`，prompt/policy/算法只在 capabilities；会话 compact **E4** 键与 Session 持久化不在 capabilities（仍在 context / session 路径）。配置键：`summary` / `compact` / `models.level.summary`。

### 3.3 Security — 安全

**职责**：工具调用风险评估、Shell 命令解析、安全降级、安全智能体。

**分层（安全不可绕过）**：硬边界（确定有害，不受 `enforce` 影响）→ 始终接线的 `ToolCallRiskPolicy`（争议分档）→ 可配置仅 `enforce` / `allowedPaths` / `injectionSensitivity`。不透明载荷（`file_write.content` 等）不做 shell 元字符扫描。

```
harness/security/
├── default-security-guard.ts   # 硬边界 + 始终接线 RiskPolicy + Input/Output
├── default-risk-policy.ts      # DefaultToolCallRiskPolicy — 规则引擎
├── risk-evaluator.ts           # 操作+目标组合风险评估 + 硬边界探测
├── shell-parser.ts             # Shell 命令解析器（4 层）
├── degradation.ts              # 6 种降级策略
├── capability-enforcer.ts      # 信任分级
└── index.ts
```

安全守卫子系统定义在 `subsystems/safety-guard/`（config.yaml + SUBSYSTEM.md），由 Autonomous Subsystem 领域加载；不在本目录。

### 3.4 Human-in-the-Loop — 人机交互 [新增]

**职责**：审批请求管理、审批策略、用户决策缓存。

```
harness/human-in-the-loop/
├── approval-manager.ts    # 审批请求管理
├── approval-policy.ts     # 审批策略（auto / confirm-all / confirm-high-risk）
├── decision-cache.ts      # 用户决策缓存
├── feedback-collector.ts  # 用户反馈收集
├── types.ts
└── index.ts
```

### 3.5 Execution Environment — 执行环境 [新增]

**职责**：沙箱管理、工作区生命周期、高级文件操作、资源限制。

```
harness/execution-environment/
├── sandbox.ts             # 沙箱管理（进程隔离、文件系统隔离）
├── workspace.ts           # 工作区生命周期
├── file-ops.ts            # 高级文件操作（search、glob、diff）
├── resource-limits.ts     # 资源限制
├── types.ts
└── index.ts
```

### 3.6 Memory — 记忆系统 [新增]

**职责**：记忆存储/检索、认知图谱、智慧生成。持久化统一走 per-agent SQLite 单库（内置 `node:sqlite`，需 Node.js >= 24）。

```
harness/memory/
├── store.ts              # InMemoryMemoryStore（默认内存实现）
├── confidence.ts         # 写入暂定置信度 / injectFilter / profile 映射
├── gates.ts              # 结构门控 + mapLegacyType
├── similarity.ts         # 归一化 / trigram / findDuplicate（无语义极性）
├── decay-policy.ts       # 按类型衰减曲线（fact/method/norm）
├── backfill-coverage.ts  # 补录覆盖表 + 密度预筛
├── backfill-trigger.ts   # 补录脉搏（硬收敛 / idle / gap）
├── health-probe.ts       # 库存水位双脉搏（memory.health.*）
├── cognition.ts          # InMemoryConceptGraph
├── types.ts              # MemoryType = fact|method|norm；Store 契约
├── sqlite/
│   ├── agent-db.ts       # AgentDatabase — per-agent agent.db
│   ├── memory-store.ts   # SqliteMemoryStore
│   ├── backfill-coverage.ts
│   ├── wisdom-store.ts   # SqliteWisdomStore
│   ├── cognition-store.ts
│   ├── knowledge-registry.ts
│   └── embedding.ts
└── index.ts
```

> **已移除**：`harness/memory/extraction/`（ETL 采集/桥接/Pending）与 `subsystems/memory-extractor`。  
> 记忆写入 = agent `memory_store` 工具；旁路 = `memory.steward.backfill` / `memory.steward.govern`（对外见 [`docs/memory.md`](./memory.md)）。

`FileWisdomStore` / `FileProjectMemory` / `ContextIntelligence` 已删除；不要再预设 `memory/`、`wisdom/` 文件目录。system prompt 层组装见 `harness/context/`。

### 3.7 Reliability — 可靠性

**职责**：Agent 循环的可靠性包装 — 重试、检测、监督、断路。产出 `HarnessLoopEvent`。

```
harness/reliability/
├── run-agent.ts          # runAgentWithReliability()（底层；业务入口用 Agent.run）
├── harness-events.ts     # HarnessLoopEvent = AgentLoopEvent | budget/run_guard 扩展
├── circuit-breaker.ts    # CircuitBreaker — 断路器
├── provider-wrapper.ts   # wrapProviderWithCircuitBreaker()
├── budget.ts             # BudgetPolicyEngine（P5 正式定名）
└── index.ts
```

可运行门面在 `harness/agent/`（见 3.0）。

### 3.0 Agent — 运行时门面

**职责**：持有 context/config/harness，提供 **`Agent.run()`** 唯一推荐运行入口（= reliability 包装）。

```
harness/agent/
├── agent.ts              # Agent 类
└── index.ts
```

Loop 层只有 `agentLoop` 纯函数；不要在业务路径手拼 `runAgentWithReliability`。

### 3.8 Plugin Ecosystem — 插件生态（扩展点 + 调用面）

**职责**：Plugin 系统、Skill 管理、工具注册、MCP 集成、**对话斜杠命令（Principal 调用面）**。

与 tools/（Agent function-call 调用面）对偶；Command **不是**顶层能力域，也 **不是** Human-in-the-Loop（HITL 只做 risk approval）。

```
harness/plugin-ecosystem/
├── plugins/              # PluginManager, HookRegistry, Loader
├── tools/                # ToolBus, BuiltinTools, web_search（Agent 调用面）
├── skills/               # SkillManager（两阶段加载；frontmatter.command → /name）
├── mcp/                  # McpManager, Bridge, Discovery
├── commands/             # CommandRouter / builtin / skill·user·plugin 桥接
└── index.ts
```

**命令要点**（实现：`commands/`；问题面：`harness/diagnostics`）：

- 入站 `/xxx` 在 Agent Loop **前**裁决；handler 只回 `sessionOps`，Host 落地  
- 冲突 fail-closed：保留名硬保护；同名多候选默认 reject-all（粘性，直到候选收敛）  
- `/stop` 为唯一默认 `preempt` control（多渠道对话中止）  
- 来源：builtin / plugin `registerCommand` / `agents/<id>/commands/*.md` / SKILL.md `command`  
- catalog：`GET /api/v1/commands` + WS welcome；UI 输入 `/` 补全

### 3.9 Autonomous Subsystem — 自主子系统

**职责**：独立于主 Agent 循环之外，为解决特定问题而自主运行的子系统框架。
五维模型：Sense + Think + Act + Signal + Boundary。

```
harness/autonomous-subsystem/
├── types.ts              # 五维模型完整类型定义
├── loader.ts             # 子系统目录加载器
├── runtime.ts            # SubsystemRuntime — 核心运行时
├── sense/
│   ├── engine.ts         # SenseEngine（condition 表达式、冷却期、深度限制）
│   ├── metrics.ts        # MetricsStore
│   └── input-builder.ts  # 输入构建器
├── think/
│   ├── executor.ts       # ThinkExecutor（code/llm/hybrid）
│   └── model-resolver.ts # ModelResolver（models.level + fallback）
├── signal/
│   └── bus.ts            # SignalBus（四通道投递）
├── session/
│   └── manager.ts        # SubsystemSessionManager
├── audit/
│   ├── writer.ts         # AuditWriter
│   └── reader.ts         # AuditReader
├── boundary/
│   └── validator.ts      # BoundaryValidator
└── index.ts
```

子系统定义目录（可来自框架内置、用户自定义、npm 包）：
```
subsystems/
├── safety-guard/
│   ├── SUBSYSTEM.md
│   └── config.yaml
└── ...
```

**支持来源**：框架内置、用户自定义、npm 包（`@octopi/subsystem-*` / `octopi-subsystem-*`）

### 3.10 Multi-Agent — 多 Agent 编排

**职责**：Agent 注册与发现、多 Agent 协作编排、可追踪的 Agent 进程。

```
harness/multi-agent/
├── registry.ts           # DefaultAgentRegistry
├── swarm.ts              # AgentSwarm + 编排策略
├── process.ts            # AgentProcess / spawn / fork
├── types.ts
└── index.ts
```

Core 接口：无（契约在 `harness/multi-agent/agent-registry-types.ts`）。

与 Autonomous Subsystem 正交：Multi-Agent 管「多个 Agent 实例如何协作」；Autonomous Subsystem 管「子系统如何感知并回写主系统」。

### 3.11 Session Tasks — 会话任务

**职责**：未闭合工作项列表（goal/step 两级），挂 Session 聚合。

```
harness/session-tasks/
├── service.ts            # SessionTaskService — 唯一写入口
├── render.ts             # <session_tasks> 注入（goal + step rollup）
├── tools.ts              # task_* 工具
├── types.ts
└── index.ts
```

设计基准：[docs/task-system.md](./task-system.md)。

### 3.12 Run Guard — 过程监督

**职责**：判断单次 run 是否跑飞（continue / recover / stop）。

```
harness/run-guard/
├── default-run-guard.ts  # DefaultRunGuard — 规则检测 + 可选 LLM 审查
├── types.ts
└── index.ts
```

Core 接口：`core/interfaces/run-guard.ts`（`RunGuard`）。

### 3.12b Agent Runtime — 激活宿主

**职责**：把非用户刺激（Trigger）编译成 0..N 次受监督的 Run；多 Agent 显式路由。串行互斥归 Session 级 Runner 锁（模型 A）；详见 [架构宪法](./north-star.md) 与本文 §5 数据流。

```
harness/agent-runtime/
├── runtime.ts            # AgentRuntime
├── router.ts / compiler.ts / coalesce.ts / dispatcher.ts
└── sources/              # Schedule / Escalate / AgentSignal

integration/agent-runtime/
├── channel-message-source.ts
├── webhook-source.ts
└── file-watch-source.ts
```

Gateway 消息路径经 `runtime.dispatch`；SessionGate 为唯一并发硬闸；模型 A（无第二 session 队列）。

### 3.13 Orchestration — 编排（experimental）

**职责**：确定性多步骤作业。默认不进主路径；子路径 `octopi/harness/orchestration`。

```
harness/orchestration/
├── workflow/             # WorkflowEngine — DAG 编排
├── scheduler/            # TaskScheduler
├── planner/              # Rule/LLM/Hybrid planner
├── strategy/             # 任务分类 + 策略路由
├── quality/              # OutputQualityGate
├── reflector/            # LLMReflector
└── index.ts
```

领域切分见 [docs/domain-split.md](./domain-split.md)。

### 3.14 Concurrency — 并发控制

**职责**：多 key 分发、会话粘滞、限流。

```
harness/concurrency/
├── provider-pool.ts      # ProviderPool — 多 Key 负载均衡
├── rate-limiter.ts       # RateLimiter — 令牌桶限流
├── session-gate.ts       # SessionGate — 并发门控
├── tool-validator.ts     # ToolValidator — 工具结果验证
└── index.ts
```

### 3.15 Observer — Run Observatory（开发调试观测）

**职责**：打包 Run 可检视现场（Scope / messages / timeline / guard / security / memory / tool.effect），供 Web Run 面板与 `/debug/run/*`。与 Core `Observer`（Telemetry）分属同一 Observer Domain 的不同子域，**不合并实现**。

```
harness/observer/
├── hub.ts            # ObserverHub — 事件摄入 + Run 投影缓存
├── types.ts          # ObserverConfig / Run* DTO / resolveObserverConfig
├── run-snapshot.ts   # RunScope → UI 视图
└── index.ts
```

| 约定 | 值 |
|------|-----|
| 配置键 | `observer`（Telemetry 用 `observability`） |
| 缺省 | `level: 'off'`；`webPanel` 跟 level |
| Run 身份 | `RunScope.runId` / `createRunId` |
| 采样 | Runner `emitObserved`；Builder ContextEngine `emit`；Gateway **不**二次 ingest |
| 调试 REST | `GET /debug/run/:sessionId/scope\|messages`（根路径） |

详见 [docs/observer-domain.md](./observer-domain.md)。

---

## 4. Context Intelligence — 八层智能模型

> **架构宪法**：[`docs/north-star.md`](./north-star.md)（类型轴 × Scope 轴；不变量 I1–I6）。实现与评审以该文为准。  
> **产品八层 = system 侧 ContextLayer（1–7，含 Runtime）+ Information（第 8 层，消息窗口）。**

### 核心理念

要让 agent 变得聪明，核心在于给会话提供更有效的 context。
上下文模型包含两条正交轴：

1. **信息分馏（认识论）**：从原始信息中逐层提炼，沉淀到 Agent 基质。  
2. **每轮装配（运行时）**：本轮 LLM 看到什么 = Agent 基质 system 层 + Run 活态（Runtime）+ Session 消息窗口（Information）。

**实现落点**：`harness/context/`（`ContextLayer` 契约 + `DefaultContextAssembler` + 薄适配层）。  
设计细节见 [docs/context-layer-contracts.md](./context-layer-contracts.md)。

```
分馏上行（Agent 成长）:
  Information → Memory → Cognition → Wisdom

另三个 Agent 基质维度:
  Persona = agent 的 DNA
  Knowledge = 外部参考资料（可多 scope）
  Skill = 工作流定义
```

### 八层定义（产品概念模型）

| # | 层 | 本质 | 归属 | 默认路径状态 |
|---|---|---|---|---|
| 1 | **Wisdom** | 思维范式 | Agent 基质 | **已接线**（Builder/Gateway 可挂 WisdomStore） |
| 2 | **Persona** | agent 的 DNA | Agent 基质 | **已接线** |
| 3 | **Skill** | 工作流定义 | Agent 基质 | **已接线**（`formatForPrompt` 索引） |
| 4 | **Knowledge** | 外部参考资料 | Knowledge scope（默认 agent） | **已接线**（进程内 store） |
| 5 | **Cognition** | 概念关系网络 | Agent 基质 | **已接线**（Builder/Gateway 可挂 ConceptGraphStore） |
| 6 | **Memory** | 交互中提取的洞察 | 库归 Agent；原料来自 Session | **已接线**（`SqliteMemoryStore`） |
| 7 | **Runtime** | 本轮/本会话活态注入 | **Run**（Session 感知） | **已接线**（tasks / guidance / `injectedContext`） |
| 8 | **Information** | 原始交互记录（session 消息） | **Session** | **已接线**（消息窗口，**不是** ContextLayer） |

**概念模型 vs 实现契约（必读）：**

- **产品八层**的第 7 层是 **Runtime**（system 侧），第 8 层是 **Information**（消息窗口）。
- `ContextLayerId`（system 装配契约）= 产品第 **1–7** 层：`wisdom / persona / skill / knowledge / cognition / memory / runtime`。
- **Information 不进 ContextAssembler**；由 `DefaultContextEngine` 做消息选择 / 压缩 / 主动摘要。
- 恒等式：**产品八层 = system ContextLayer（7）+ Information（1）**。`ContextLayerId` 无需为八层增删。

### 组装分工

```
分馏（认识论）:
  Information（session）→ Memory → Cognition → Wisdom

LLM 实际输入:
  system prompt  = ContextLayer 装配（Wisdom/Persona/Skill/Knowledge/Cognition/Memory/Runtime）
  messages       = Information 窗口（ContextEngine）
```

System 契约层 order（= 产品八层之 1–7）：

```
1. Wisdom     ← order 10   Agent 基质
2. Persona    ← order 20   Agent 基质
3. Skill      ← order 30   Agent 基质
4. Knowledge  ← order 40   Knowledge scope
5. Cognition  ← order 50   Agent 基质
6. Memory     ← order 60   Agent 库 + Run 召回
7. Runtime    ← order 70   Run 活态（tasks/guidance/injectedContext）
8. Information ← 不进 ContextLayer；ContextEngine 管窗口（产品第 8 层）
```

### memory/ 领域的抽象（redesign 后）

```
Information → Memory   提炼：可行动命题（fact / method / norm）
Memory → Cognition     结构化：概念之间的关系（后续子系统）
Memory → Wisdom        升华：思维范式（后续子系统）
```

写入通道：主 agent `memory_store`（宪法 + 门控 + 置信度）→ MemoryStore；  
旁路治理：`memory.steward.backfill` / `memory.steward.govern`。  
**无** session ETL 提取器。

---

## 5. 核心数据流

```
用户消息
  ↓
SessionAwareRunner.handle()           ← Session 生命周期；播种 contextCompact
  ↓
SessionTask / guidance → injectedContext
  ↓
ContextAssembler（system 契约层）       ← Persona + Skill + Knowledge + Memory + Cognition + Wisdom + Runtime
  ↓
Agent.run() / runAgentWithReliability()
  ↓
agentLoop() → convertToLlm
  ↓
DefaultContextEngine.assemble()        ← Information：主动摘要 + 窗口选择/压缩
  ↓
ModelProvider.call()
  ↓
[tool_calls] → SecurityGuard → [HITL?] → ExecutionEnv → Tool
  ↓
HarnessLoopEvent + context.compact.* / context.layers.assembled 事件
  ↓
Session save：全量 messages + contextCompact 快照
  ↓
[任务结束后] → 主 agent 显著时 memory_store / memory.steward 补录·治理（Information→Memory；Cognition/Wisdom 另有下游子系统）
```

---

## 6. 接口清单

| 接口 | 文件 | 当前实现 |
|------|------|---------|
| `ModelProvider` | `core/interfaces/model-provider.ts` | OpenAI, Anthropic, ProviderPool |
| `ContextEngine` | `harness/context/types.ts` | DefaultContextEngine |
| `ErrorStrategy` | `core/interfaces/error-strategy.ts` | DefaultErrorStrategy |
| `SecurityGuard` | `core/interfaces/security-guard.ts` | DefaultSecurityGuard |
| `ToolCallRiskPolicy` | `core/interfaces/security-guard.ts` | DefaultToolCallRiskPolicy |
| `Observer` | `core/interfaces/observer.ts` | NoopObserver, LogObserver, ObserverBridge（**Telemetry**） |
| `ObserverHub` / Run Observatory | `harness/observer/*` | ObserverHub（**开发调试**；见 [observer-domain.md](./observer-domain.md)） |
| `SessionStore<T>` | `core/interfaces/session-store.ts` | JsonlSessionStore, InMemorySessionStore |
| `SessionHistoryPort` | `harness/session-history/` | DefaultSessionHistoryPort（`session_search` / `session_read`） |
| `SessionIndexBackend` | `integration/storage/session-index.ts` | SqliteSessionIndex（可重建投影，非权威） |
| `AsyncTaskStore` | `harness/orchestration/async-task-store.ts` | orchestration |
| `RunGuard` | `core/interfaces/run-guard.ts` | DefaultRunGuard |
| `AgentRegistry` | `harness/multi-agent/agent-registry-types.ts` | DefaultAgentRegistry |
| `McpClient` | `harness/plugin-ecosystem/mcp/types.ts` | SdkMcpClient |
| `EventSource` | `harness/agent-runtime/event-source-types.ts` | — |
| `MessageChannel` | `harness/multi-agent/message-channel-types.ts` | — |
| `MemoryStore` 等 | `harness/memory/types.ts` | InMemory / Sqlite |
| `KnowledgeStore` | `harness/context/knowledge/types.ts` | MemoryKnowledgeStore |
| `ContextLayer` / `ContextAssembler` | `harness/context/layer-types.ts` | DefaultContextAssembler + layers |
| `Planner` / `Reflector` | `harness/orchestration/cognitive-loop.ts` | Rule/LLM/Hybrid |

### 模型解析收口（ResolvedModel）

**约定**：每个 run / catalog 条目只解析一次模型能力，下游只读快照。

| 模块 | 职责 |
|------|------|
| `harness/model/resolver.ts` | `resolveModel` / `resolveCatalogEntry` — **唯一**绑定 + 能力策略 |
| `harness/model/run-scope.ts` | ALS 只传 `ResolvedModel` |
| `harness/model/types.ts` | `ResolvedModel.contextWindow?` / `known` / `source` |
| `core/types/model-info.ts` | `DEFAULT_CONTEXT_WINDOW`（**仅配置层历史常量**；引擎不作运行时预算回退） |

**contextWindow 语义（未知不猜测）**：

- **仅显式配置**算 known：`models.providers[].models[].contextWindow`、agent.model 写死的值、用户配置的 `defaults.contextWindow`
- Provider **不**自动合并 builtin 表；resolver **不**用 builtin/200k 作预算
- 未配置 → `contextWindow: undefined` / REST `null`，UI 显示「未知」

**未知时 vs 已配置**：

| 功能 | 窗口已配置 | 窗口未知 |
|------|------------|----------|
| LLM 调用 | ✓ | ✓ |
| 自动/proactive 压缩 | ✓ | **跳过** |
| assemble 按 token 截消息 | ✓ | **跳过** |
| 七层 system 窗口比例预算 | ✓ | 不按窗口硬裁；可选 `contextAssembler.systemBudgetTokens` |
| 手动/force **结构压缩** | ✓ | ✓（头尾+摘要；`POST /sessions/:id/compact`） |
| `compactTargetTokens` | 可选 | 显式目标，非猜测 |

**模型引用优先级**：

```text
消息级 RunConfig.model（仅显式 metadata.model）
  > session.metadata.model（会话覆盖）
  > undefined → Resolver 解析 agent 默认（isOverride=false）
```

**不要**把 agent 默认模型写入 `runConfigDefaults.model`（会吞掉会话覆盖）。

**数据流**：

```text
config → Gateway.setModelResolver → Runner（每 run 一次，且在 system assembler 之前）
  → ResolvedModel
    ├─ Agent.run({ resolvedModel }) → ALS
    ├─ convertToLlm / summarize：只读 snapshot.contextWindow（可 undefined）
    ├─ system assembler：resolved 后的 contextWindow
    └─ REST /models、sessions/:id/model、compact：同源 known/source
```

WebUI **不做**预算策略，只渲染 `known` / `source` / `contextWindow`。

`harness/reliability/model-binding.ts` 与 `run-model-context.ts` 为兼容 re-export，新代码请 import `harness/model`。

> 并发与 Run 作用域：同 Agent 多 Session 下，可变上下文只存在于 **RunScope**（见 [架构宪法](./north-star.md) I1）。`SessionAwareRunner` 不以共享 `Agent.context` 作为会话工作区。
>
> 工具效应（I5）：配置 `toolIsolation`（默认 `none`；多 Session 写文件建议 `session-subdir`）。
> Session 锁（E2/E7）：`SessionLease` 接口，v1 为 `InProcessSessionLock`；分布式必须替换实现。
> Session 数据（模型 2）：`primaryAgentId` + `preferredAgentId`（≠ primary）；compact 键 `(sessionId, agentId)`；ACL 角色目录见 `sessionAcl` 配置。
> Gateway 默认：注入 Session ACL + 共享 SessionLease（单 agent primary 路径兼容；无 grant 的多 agent guest 会被拒绝）。
> 遗留项见 [`docs/KNOWN-ISSUES.md`](./KNOWN-ISSUES.md)。

---

## 7. AgentBuilder — Fluent API

公开构建入口为 **`build(options?)`**（默认 `mode: 'full'`）。`buildAgent()` 已废弃，等价 `build({ mode: 'core' })`（仅 Agent 门面）。

```typescript
const { agent, harness, runner, runtime, events, contextHealth } = await new AgentBuilder()
  // 模型
  .model(myProvider)
  .provider('backup', backupProvider)
  .concurrency({ providerPool: { ... } })

  // 人格 / 技能 / 记忆（home 与 persona 解耦；agent.db 用 home）
  .agentHome('~/.octopi/agents/my-agent')
  .agentId('my-agent')
  .persona('./my-agent')
  .skillDirectory('./my-agent/skills')
  .memoryStore(myMemoryStore)   // 七层 MemoryLayer、memory_* 工具、steward 同实例
  .knowledgeStore(myKnowledgeStore)

  // 工具
  .tool(myTool)
  .mcp({ id: 'fs', transport: 'stdio', command: 'npx', args: [...] })

  // 上下文
  .contextEngine(myContextEngine)
  .summarize(mySummarizeFn)          // 可省略；默认自动挂主模型/mini
  .disableAutoSummarize()            // 可选：关掉自动 summarize

  // 安全（规则引擎；safety-guard 子系统由 subsystems/ 目录自动加载）
  .withRiskPolicy(myRiskPolicy)

  // 可靠性
  .runGuard()
  .reliability({ planningRetry: { maxAttempts: 3 } })

  // 可观测性
  .trace({ captureToolArgs: true })

  // 自主子系统
  .withSubsystem(mySubsystemSpec)
  .subsystemAllowlist('memory-steward')     // id / packageId / memory.steward.*
  .subsystemDenylist('safety-guard')        // 可选：禁止（优先于 allow）

  // Session
  .store(mySessionStore)

  // 构建：autoLoadSubsystems 默认 true（full）；与 memoryStore 无关
  .build({
    // mode: 'core',
    // autoLoadSubsystems: false,
    // subsystemAllowlist: [...],
    // subsystemDenylist: [...],
  });
```

**build() 缺省行为（full）**

| 项 | 行为 |
|----|------|
| 子系统发现 | `autoLoadSubsystems` 默认 `true`；allow/deny 支持 id / packageId / `memory.steward.*`（deny 优先） |
| `memoryStore` | `registerDependency('memoryStore')` + `sessionStore`/`constitution`；并用**同一实例**注册 `memory_store` / `memory_search` |
| Memory 旁路 | `memory.steward.backfill` / `memory.steward.govern`（**无** ETL `memoryExtraction` 句柄） |

Gateway serve 路径经 `builder.build()` 装配；治理类子系统 signal 仅走 event，不注入主会话。

---

## 8. 技术栈

- **语言：** TypeScript (ESM, Node.js >=24)
- **持久层 SQLite：** Node 内置 `node:sqlite`（`DatabaseSync`）；不要引入 `better-sqlite3`
- **构建：** tsc
- **测试：** Vitest (node --experimental-vm-modules)

---

## 9. 相关文档

- [架构宪法](./north-star.md) — 本体与长期不变量
- [已知问题](./KNOWN-ISSUES.md) — 对外问题摘要
- `docs/plugin-system.md` — Plugin 系统详细文档
- `docs/task-system.md` — SessionTask 设计基准
- `docs/domain-split.md` — run-guard / orchestration / AsyncTask 领域切分
- `docs/CONTRIBUTING.md` — 开发规范
- `docs/context-layer-contracts.md` — ContextLayer / Assembler 契约
- `docs/web-runtime-design.md` — Web Runtime 技术设计
- `docs/web-conversation-model-design.md` — WebUI 会话显示模型设计
