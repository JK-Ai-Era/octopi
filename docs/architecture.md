# Octopi 架构设计文档

> 版本：v2.4 | 日期：2026-06-08

本文档是 Octopi 框架的完整架构设计，记录了设计决策的背景、权衡和原则。

---

## 1. 设计哲学

### 1.1 Agent 是一个运行时，不是一个类

传统框架把 Agent 做成一个 class——继承它，override 几个方法，你就有了一个 Agent。但真实的 Agent 需要的是一个**完整的运行时环境**：

- 一个消息循环引擎
- 一套上下文组装策略
- 一个模型调用能力
- 一组工具执行能力
- 一个状态持久化后端
- 一套人格描述文件
- 一组生命周期插件
- 一套安全策略

这些组件的组合方式是无穷的。框架不应该预设组合方式，而应该提供**清晰的接口**和**可替换的组件**。

### 1.2 三层分离：引擎 / 装具 / 集成

```
Core（引擎）     → 最小循环，纯接口，零实现依赖，安全内置
Harness（装具）  → 人格、插件、技能、策略、Session 管理
Integration（集成）→ 协议、存储、沙盒、可观测性
```

**依赖方向：外 → 内。内层不知道外层的存在。**

- Core 可以独立存在，不需要 Harness 和 Integration
- Harness 可以独立测试，只需要 mock Core 的接口
- Integration 可以自由替换，不影响 Core 和 Harness

### 1.3 接口即契约

框架的价值不在于提供了多少默认实现，而在于定义了多少清晰的接口。

### 1.4 安全是内置的，不是附加的

安全不是"加一个安全模块"，而是每一层都有安全职责。Core 层的安全检查（SecurityGuard、IterationBudget）不可禁用、不可绕过。

---

## 2. 源码结构

