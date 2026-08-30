# Octopi 架构设计文档

> 版本：v0.8.0-dev | 日期：2026-08-29
>
> 本文档是 Octopi 框架的完整架构设计。
> 详细领域文档位于 `arch/` 目录。

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
│  LLM Provider · 存储 · 可观测性 · 协议 · Gateway · TUI · Web Runtime │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  Layer 2: Harness — 11 个自包含领域                           ││
│  │                                                              ││
│  │  ┌──────────────────────────────────────────────────────────┐││
│  │  │  Layer 1: Core — 机制原语 + 接口契约 + 核心类型           │││
│  │  │                                                          │││
│  │  │  ┌──────────────────────────────────────────────────────┐│││
│  │  │  │  Layer 0: Loop — 纯执行循环                          ││││
│  │  │  │  agentLoop · Agent · callModel · classifyError       ││││
│  │  │  └──────────────────────────────────────────────────────┘│││
│  │  └──────────────────────────────────────────────────────────┘││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### Layer 0: Loop — 纯执行循环

**职责**：调用 LLM → 解析响应 → 执行工具 → 循环。通过 async generator yield 事件流。

**特性**：零外部依赖。不依赖 EventBus、SecurityGuard、Budget。所有扩展通过 AgentLoopConfig 回调注入。

```
src/loop/
├── agent-loop.ts         # agentLoop() — 纯函数
├── agent.ts              # Agent — 状态管理 + 生命周期
├── call-model.ts         # callModel() — LLM 调用
├── error-classifier.ts   # classifyError() — 错误分类
├── types.ts              # AgentLoopConfig, AgentLoopEvent 等
└── index.ts
```

### Layer 1: Core — 机制原语 + 接口契约

**职责**：定义框架的所有契约（接口），提供基础设施原语（EventBus 等），定义核心类型。

**特性**：不依赖任何外层。不包含策略实现。

```
src/core/
├── interfaces/           # 全部接口契约
│   ├── model-provider.ts
│   ├── context-engine.ts
│   ├── security-guard.ts
│   ├── session-store.ts
│   ├── observer.ts
│   ├── error-strategy.ts
│   ├── task-supervisor.ts
│   ├── task-store.ts
│   ├── agent-registry.ts
│   ├── mcp-client.ts
│   └── index.ts
├── types/                # 核心类型（纯定义，不 re-export 外层）
│   ├── messages.ts       # Message, ContentBlock, ToolCall, ToolResult
│   ├── agent-definition.ts
│   ├── session.ts
│   ├── turn.ts
│   ├── tools.ts
│   ├── skills.ts
│   └── index.ts
├── primitives/           # 基础设施原语
│   ├── event-bus.ts      # EventBus — 一对多广播
│   ├── state-machine.ts  # StateMachine — 状态管理
│   ├── async-task.ts     # AsyncTask — 异步原语
│   ├── process-model.ts  # ProcessModel — 进程模型
│   └── index.ts
├── security-guard.ts     # severityToAction() + isValidSecurityGuard()
└── index.ts
```

### Layer 2: Harness — 11 个自包含领域

**职责**：实现 Core 接口的具体策略，提供框架的全部高级功能。

**特性**：每个领域有自己的类型、实现、入口文件。领域间通过 Core 接口通信。

（详见第 3 节）

### Layer 3: Integration — 外部适配

**职责**：对接外部系统（LLM 提供商、存储后端、可观测性、协议、UI）。

**特性**：只做适配转换，不做业务逻辑决策。

```
src/integration/
├── providers/            # LLM Provider（OpenAI, Anthropic）
├── storage/              # 存储后端（JSONL, SQLite, Memory）
├── observability/        # 可观测性（Trace, Metrics, Exporters）
├── gateway/              # 网关
├── protocols/            # 协议适配（HTTP）
├── tui/                  # 终端 UI
├── web/                  # Web Runtime / WebUI 骨架
└── index.ts
```

---

## 3. Harness 领域

### 3.1 Agent Building — Agent 构建

**职责**：组装 Agent 运行时，加载人格配置，桥接配置文件。

```
harness/agent-building/
├── builder.ts            # AgentBuilder — Fluent API
├── persona.ts            # 人格加载（AGENTS.md, SOUL.md, IDENTITY.md）
├── config-bridge.ts      # 配置文件 → 新架构桥接
└── index.ts
```

### 3.2 Context Management — 上下文管理

**职责**：消息选择、压缩、Token 估算、智能路由。以及七层智能组装。

```
harness/context/
├── default-context-engine.ts   # 统一入口
├── smart-router.ts             # 智能路由决策
├── message-selector.ts         # 四区域消息选择
├── hybrid-compressor.ts        # 混合压缩器
├── llm-summarizer.ts           # LLM 摘要压缩
├── truncate-compressor.ts      # 截断兜底
├── budget-allocator.ts         # Token 预算分配
├── token-estimator.ts          # 启发式 Token 估算
├── context-intelligence.ts     # [新增] 七层智能组装
└── index.ts
```

**七层智能组装**（详见第 4 节）