```
src/
├── core/                          # Layer 1: 纯引擎
│   ├── engine.ts                  # AgentEngine — 无状态循环引擎
│   ├── event-bus.ts               # EventBus — 内置事件总线
│   ├── security-guard.ts          # SecurityGuard — 内置安全守卫
│   ├── budget.ts                  # IterationBudget — 资源约束
│   ├── types.ts                   # 核心类型定义
│   ├── async-task.ts              # AsyncTask — 异步任务原语
│   ├── process-model.ts           # ProcessModel — Agent 进程模型
│   ├── interfaces/                # 接口契约
│   │   ├── model-provider.ts      # ModelProvider
│   │   ├── tool-executor.ts       # ToolExecutor
│   │   ├── context-pipeline.ts    # ContextPipeline
│   │   ├── error-strategy.ts      # ErrorStrategy
│   │   ├── observer.ts            # Observer
│   │   ├── session-store.ts       # SessionStore
│   │   ├── event-source.ts        # EventSource — 外部事件源协议
│   │   ├── task-store.ts          # TaskStore — 任务持久化协议
│   │   ├── message-channel.ts     # MessageChannel — 进程间通信协议
│   │   └── index.ts
│   └── index.ts
│
├── harness/                       # Layer 2: 装具层
│   ├── builder.ts                 # AgentBuilder — Fluent API 组装器
│   ├── runner.ts                  # SessionAwareRunner — Session 管理
│   ├── persona/
│   │   └── loader.ts              # PersonaLoader — 文件式人格
│   ├── context/
│   │   ├── pipeline.ts            # DefaultContextPipeline
│   │   └── stages/
│   │       └── task-stage.ts      # TaskStage — 任务上下文注入
│   ├── tasks/
│   │   ├── manager.ts             # TaskManager — LLM 决策器
│   │   ├── tracker.ts             # TaskTracker — 状态管理
│   │   ├── shared.ts              # 共享函数
│   │   ├── types.ts               # Task 类型
│   │   └── index.ts
│   ├── quality/
│   │   ├── gate.ts                # OutputQualityGate
│   │   ├── classifier.ts          # OutputErrorClassifier
│   │   ├── types.ts               # Quality 类型
│   │   └── index.ts
│   ├── security/
│   │   ├── capability-enforcer.ts # CapabilityEnforcer
│   │   ├── policy.ts              # SecurityPresets
│   │   └── index.ts
│   ├── supervisor/                # AgentSupervisor — 持续运行的 Agent 核心
│   │   ├── supervisor.ts          # AgentSupervisor — 认知循环
│   │   ├── event-collector.ts     # EventCollector — 事件收集器
│   │   ├── types.ts               # Planner/Reflector 接口 + 类型
│   │   └── index.ts
│   ├── planner/                   # Planner — 规划器
│   │   ├── rule-planner.ts        # RulePlanner — 规则驱动
│   │   ├── llm-planner.ts         # LLMPlanner — LLM 驱动
│   │   ├── hybrid-planner.ts      # HybridPlanner — 混合
│   │   └── index.ts
│   ├── scheduler/                 # TaskScheduler — 任务调度
│   │   ├── task-scheduler.ts      # once/interval/cron/at
│   │   └── index.ts
│   ├── knowledge/                 # KnowledgeStore — 知识存储
│   │   ├── memory-store.ts        # MemoryKnowledgeStore — 内存存储
│   │   ├── stage.ts               # KnowledgeStage — 上下文注入
│   │   ├── types.ts               # 知识类型
│   │   └── index.ts
│   ├── reflector/                 # Reflector — 反思器
│   │   ├── llm-reflector.ts       # LLMReflector — LLM 驱动
│   │   └── index.ts
│   ├── strategy/                  # StrategyRouter — 策略路由
│   │   ├── classifier.ts          # RuleTaskClassifier — 任务分类
│   │   ├── router.ts              # DefaultStrategyRouter — 路由
│   │   ├── types.ts               # 策略类型
│   │   └── index.ts
│   ├── resources/                 # ResourceManager — 资源管理
│   │   ├── manager.ts             # token/成本/速率
│   │   └── index.ts
│   └── index.ts
│
├── integration/                   # Layer 3: 集成层
│   ├── storage/
│   │   ├── jsonl.ts               # JsonlSessionStore
│   │   └── memory.ts              # InMemorySessionStore
│   ├── observability/
│   │   ├── noop-observer.ts       # NoopObserver
│   │   ├── log-observer.ts        # LogObserver
│   │   └── index.ts
│   └── index.ts
│
├── observability/                 # 可观测性模块
│   ├── trace-events.ts            # 事件类型定义 + 级别映射
│   ├── trace-logger.ts            # 核心日志器（分级过滤）
│   ├── trace-collector.ts         # 引擎事件流自动收集器
│   ├── exporters.ts               # Exporter SPI（Console/JsonlFile/Webhook）
│   ├── metrics.ts                 # MetricsAggregator（指标聚合）
│   └── index.ts
│
├── testing/                       # 测试工具模块
│   ├── recording-provider.ts      # 录制真实 LLM 交互
│   ├── replay-provider.ts         # 回放录制数据（确定性测试）
│   ├── chaos-provider.ts          # 故障注入 Provider
│   ├── scenario-runner.ts         # E2E 场景运行器 + 断言库
│   ├── scenario-composer.ts       # 场景组合、扩展、参数化
│   └── index.ts
│
├── plugins/                       # Plugin 系统（跨层，SDK 形式）
│   ├── manager.ts                 # PluginManager
│   ├── loader.ts                  # PluginLoader
│   ├── api.ts                     # PluginApi
│   ├── hooks.ts                   # Hook 执行引擎
│   ├── entry.ts                   # definePluginEntry
│   ├── manifest.ts                # Manifest 验证
│   ├── capability.ts              # CapabilityRegistry
│   └── index.ts
│
├── providers/                     # LLM Provider 实现
│   ├── openai.ts                  # OpenAIProvider
│   ├── anthropic.ts               # AnthropicProvider
│   ├── router.ts                  # LLMRouter
│   └── index.ts
│
├── skills/                        # Skill 系统
│   └── manager.ts                 # DefaultSkillManager
│
├── tools/                         # 工具系统
│   ├── registry.ts                # ToolRegistry
│   ├── builtin.ts                 # 内置工具
│   └── index.ts
│
├── gateway/                       # Gateway
│   ├── gateway.ts
│   └── index.ts
│
├── protocol/                      # 协议适配
│   └── http.ts                    # HTTP 适配器
│
├── config.ts                      # 配置加载
├── init.ts                        # 系统初始化（目录脚手架）
├── cli.ts                         # CLI 入口（init/serve/chat/health）
└── index.ts                       # 统一导出
```

---

## 3. Core 层详解

### 3.1 核心原语

Core 层提供两个底层原语，为 Agent 的高级能力打基础。

#### AsyncTask — 异步任务原语

Agent 的异步能力的最小单元。不是任务调度系统，是 Promise 的内核级扩展。

```
普通 Promise:     创建 → 执行 → resolve/reject
                  （无法取消，无法查询状态，无法超时）

AsyncTask:        创建 → pending → running → completed
                                        → failed
                                        → cancelled
                  （可取消，可查询状态，可超时，可重试，可持久化）
```

**状态机：**
```
                  ┌─────────┐
                  │ pending  │ ← 创建后
                  └────┬────┘
                       │ run()
                       ▼
                  ┌─────────┐
            ┌─────│ running  │─────┐
            │     └────┬────┘     │
            │          │          │
     cancel()    成功完成     失败/超时
            │          │          │
            ▼          ▼          ▼
       ┌─────────┐ ┌──────────┐ ┌─────────┐
       │cancelled│ │completed │ │ failed  │
       └─────────┘ └──────────┘ └─────────┘
```

**六个关键机制：**

| 机制 | 说明 |
|------|------|
| 取消（Cancel） | 通过 AbortSignal 传递取消信号，子操作同步取消 |
| 超时（Timeout） | 自动计时，超时后 fail + abort，防止任务永远卡住 |
| 重试（Retry） | 失败后自动重试，AbortController 重置，每次重试是干净的 |
| 事件（Events） | 所有状态变化通过 EventBus 发射，可监控、审计 |
| 持久化（Persistence） | 通过 TaskStore 接口持久化状态，进程重启后可恢复 |
| AbortSignal 传递 | signal 可传给子操作（fetch、writeFile 等），取消时级联清理 |

```typescript
// 基本用法
const task = new AsyncTask<string>({ type: 'llm-call', timeoutMs: 30000 });
const result = await task.run(async (input, signal) => {
  return await llm.complete(messages, { signal });
});

// 便捷方法：发射后不管
const task = spawnTask({ type: 'background-scan' }, async () => scan());
const results = await task.wait(30000); // 稍后获取结果
```

#### ProcessModel — Agent 进程模型

Agent 进程生命周期的最小抽象。类比 Erlang OTP 的 process：有状态、可通信、可监控。

**状态机：**
```
              ┌──────┐
              │ born  │ ← new ProcessModel()
              └──┬───┘
                 │ run()
                 ▼
              ┌──────────┐
     ┌───────│ running   │───────┐
     │        └────┬─────┘       │
     │             │             │
  kill()      sleep(ms)      正常退出
     │             │             │
     ▼             ▼             ▼
  ┌──────┐   ┌──────────┐   ┌──────┐
  │ dead  │   │ sleeping  │   │ dead  │
  └──────┘   └────┬─────┘   └──────┘
                  │ 定时到/kill
                  ▼
              ┌──────────┐
              │ running   │
              └──────────┘
```

**六个关键机制：**

| 机制 | 说明 |
|------|------|
| 进程体（Body） | 接收 ctx 上下文，可做任何事：循环、状态机、事件驱动 |
| 父子进程（Spawn） | 子进程异步运行，继承 agentId，父退出时子自动 kill |
| 消息传递（Send/Receive） | 进程树内直接投递（零开销），跨进程通过 MessageChannel |
| 休眠（Sleep） | 进程状态变化，不消耗 CPU，可被 kill 唤醒 |
| 通信协议（MessageChannel） | 接口抽象，可选 WebSocket、消息队列等实现 |
| 事件可观测 | 所有状态变化通过 EventBus 发射 |

```typescript
// 创建 Agent 进程
const agent = new ProcessModel({ name: 'my-agent' }, events);
await agent.run(async (ctx) => {
  while (true) {
    const msg = await ctx.receive('user-message', 60000);
    if (msg) {
      // spawn 子进程处理复杂任务
      ctx.spawn(async (childCtx) => {
        const result = await doComplexWork();
        await childCtx.send(ctx.id, 'result', result);
      });
    }
  }
});
```

### 3.2 AgentEngine — 无状态循环引擎

```typescript
class AgentEngine {
  // 扩展回调槽 — Harness 层注入
  onMessage?: (msg: Message) => Message | null;
  beforeAssemble?: (input: PipelineInput) => PipelineInput;
  beforeModelCall?: (req: LLMRequest) => LLMRequest | null;
  afterModelCall?: (resp: LLMResponse) => LLMResponse;
  beforeToolExec?: (call: ToolCall) => ToolCall | null;
  afterToolExec?: (result: ToolResult) => ToolResult;
  afterTurn?: (turn: Turn) => void;

  constructor(deps: AgentEngineDeps);

  // 运行 Agent 循环
  async *run(messages: Message[], config: RunConfig): AsyncGenerator<AgentEvent>;
}
```

**循环流程：**