### 3.3 Security — 安全

**职责**：工具调用风险评估、Shell 命令解析、安全降级、安全智能体。

```
harness/security/
├── default-security-guard.ts   # DefaultSecurityGuard — 五层防护实现
├── default-risk-policy.ts      # DefaultToolCallRiskPolicy — 规则引擎
├── risk-evaluator.ts           # 操作+目标组合风险评估
├── shell-parser.ts             # Shell 命令解析器（4 层）
├── degradation.ts              # 6 种降级策略
├── safety-agent-spec.ts        # 安全智能体规格
├── capability-enforcer.ts      # 信任分级
├── policy.ts                   # 安全策略
└── index.ts
```

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

**职责**：记忆存储/检索、认知图谱、智慧生成。

```
harness/memory/
├── store.ts              # 记忆存储
├── retriever.ts          # 记忆检索
├── lifecycle.ts          # 记忆生命周期（衰减、遗忘）
├── project-memory.ts     # 项目记忆（CLAUDE.md）
├── wisdom.ts             # [P1] 智慧生成
├── cognition.ts          # [P1] 认知图谱
├── types.ts
└── index.ts
```

### 3.7 Reliability — 可靠性

**职责**：Agent 循环的可靠性包装 — 重试、检测、监督、断路。

```
harness/reliability/
├── run-agent.ts          # runAgentWithReliability()
├── circuit-breaker.ts    # CircuitBreaker — 断路器
├── provider-wrapper.ts   # wrapProviderWithCircuitBreaker()
├── budget.ts             # IterationBudget
└── index.ts
```

### 3.8 Plugin Ecosystem — 插件生态

**职责**：Plugin 系统、Skill 管理、工具注册、MCP 集成、斜杠命令。

```
harness/plugin-ecosystem/
├── plugins/              # PluginManager, HookRegistry, Loader
├── tools/                # ToolRegistry, BuiltinTools, Streaming
├── skills/               # SkillManager（两阶段加载）
├── mcp/                  # McpManager, Bridge, Discovery
├── commands/             # 斜杠命令系统
└── index.ts
```

### 3.9 Distributed Agents — 分布式智能体

**职责**：多 Agent 协作、分布式运行时、Agent 注册与发现。

```
harness/distributed-agents/
├── runtime.ts            # AgentRuntime — 分布式核心运行时
├── spec.ts               # DistributedAgentSpec
├── trigger.ts            # TriggerEngine
├── input-policy.ts       # 输入策略
├── output-policy.ts      # 输出策略
├── execution.ts          # 三种执行模式
├── audit-trail.ts        # 审计追踪
├── registry.ts           # DefaultAgentRegistry
├── swarm.ts              # AgentSwarm — 多 Agent 编排
├── process.ts            # AgentProcess
├── types.ts
└── index.ts
```

### 3.10 Task System — 任务与编排

**职责**：任务管理、规划、调度、工作流、策略路由、输出质量。

```
harness/task-system/
├── tasks/                # TaskManager, TaskTracker, TaskDecisionProvider
├── planner/              # RulePlanner, LLMPlanner, HybridPlanner
├── scheduler/            # TaskScheduler
├── workflow/             # WorkflowEngine — DAG 编排
├── strategy/             # 任务分类 + 策略路由
├── quality/              # OutputQualityGate
├── reflector/            # LLMReflector
├── knowledge/            # KnowledgeStore, KnowledgeStage
├── supervisor/           # AgentSupervisor, TaskSupervisor
├── tool-loop-detection.ts
└── index.ts
```

### 3.11 Concurrency — 并发控制

**职责**：多 key 分发、会话粘滞、限流。

```
harness/concurrency/
├── provider-pool.ts      # ProviderPool — 多 Key 负载均衡
├── rate-limiter.ts       # RateLimiter — 令牌桶限流
├── session-gate.ts       # SessionGate — 并发门控
├── tool-validator.ts     # ToolValidator — 工具结果验证
└── index.ts
```

---

## 4. Context Intelligence — 七层智能模型

### 核心理念

要让 agent 变得聪明，核心在于给会话提供更有效的 context。
七层模型是一个**信息分馏系统**：从原始信息中逐层提炼，产出越来越高层级的理解。

```
Information（原始信息）→ Memory（记忆）→ Cognition（认知）→ Wisdom（智慧）

Persona（人格）= agent 的 DNA
Knowledge（知识）= 外部参考资料
Skill（技能）= 工作流定义
```

### 七层定义

| 层 | 本质 | 构建归属 | 组装位置 |
|---|---|---|---|
| **Wisdom** | 思维范式（第一性原理、反思、系统思维） | `memory` 领域生成 | system prompt 最前 |
| **Persona** | agent 的 DNA（身份、人格、操作指令） | `agent-building` 领域加载 | system prompt |
| **Skill** | 工作流定义（触发条件 → 执行指导） | `plugin-ecosystem` 领域管理 | 条件加载 |
| **Knowledge** | 外部参考资料（项目文档、API 文档） | `task-system/knowledge` | 按需检索 |
| **Cognition** | 概念关系网络 | `memory` 领域构建 | 按话题遍历 |
| **Memory** | 从交互中提取的有价值内容 | `memory` 领域管理 | 按相关性召回 |
| **Information** | 原始交互记录 | `integration/storage` 持久化 | context window 管理 |