```
输入消息
  │
  ▼
┌─ IterationBudget 检查 ─────────────────────────────┐
│  │                                                   │
│  ▼                                                   │
│  onMessage 回调（可拦截/修改）                         │
│  │                                                   │
│  ▼                                                   │
│  beforeAssemble 回调（可注入额外上下文）                │
│  │                                                   │
│  ▼                                                   │
│  ContextPipeline.process()                           │
│  │                                                   │
│  ▼                                                   │
│  SecurityGuard.checkUserInput()                      │
│  │                                                   │
│  ▼                                                   │
│  beforeModelCall 回调（可覆盖模型）                    │
│  │                                                   │
│  ▼                                                   │
│  callModel() — 流式调用                              │
│  │  ├─ yield llm_stream_delta（实时内容流）            │
│  │  └─ yield tool_call（工具调用元数据）               │
│  │                                                   │
│  ▼                                                   │
│  SecurityGuard.checkModelOutput()                    │
│  │                                                   │
│  ▼                                                   │
│  afterModelCall 回调                                 │
│  │                                                   │
│  ├─ 有 tool_calls? ────────────────────────┐         │
│  │                                         ▼         │
│  │                    SecurityGuard.checkToolOutput() │
│  │                    beforeToolExec 回调              │
│  │                    ToolExecutor.execute()          │
│  │                    afterToolExec 回调              │
│  │                    继续循环 ◄──────────────┘       │
│  │                                                   │
│  ▼                                                   │
│  纯文本 → 完成                                        │
│  │                                                   │
│  ▼                                                   │
│  afterTurn 回调                                      │
└──────────────────────────────────────────────────────┘
```

**流式事件：**
- `llm_stream_delta` — 模型输出的每个内容块，用于实时显示
- `tool_call` — 工具调用元数据（支持多工具并行，每个有独立 index）
- `tool.exec.start` / `tool.exec.end` — 工具执行生命周期

**为什么 Core 是无状态的？**
- **可测试性** — 不需要 mock SessionStore 就能测试循环
- **可复用性** — 同一个引擎可以有 Session 或无 Session
- **关注点分离** — "怎么循环"和"怎么存储"是两个独立问题

### 3.3 回调槽而非 LifecycleHooks 接口

Core 只暴露**回调槽**——AgentEngine 上的可选函数属性。Harness 层可以把任何东西注入到这些槽里。

```typescript
// Core：只暴露槽位
class AgentEngine {
  onMessage?: (msg: Message) => Message | null;
  beforeModelCall?: (req: LLMRequest) => LLMRequest | null;
  // ...
}

// Harness：注入实现
engine.onMessage = (msg) => pluginManager.runHookChain('onMessage', msg);
```

**好处：** Core 不预设扩展机制，Harness 可以用任何方式实现扩展。

### 3.4 EventBus 是内置的

EventBus 不是可选插件，是 Core 的一部分。原因：

1. **可观测性是生产级必需** — 没有事件系统就无法监控、调试、审计
2. **事件是解耦的通信方式** — Harness 和 Integration 通过订阅事件获知 Core 内部状态
3. **零成本** — NoopEventBus 的开销为零

```typescript
// 内置事件类型
ENGINE_START / ENGINE_END           — 引擎生命周期
ITERATION_START / ITERATION_END     — 循环迭代
MODEL_CALL_START / MODEL_CALL_END   — 模型调用
TOOL_EXEC_START / TOOL_EXEC_END     — 工具执行
INJECTION_DETECTED                  — 安全事件
BUDGET_EXCEEDED                     — 资源事件
```

### 3.5 SecurityGuard 是内置的

Prompt Injection 是 Agent 框架最严重的安全威胁。安全检查不可禁用。

**Core 层的安全检查：**
- `checkUserInput()` — 消息到达时
- `checkToolOutput()` — 每次工具执行后
- `checkModelOutput()` — 每次模型调用后

**不可禁用，不可绕过。** 但检查的**策略**（灵敏度、模式）由 Harness 层配置。

### 3.6 ContextPipeline 是管道模型

上下文组装采用管道模型，每个阶段是一个独立的 `ContextStage`：

```typescript
interface ContextStage {
  readonly name: string;
  process(ctx: StageContext): Promise<StageContext>;
}
```

**默认管道顺序：**
```
PersonaStage → SkillStage → TaskStage → HistoryStage → FilterStage
```

阶段可以独立替换、组合、测试。

---

## 4. Harness 层详解

### 4.1 AgentBuilder — Fluent API

```typescript
const { engine, runner } = await new AgentBuilder()
  .model(new OpenAIProvider({ apiKey: '...' }))
  .persona('./my-agent')          // 从目录加载 persona
  .systemPrompt('You are ...')    // 或直接设置 systemPrompt（优先）
  .store(new JsonlSessionStore('./data'))
  .plugin(myPlugin)
  .budget({ maxIterations: 15, maxTokens: 100000 })
  .securityPolicy(SecurityPresets.production)
  .build();
```

AgentBuilder 组装 Core + Harness 组件，返回 `{ engine, runner }`。

**systemPrompt 优先级：**
1. `builder.systemPrompt()` — 直接设置（最高优先级）
2. `builder.persona()` — 从目录加载
3. 有工具但无 systemPrompt — 自动生成工具说明（最低优先级）

### 4.2 SessionAwareRunner

在 AgentEngine 之上管理 Session 生命周期：

```typescript
class SessionAwareRunner {
  async *handle(sessionId: string, input: Message): AsyncGenerator<AgentEvent>;
}
```

**职责：**
- 消息持久化（通过 SessionStore）
- Session 锁（Promise FIFO 队列，同一 session 同时只有一个运行，无 polling 开销）
- Daily Reset（跨天自动清空上下文）
- Idle Reset（空闲超时自动清空）

### 4.3 文件式 Persona

```
my-agent/
├── AGENTS.md    ← 操作指令（最高优先级）
├── SOUL.md      ← 人格特质、语调
├── IDENTITY.md  ← 身份定义
├── USER.md      ← 用户上下文
└── TOOLS.md     ← 工具使用说明
```

Core 层不知道 Persona 的存在。Persona 只是生成 `systemPrompt` 字符串的一种方式。

### 4.4 Task 系统

LLM 驱动的任务追踪。通过 ContextPipeline 的 TaskStage 注入：

```
用户消息到达
    │
    ▼
TaskStage.process()
    │
    ├─ TaskManager.decide() — LLM 判断消息与任务的关系
    ├─ TaskTracker 更新状态（create/interrupt/resume/complete）
    └─ 注入 taskContext 到 system prompt
    │
    ▼
主 Agent 看到上下文，自然地决定行为
```

**任务状态机：**
```
in_progress ←→ interrupted → completed
                            → cancelled
```

### 4.5 Plugin 如何挂载到 Core

Plugin 不直接访问 AgentEngine。PluginManager 负责将多个 Plugin 的 hooks 组合成回调函数，注入到 AgentEngine 的回调槽。

### 4.6 AgentSupervisor — 持续运行的 Agent 核心

让 Agent 从“单次对话”进化为“持续运行的进程”。基于 Core ProcessModel 实现，提供认知循环：

```
感知 → 思考 → 执行 → 反思 → (循环)
```

```
AgentSupervisor
├── EventCollector     — 聚合所有事件源
├── Planner            — 决定做什么
├── AgentEngine        — 单次推理执行
├── Reflector          — 评估执行质量（可选）
└── ProcessModel       — 进程生命周期
```

```typescript
const supervisor = new AgentSupervisor({
  agentId: 'my-agent',
  planner: new HybridPlanner({ llm: { model: provider } }),
  reflector: new LLMReflector({ model: provider }),
  idleTimeoutMs: 30000,
}, eventBus);

supervisor.injectMessage(userMessage);  // 注入事件
await supervisor.start(engine);          // 开始持续运行
```

### 4.7 Planner — 规划器

决定 Agent 在给定事件和状态下应该做什么。三种实现：

| 规划器 | 适用场景 | 是否需要 LLM |
|--------|----------|-------------|
| `RulePlanner` | 常见事件（用户消息、安全事件） | 否 |
| `LLMPlanner` | 复杂场景（意图理解、目标分解） | 是 |
| `HybridPlanner` | 通用场景（规则优先，LLM 兜底） | 按需 |

```typescript
// 规则优先，LLM fallback
const planner = new HybridPlanner({
  llm: { model: provider },
  rules: [USER_MESSAGE_RULE, SECURITY_EVENT_RULE],
});
```

### 4.8 TaskScheduler — 任务调度

支持定时任务、延迟任务、循环任务。纯 JS 实现，不依赖外部 cron 库。

```typescript
const scheduler = new TaskScheduler({}, eventBus);
scheduler.start();

scheduler.scheduleOnce('cleanup', 60000, () => cleanup());
scheduler.scheduleInterval('heartbeat', 300000, () => heartbeat());
scheduler.scheduleCron('daily-report', '0 9 * * *', () => generateReport());
```

### 4.9 KnowledgeStore — 知识存储

Agent 积累的知识：事实、模式、经验教训、偏好。通过 KnowledgeStage 注入上下文。

```typescript
const store = new MemoryKnowledgeStore();
await store.store({ type: 'lesson', content: 'API 超时时应重试 3 次', confidence: 0.9, tags: ['api', 'retry'] });

// 检索相关知识
const entries = await store.retrieve('API timeout');

// 作为上下文注入
const stage = new KnowledgeStage({ store });
const ctx = await stage.process({ messages, systemPrompt, tools });
```