### 组装流程

```
1. Wisdom     ← 最靠前，权重最高
2. Persona    ← 身份定义、人格特质
3. Skill      ← 当前任务匹配的技能（条件加载）
4. Knowledge  ← 当前话题检索到的外部知识
5. Cognition  ← 当前话题相关的概念网络
6. Memory     ← 相关记忆召回
7. Information ← 历史消息（窗口管理 + 压缩）
```

### memory/ 领域的三层抽象

```
Information → Memory      提炼：什么值得记住
Memory → Cognition        结构化：概念之间的关系
Memory → Wisdom           升华：思维模式
```

---

## 5. 核心数据流

```
用户消息
  ↓
SessionAwareRunner.handle()           ← Session 生命周期管理
  ↓
TaskDecisionProvider.decide()         ← 可选，判断任务状态
  ↓
runAgentWithReliability()             ← 可靠性包装
  ↓
Context Intelligence 组装              ← 七层智能组装 system prompt
  ↓
agentLoop()                           ← 纯执行循环
  ↓
ContextEngine.assemble()              ← 消息窗口管理 + 压缩
  ↓
ModelProvider.call()                  ← LLM 推理
  ↓
[tool_calls] → SecurityGuard → [HITL?] → ExecutionEnv → Tool
  ↓
[回到 ModelProvider.call()]
  ↓
AgentLoopEvent 流输出
  ↓
[任务结束后] → Memory 提取（信息→记忆→认知→智慧）
```

---

## 6. 接口清单

| 接口 | 文件 | 当前实现 |
|------|------|---------|
| `ModelProvider` | `core/interfaces/model-provider.ts` | OpenAI, Anthropic, ProviderPool |
| `ContextEngine` | `core/interfaces/context-engine.ts` | DefaultContextEngine |
| `ErrorStrategy` | `core/interfaces/error-strategy.ts` | DefaultErrorStrategy |
| `SecurityGuard` | `core/interfaces/security-guard.ts` | DefaultSecurityGuard |
| `ToolCallRiskPolicy` | `core/interfaces/security-guard.ts` | DefaultToolCallRiskPolicy |
| `Observer` | `core/interfaces/observer.ts` | NoopObserver, LogObserver, ObserverBridge |
| `SessionStore` | `core/interfaces/session-store.ts` | JsonlSessionStore, InMemorySessionStore, SqliteSessionStore |
| `TaskStore` | `core/interfaces/task-store.ts` | （内嵌在 TaskManager 中） |
| `TaskSupervisor` | `core/interfaces/task-supervisor.ts` | DefaultTaskSupervisor |
| `AgentRegistry` | `core/interfaces/agent-registry.ts` | DefaultAgentRegistry |
| `McpClient` | `core/interfaces/mcp-client.ts` | SdkMcpClient |
| `EventSource` | `core/interfaces/event-source.ts` | — |
| `MessageChannel` | `core/interfaces/message-channel.ts` | — |

---

## 7. AgentBuilder — Fluent API

```typescript
const { agent, harness, runner } = await new AgentBuilder()
  // 模型
  .model(myProvider)
  .provider('backup', backupProvider)
  .concurrency({ providerPool: { ... } })

  // 人格
  .persona('./my-agent')

  // 工具
  .tool(myTool)
  .mcp({ id: 'fs', transport: 'stdio', command: 'npx', args: [...] })

  // 上下文
  .contextEngine(myContextEngine)
  .summarize(mySummarizeFn)

  // 安全
  .withRiskPolicy(myRiskPolicy)
  .withSafetyGuard({ cwd: '/data' })

  // 可靠性
  .taskSupervisor()
  .reliability({ planningRetry: { maxAttempts: 3 } })

  // 可观测性
  .trace({ captureToolArgs: true })

  // 分布式智能体
  .withDistributedAgent(myAgentSpec)

  // Session
  .store(mySessionStore)

  // 构建
  .build();
```

---

## 8. 技术栈

- **语言：** TypeScript (ESM, Node.js >=20)
- **构建：** tsc
- **测试：** Vitest (node --experimental-vm-modules)

---

## 9. 相关文档

- `arch/overview.md` — 架构全景（DDD 领域组织）
- `arch/refactoring-plan-4layer.md` — 4 层重构方案
- `arch/dependency-map.md` — 模块依赖图
- `arch/layer-rules.md` — 分层规则
- `arch/invariants.md` — 架构不变量
- `docs/plugin-system.md` — Plugin 系统详细文档
- `docs/task-system.md` — Task 系统详细文档
- `docs/CONTRIBUTING.md` — 开发规范
- `docs/web-runtime-design.md` — Web Runtime 技术设计
- `docs/web-conversation-model-design.md` — WebUI 会话显示模型设计