### 4.10 Reflector — 反思器

评估执行质量，识别模式，自动存储经验教训。

```typescript
const reflector = new LLMReflector({ model: provider, knowledgeStore: store });

const assessment = await reflector.assess(executionRecord);
// { quality: 0.8, success: true, suggestions: ['可以优化响应速度'] }

const patterns = await reflector.detectPatterns(recentHistory);
// [{ type: 'recurring_error', description: 'API 频繁超时', confidence: 0.9 }]
// 高置信度模式自动存入 KnowledgeStore
```

### 4.11 StrategyRouter — 策略路由

根据任务类型选择最合适的推理策略。

| 策略 | 适用场景 |
|------|----------|
| `direct` | 简单问题，直接回答 |
| `chain_of_thought` | 需要推理的问题 |
| `plan_and_execute` | 复杂任务，先规划再执行 |
| `tool_use` | 需要外部信息或操作 |
| `reflect` | 需要高质量输出 |
| `multi_agent` | 超复杂任务，多 Agent 协作 |

### 4.12 ResourceManager — 资源管理

统一管理 token 预算、成本追踪、速率限制。

```typescript
const rm = new ResourceManager({
  tokenBudget: { perCall: 100000, perMinute: 500000, total: 10000000 },
  pricing: { 'gpt-4': { inputPer1M: 30, outputPer1M: 60 } },
  rateLimit: { requestsPerMinute: 60, maxConcurrent: 5 },
});

// 检查预算
const check = rm.checkTokenBudget(50000);
if (!check.allowed) console.warn(check.reason);

// 记录使用
rm.recordTokenUsage(1000, 500, 'gpt-4');

// 查看统计
console.log(rm.stats());
// { token: { total: 1500 }, cost: { total: 0.06 }, rate: { concurrent: 0 } }
```

### 4.13 SmartStage — 嵌入 LLM 决策点的上下文阶段

上下文管道中的每个阶段默认是确定性逻辑。SmartStage 打破了这个限制——它在管道中嵌入独立的 LLM 调用，让上下文组装可以“思考”。

内置工厂：
- `createSmartSummarizer` — 用 LLM 决定如何压缩长对话历史
- `createSmartRelevanceFilter` — 用 LLM 评估哪些消息与当前任务最相关

设计约束：
- LLM 调用有超时（默认 5 秒），失败时 fallback 到原始上下文
- 结果可缓存，避免重复调用
- 所有 LLM 调用通过 EventBus 事件可追踪

```typescript
import { SmartStage, createSmartSummarizer } from 'octopi/harness';

// 智能摘要
const summarizer = createSmartSummarizer(modelProvider);
pipeline.addStage(summarizer);

// 自定义 SmartStage
const smartFilter = new SmartStage({
  name: 'smart-filter',
  model: modelProvider,
  systemPrompt: '你是上下文过滤专家...',
  buildPrompt: (ctx) => `分析 ${ctx.messages.length} 条消息...`,
  applyDecision: async (response, ctx) => {
    // 解析 LLM 响应，变换上下文
    return { ...ctx, messages: filteredMessages };
  },
});
```

### 4.14 AgentRegistry — Agent 注册与发现

Core 层定义接口，Harness 层提供默认实现。让 Agent 之间能互相发现。

```typescript
import { DefaultAgentRegistry } from 'octopi/harness';

const registry = new DefaultAgentRegistry(eventBus);

// 注册 Agent
registry.register({
  id: 'coder',
  name: 'Code Agent',
  capabilities: ['coding', 'testing'],
  status: 'active',
});

// 按能力发现
const coders = registry.findByCapability('coding');

// 管理关系
registry.addRelation({ from: 'coordinator', to: 'coder', type: 'superior' });
```

### 4.15 AgentSwarm — 多 Agent 编排器

管理多个 Agent 的协作。支持 4 种拓扑：

| 拖扑 | 策略 | 说明 |
|------|------|------|
| `hierarchical` | CapabilityStrategy | 协调者按能力分配任务给工作者 |
| `peer-to-peer` | CapabilityStrategy | Agent 之间对等通信 |
| `pipeline` | PipelineStrategy | Agent 按顺序处理（前一个输出是后一个输入） |
| `broadcast` | RoundRobinStrategy | 一个任务广播给所有 Agent |

```typescript
import { AgentSwarm, PipelineStrategy } from 'octopi/harness';

const swarm = new AgentSwarm(
  { name: 'dev-team', topology: 'hierarchical' },
  registry,
  eventBus,
);

swarm.addAgent({ info: coderInfo, engine: coderEngine });
swarm.addAgent({ info: reviewerInfo, engine: reviewerEngine });

// 提交任务
const task = swarm.submitTask('实现新功能', '添加用户登录...');
const result = await swarm.executeTask(task);
```

---

## 5. Integration 层详解

### 5.1 存储后端

`SessionStore` 接口的实现：
- `JsonlSessionStore` — 默认，文件系统
- `InMemorySessionStore` — 测试用

### 5.2 可观测性

Observer 接口的实现：
- `NoopObserver` — 默认，零开销
- `LogObserver` — 日志输出

---

## 6. 安全架构

### 6.1 威胁模型

| 威胁 | 攻击面 | 防线 |
|---|---|---|
| Prompt Injection（直接） | 用户输入 | Core: SecurityGuard.checkUserInput() |
| Prompt Injection（间接） | 工具返回值 | Core: SecurityGuard.checkToolOutput() |
| 工具越权 | 工具调用参数 | Harness: ToolPolicyManager |
| 跨 Session 泄露 | Session 访问 | Harness: SessionIsolation |
| 敏感信息泄露 | 模型输出 | Core: SecurityGuard.checkModelOutput() |
| 恶意 Plugin | Plugin 注册 | Harness: PluginTrustLevel |
| 资源耗尽 | Agent 循环 | Core: IterationBudget |

### 6.2 不可信内容标记

外部内容（工具返回值、网页抓取、文件读取）在 ContextPipeline 中被标记为不可信。SecurityGuard 在检查时使用这些标记。

---

## 7. 设计决策记录 (ADR)

### ADR-001: Core 无状态

**决策：** AgentEngine 不持有 Session 状态。

**理由：** 可测试性、可复用性、关注点分离。

**权衡：** 调用方需要自己管理 Session。AgentBuilder 和 SessionAwareRunner 封装了这个复杂性。

### ADR-002: 回调槽而非 LifecycleHooks 接口

**决策：** Core 只暴露回调槽，不定义扩展机制接口。

**理由：** 避免 Core 和 Harness 的职责混乱。

**权衡：** Harness 层需要自己实现 hook chain 逻辑。

### ADR-003: 文件式 Persona

**决策：** Persona 是一组 Markdown 文件，不是结构化对象。

**理由：** 可塑性。用户可以自由表达任何特质。

**权衡：** 难以程序化查询 persona 属性。

### ADR-004: SecurityGuard 内置

**决策：** Core 层的安全检查不可禁用。

**理由：** Prompt Injection 是最严重的安全威胁，不能是可选的。

**权衡：** 开发调试时可能不方便。可以通过配置降低灵敏度，但不能完全禁用。

### ADR-005: ContextPipeline 管道模型

**决策：** 上下文组装采用管道模型，支持多阶段。

**理由：** 单一 `assemble()` 会变成上帝方法。

**权衡：** 管道阶段顺序很重要。

### ADR-006: EventBus 内置

**决策：** EventBus 是 Core 的一部分。

**理由：** 可观测性是生产级必需。

**权衡：** 增加了 Core 的复杂度。NoopEventBus 开销为零。

### ADR-007: Task 系统走 ContextPipeline Stage

**决策：** Task 系统通过 ContextPipeline 的 TaskStage 注入，不通过回调槽。

**理由：** Task 的核心是"上下文增强"——往 system prompt 注入任务上下文，让主 Agent 自然决定行为。这是上下文增强，不是拦截/修改。

**权衡：** TaskStage 是异步的，需要管道支持 async stage。

### ADR-008: callModel 流式事件 yield

**决策：** `AgentEngine.callModel()` 改为 AsyncGenerator，实时 yield `llm_stream_delta` 事件，而非收集完整响应后再返回。

**理由：** 流式输出是用户体验的核心需求。之前 callModel 收集流但不 yield，导致 CLI 无法实时显示内容。

**权衡：** callModel 的返回类型从 `Promise<LLMResponse>` 变为 `AsyncGenerator<EngineEvent, LLMResponse>`，增加了调用方的复杂度。

### ADR-009: ToolExecutor 返回原始结果

**决策：** `ToolExecutor.execute()` 返回 `Promise<unknown>`（原始结果），Engine 负责包装为 `ToolResult`。

**理由：** 职责清晰——Executor 只负责执行，Engine 负责结果格式化。之前 Executor 返回 `ToolResult` 但 Engine 又包一层，导致双层包装。

**权衡：** Executor 的返回类型不够明确，需要文档说明。

### ADR-010: 错误分类优先 HTTP 状态码

**决策：** 错误分类优先从 error 对象提取 HTTP 状态码（status/statusCode），回退到消息文本匹配。同时提取 Retry-After 头部用于重试延迟。

**理由：** 字符串匹配不可靠（`lower.includes('rate')` 可能误匹配）。HTTP 状态码是结构化信息，分类更准确。

**权衡：** 需要 Provider 在 error 对象中携带 status 属性。

### ADR-011: Plugin hook 超时可配置

**决策：** Plugin hook 超时后默认跳过 handler 并继续执行后续 hook（不中断链）。可通过 `abortOnTimeout` 配置为中断。

**理由：** 不同 hook 对超时的容忍度不同。迭代级 hook（before_iteration）超时应跳过继续，安全相关 hook（before_tool_call）超时应中断。

**权衡：** 增加了配置复杂度。

---

## 8. 与 OpenClaw 的关系

| 方面 | OpenClaw | Octopi |
|---|---|---|
| 定位 | 完整的 AI 助手平台 | 可嵌入的 Agent 底座 |
| 通信 | 内置飞书、Telegram 等 | 协议适配器可选 |
| 记忆 | 内置记忆系统 | 通过 ContextPipeline 注入 |
| 调度 | 内置心跳、定时任务 | 通过 Plugin 扩展 |
| Persona | 内置文件系统 | 文件式 PersonaLoader |
| 安全 | 平台级安全策略 | Core 内置 + Harness 配置 |

Octopi 保留了 OpenClaw 中通用的 Agent 运行时能力，去除了所有平台绑定。

### 4.13 CommandPlugin — 斜杠命令系统

会话内斜杠命令（`/new`、`/model`、`/help`、`/status`），在消息进入 Agent Loop 前拦截。

```typescript
const commands = new CommandPlugin({
  sessionIdRef: { current: 'session-1' },
  currentModelRef: { current: 'gpt-4' },
  onNewSession: () => `agent:cli:${Date.now()}`,
});

// 注册自定义命令
commands.register('/clear', {
  description: 'Clear screen',
  handler: async () => ({ success: true, message: 'Cleared' }),
});
```

**架构分层：**
```
用户消息 → Plugin Hook (message_received) → CommandPlugin.tryExecute()
                                                ├─ 匹配 → handler → 结果（不进 Agent Loop）
                                                └─ 不匹配 → null → 进 Agent Loop
```

**设计原则：**
- Plugin Hook 是触发机制，命令处理是独立关注点
- 用 ref 而非回调管理可变状态（sessionId、model）
- CLI 和 Gateway 共用同一套命令处理逻辑
- 任何 Plugin 都可以通过 `register()` 扩展命令

### ADR-012: 独立 CommandPlugin 模块

**决策：** 斜杠命令处理抽成独立的 CommandPlugin 模块，通过 Plugin Hook 挂载，不内嵌到 CLI 或 Gateway。

**理由：** 命令处理是独立关注点。CLI 和 Gateway 都需要命令能力，但触发机制不同（CLI 是 readline，Gateway 是 message_received hook）。抽成独立模块可以复用。

**权衡：** 增加了一层抽象。对简单 CLI 场景来说可能过度设计，但为 Gateway 场景打下了基础。

### ADR-013: 多 Agent 基础设施（AgentRegistry + AgentSwarm）

**决策：** 在 Core 层定义 AgentRegistry 接口，在 Harness 层提供 DefaultAgentRegistry 实现和 AgentSwarm 编排器。

**理由：** 多 Agent 协作需要一个发现机制（谁在那里、谁能做什么）和一个编排机制（任务怎么分配）。这些是原生能力，不是事后附加。Core 层的 ProcessModel 和 MessageChannel 提供了通信基础设施，Harness 层的 AgentSwarm 在其之上构建编排逻辑。

**权衡：** 增加了框架复杂度。单 Agent 场景不需要这些组件，但它们是可选的——不用就不引入。

### ADR-014: SmartStage — 分布式 LLM 决策点

**决策：** 在 ContextPipeline 中引入 SmartStage，允许上下文阶段嵌入独立的 LLM 调用进行决策。

**理由：** 传统的上下文管道是纯确定性逻辑——滑动窗口、固定规则。但有些场景需要“智能”判断：哪些消息最相关？如何压缩长对话？SmartStage 让管道可以“思考”，同时保持安全网：超时、缓存、fallback。

**权衡：** LLM 调用增加了延迟和成本。SmartStage 必须有 fallback 逻辑，不能让 LLM 失败阻塞整个管道。缓存是必须的。
