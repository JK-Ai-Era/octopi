# Octopi 🐙

**可嵌入的 Agent 引擎**

> Agent 不是一个 class —— 它是一个完整的运行时。
> Session 不是聊天记录 —— 它是一个完整的交互生命周期。
> 框架的价值不在于提供了多少默认实现，而在于定义了多少清晰的接口。

[English](./README.md)

---

## 未来的软件

未来会是什么样？未来的软件会是什么样？

与用户的交互方式可能会完全不同，系统运行的逻辑可能不同，大量的工作逻辑可能不再是代码驱动，而是 LLM 驱动。但 LLM 本质上是无状态的内容生成模型——它可能知道全世界所有的知识，却不知道你工作的具体内容，也无法直接读写你电脑上的数据。要让 LLM 真正为你干活，它还需要**感官**——去感知你的环境和上下文；需要**手脚**——去操作文件、调用接口、执行命令；需要**记忆**——去记住你是谁、做过什么、偏好什么。

那么软件会如何演进？从丰富的图形界面，直接变成一个聊天窗口？

我们认为不会。图形界面在信息密度、交互效率、操作便捷性等方面依然有着不可替代的优势。一个精心设计的仪表盘、一张结构化的数据表格、一套流畅的拖拽操作——这些都不是聊天框能简单替代的。

**未来的软件，不应该是把所有界面都替换成聊天窗口，等着 LLM 逐字生成答案。** 而是把 AI 的能力作为系统的一部分，无缝集成进来。AI 可以做运维监控、可以做数据分析、可以做内容审核、可以做流程编排、可以做智能决策——但这一切的前提是：你的系统需要一个足够强大、稳定、安全、可扩展的 Agent 底座。

---

## 为什么做 Octopi？

大多数 Agent 框架给你一个整体：固定的 Agent Loop、固定的 Session 模型、固定的集成方式。你可以直接用，但一旦需要不同的东西 —— 自定义上下文管道、不同的存储后端、在自己的产品里嵌入一个 Agent —— 你就在和框架打架。

**Octopi 不是又一个框架，而是一个引擎。** 把它想象成 AI Agent 的"引擎"——就像汽车需要引擎才能跑起来，你的产品需要 Agent 引擎才能拥有 AI 能力。

- **嵌入式设计** —— 不是独立应用，而是你产品的组件
- **AgentEngine** —— 无状态消息循环（输入 → 上下文组装 → 模型推理 → 工具执行 → 输出）
- **Session 管理** —— 生命周期、持久化、并发控制，全部可插拔
- **多 Provider LLM** —— OpenAI、Anthropic，或任何实现 `ModelProvider` 接口的提供者
- **Plugin 系统** —— 完整的生命周期 hook，支持拦截语义和观察语义
- **Task 系统** —— LLM 驱动的任务追踪、上下文恢复、自主规划
- **安全内置** —— 注入检测、敏感信息过滤、信任分级 —— 不可选、不可移除

你可以用它做一个 CLI bot、一个 Web 应用的 AI 后端、一个嵌入式助手，或者一个你还没想到的东西。

---

## 核心理念

### Agent 是运行时，不是一个 class

一个 Agent 不是一个可以 `new` 出来的对象。它是一个完整的运行时作用域：工作空间、Session 存储、工具集、模型配置、人格定义——这些共同构成一个 Agent。框架提供引擎和机制，集成方提供策略和业务逻辑。

### 内核与装具分离

框架分为两层：**内核（Core）** 提供机制——消息循环、事件总线、安全守卫、资源约束；**装具（Harness）** 提供策略——人格、插件、技能、任务规划。内核永远不知道装具的存在，装具通过接口挂载到内核上。这意味着你可以只用内核写一个极简 Agent，也可以用全套装具构建一个复杂的自治系统。

### Session 是一等公民

所有状态归 Session，不归 Agent。Agent 引擎本身是无状态的——它接收消息，返回结果。状态的生命周期、持久化方式、并发控制，全部由 Session 层决定。这让同一个引擎可以服务无状态的 API 调用，也可以支撑长期运行的对话式 Agent。

### 接口的价值 > 默认实现

框架的价值不在于提供了多少默认实现，而在于定义了多少清晰的接口。`ModelProvider` 让你换 LLM 厂商只需实现一个接口；`SessionStore` 让你换存储后端不影响任何上层逻辑；`ContextPipeline` 让你自由组装上下文的每一个阶段。好的接口是框架最珍贵的资产。

### 安全不可选

注入检测、敏感信息过滤、资源消耗约束——这些不是可以打开或关闭的配置项，而是框架的内建约束。Agent 越强大，安全机制就越不能依赖开发者自觉。

### 文件即配置

Persona、技能、操作指令——全部以 Markdown 文件定义。没有 schema，没有配置格式。扩展 = 加文件。组合 = 目录叠加。这是从 OpenClaw 学到的最优雅的设计之一：用最简单的形式表达最灵活的配置。

### 天然多 Agent

八爪鱼有八条触手，每条都能独立感知和行动，但共享同一个身体。Octopi 的设计也是如此——从底层就支持多 Agent 协作：每个 Agent 拥有独立的运行时作用域（Session、工具集、人格），彼此隔离互不干扰；同时内建了 Agent 间的通信和协调机制，让多个 Agent 可以像触手一样协同工作。这不是事后附加的功能，而是架构的原生能力。

### 分布式智能

大多数 Agent 框架的会话任务，本质上都在一条 LLM 调用链中运行——这意味着系统只能在主链上思考，很难做到自己规划自己。Octopi 采用了不同的方式：我们在工作流的关键节点嵌入了独立的 LLM 逻辑来规划和管理主链。比如任务系统中的 LLMPlanner，它不是主链的一部分，而是一个独立的决策者，负责审视任务进展、调整执行策略、决定下一步行动。

就像八爪鱼的智能不只集中在大脑，而是分布在全身各条触手上——每条触手都有自己的神经节，能独立做出反应。Octopi 的架构中，智能不是单点的，而是分布式的。未来我们还计划在更多逻辑节点嵌入小型自治智能体，让整个架构更灵活、更强大。

---

## 架构：三层洋葱

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Integration（集成层）                               │
│  协议适配 · 存储后端 · 可观测性                                │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Layer 2: Harness（装具层）                               │ │
│  │  Persona · Plugin · Skill · Task · Planner               │ │
│  │  Strategy · Resources · Security Policy · Builder        │ │
│  │                                                          │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │  Layer 1: Core（引擎层）                              │ │ │
│  │  │  AgentEngine · EventBus · SecurityGuard · Budget     │ │ │
│  │  │  AsyncTask · ProcessModel · Interfaces               │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向：外 → 内。内层不知道外层的存在。**

### Core 层（`src/core/`）—— 引擎核心

零实现依赖。只有接口和最小的 Agent 循环。

| 组件 | 职责 |
|---|---|
| `AgentEngine` | 无状态循环引擎 —— 引擎的心脏 |
| `EventBus` | 全链路可观测的事件总线 |
| `SecurityGuard` | 注入检测 + 敏感信息过滤（不可禁用） |
| `IterationBudget` | 资源约束：迭代次数、工具调用、token、时间 |
| `AsyncTask` | 异步原语：取消、超时、重试、持久化 |
| `ProcessModel` | Agent 进程模型：生命周期、spawn、IPC |
| `ModelProvider` | LLM 调用接口 |
| `ToolExecutor` | 工具执行接口 |
| `ContextPipeline` | 上下文组装管道接口 |
| `ErrorStrategy` | 错误分类与恢复接口 |

### Harness 层（`src/harness/`）—— 装具层

Agent 获得人格、工具和智能的地方。

| 组件 | 职责 |
|---|---|
| `AgentBuilder` | Fluent API —— 一行代码启动 Agent |
| `SessionAwareRunner` | Session 生命周期管理：锁、持久化、重置 |
| `PersonaLoader` | 文件式人格系统（AGENTS.md、SOUL.md 等） |
| `DefaultContextPipeline` | 可插拔管道：Persona → Skill → Task → History → Knowledge → Filter |
| `AgentSupervisor` | 持续运行的 Agent 核心：感知 → 思考 → 执行 → 反思 |
| `TaskTracker` / `TaskManager` | LLM 驱动的任务追踪与恢复 |
| `RulePlanner` / `LLMPlanner` / `HybridPlanner` | 规划器：规则驱动 / LLM 驱动 / 混合 |
| `TaskScheduler` | 任务调度：once / interval / cron / at |
| `MemoryKnowledgeStore` | 知识 CRUD、关键词检索、置信度过滤 |
| `LLMReflector` | 质量评估、模式识别、经验存储 |
| `RuleTaskClassifier` | 7 种任务类型 × 3 级复杂度 |
| `DefaultStrategyRouter` | 6 种推理策略：direct / chain-of-thought / plan-and-execute / tool-use / reflect / multi-agent |
| `ResourceManager` | Token 预算、成本追踪、速率限制 |
| `CapabilityEnforcer` | Plugin 信任分级运行时强制 |
| `SecurityPresets` | 安全策略预设：development / testing / production / maximum |

### Integration 层（`src/integration/`）—— 集成层

协议适配、存储后端、可观测性。

| 组件 | 职责 |
|---|---|
| `JsonlSessionStore` | JSONL 文件存储（默认） |
| `InMemorySessionStore` | 内存存储（测试用） |
| `NoopObserver` | 零开销空观测器 |
| `LogObserver` | 日志观测器（开发调试） |
| `TraceLogger` | 分级结构化事件日志 |
| `TraceCollector` | 自动收集引擎事件到 trace |
| `ConsoleExporter` / `JsonlFileExporter` / `WebhookExporter` | Trace 导出后端（Exporter SPI） |
| `MetricsAggregator` | LLM/token/延迟/成本指标聚合 |
| `RecordingProvider` | 录制真实 LLM 交互用于回放 |
| `ReplayProvider` | 回放录制的交互（确定性测试） |
| `ChaosProvider` | 故障注入：空回复、超时、限流、畸形响应 |
| `ScenarioRunner` | E2E 场景测试 + 内置断言库 |
| `ScenarioComposer` | 场景组合、扩展、参数化运行 |

---

## 快速开始

```typescript
import { AgentBuilder } from 'octopi';
import { OpenAIProvider } from 'octopi';

const { engine, runner } = await new AgentBuilder()
  .model(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .persona('./my-agent')
  .build();

// 处理消息
for await (const event of runner.handle('session-1', userMessage)) {
  console.log(event);
}
```

### 自定义存储

```typescript
import { AgentBuilder } from 'octopi';

const { engine, runner } = await new AgentBuilder()
  .model('gpt-5.5')
  .store(new RedisSessionStore({ host: 'localhost' }))
  .build();
```

### 事件订阅

```typescript
import { AgentEvents } from 'octopi';

engine.deps.events.on(AgentEvents.MODEL_CALL_END, (event) => {
  console.log(`模型调用: ${event.data.durationMs}ms`);
});

engine.deps.events.on(AgentEvents.INJECTION_DETECTED, (event) => {
  console.warn(`检测到注入: ${event.data}`);
});
```

### 安全策略

```typescript
import { AgentBuilder, SecurityPresets } from 'octopi';

const { engine } = await new AgentBuilder()
  .model('gpt-5.5')
  .securityPolicy(SecurityPresets.production)
  .build();
```

---

## 核心设计

### AgentEngine 是无状态的

引擎不持有 Session 状态。消息历史由调用方传入，结果以 async generator 返回。这意味着：

- **可测试** —— 不需要 mock SessionStore
- **可复用** —— 同一个引擎可以有 Session 或无 Session
- **关注点分离** —— "怎么循环"和"怎么存储"是两个独立问题

### Persona 是文件式的

```
my-agent/
├── AGENTS.md    ← 操作指令
├── SOUL.md      ← 人格特质
├── IDENTITY.md  ← 身份定义
└── USER.md      ← 用户上下文
```

没有 schema，没有配置格式。就是 markdown 文件。扩展 = 加文件。组合 = 目录叠加。

### 安全是内置的，不是附加的

- **SecurityGuard** 不可禁用 —— 注入检测 + 敏感信息过滤
- **IterationBudget** 不可绕过 —— 资源消耗硬约束
- **CapabilityEnforcer** —— Plugin 信任分级运行时强制

### Plugin 系统：双语义

Plugin 支持**拦截语义**（返回值中断链路）和**观察语义**（全部执行）。Hook 按优先级排序，支持 per-handler 超时。

```typescript
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'my-plugin',
  name: 'My Plugin',
  register(api) {
    api.on('before_tool_call', async (event) => {
      if (event.toolName === 'shell') {
        return { requireApproval: { title: '执行 shell', severity: 'warning' } };
      }
      return null; // 放行
    }, { priority: 50 });
  },
});
```

### Task 系统 —— Agent 的工作记忆

LLM 驱动的任务追踪。用户中途聊别的，回来后 Agent 自动恢复上下文：

```typescript
import { TaskTracker, TaskManager } from 'octopi/harness';

// 通过 ContextPipeline 的 TaskStage 自动集成
// Agent 在 system prompt 中看到任务上下文，自然地决定行为
```

---

## 从 OpenClaw 学到了什么

Octopi 最初是从探索 OpenClaw 的架构开始的。OpenClaw 是一个功能完整的 AI 助手平台 —— 它处理频道、记忆、心跳、插件等。我们从它的设计中学到了很多：

- **Plugin hook 语义** —— OpenClaw 的拦截/观察双语义模式优雅且实用，我们采用了相同的模型。
- **Persona 作为文件** —— AGENTS.md / SOUL.md 模式被证明是定义 Agent 行为的强大方式，不需要写代码。
- **上下文管道思维** —— 通过分阶段管道组装上下文（而不是一个巨大的 prompt builder），这个思路我们从 OpenClaw 的方法中提炼而来。
- **Session 是一等公民** —— OpenClaw 认真对待 Session，不是事后补丁。我们更进一步，让 Session 管理完全可插拔。

我们的分歧：

| 方面 | OpenClaw | Octopi |
|---|---|---|
| **定位** | 完整的 AI 助手平台 | 可嵌入的 Agent 引擎 |
| **架构** | 集成系统 | 三层分离（Core / Harness / Integration） |
| **Agent 模型** | 有状态的 class | 无状态引擎 + 可插拔 Session |
| **耦合度** | 平台绑定（频道、记忆、调度） | Core 层零平台依赖 |
| **目标用户** | 终端用户构建助手 | 开发者在产品中嵌入 Agent |
| **扩展性** | Plugin 系统 | Plugin 系统 + 每层接口均可替换 |

OpenClaw 是一个优秀的项目。Octopi 是当你问"如果只提取引擎，让它可组合呢？"时会发生的事。

---

## 测试

```bash
npm test
# 428 tests passed
```

### 测试金字塔

| 层级 | 工具 | 说明 |
|---|---|---|
| L1: 单元测试 | Mock + Vitest | 快速、确定性、每次保存跑 |
| L2: 录制回放 | RecordingProvider + ReplayProvider | 录制真实交互，回放做回归测试 |
| L3: E2E | ScenarioRunner + ChaosProvider | 真实 API、故障注入、完整场景 |

### 可观测性

```json
{
  "observability": {
    "level": 3,
    "consoleLevel": 2,
    "traceDir": "~/.octopi/traces",
    "exporters": [
      { "type": "jsonl-file", "dir": "~/.octopi/traces" },
      { "type": "webhook", "url": "https://monitoring.example.com/ingest" }
    ]
  }
}
```

Trace 级别：`FATAL(0)` → `ERROR(1)` → `WARN(2)` → `INFO(3)` → `DEBUG(4)` → `TRACE(5)`

---

## 技术栈

- **语言:** TypeScript (ESM, Node.js >=20)
- **构建:** tsc
- **测试:** Vitest (node --experimental-vm-modules)

---

## 文档

| 文档 | 内容 |
|---|---|
| [架构设计](docs/ARCHITECTURE.md) | 设计哲学、三层架构详解、设计决策记录 |
| [Plugin 系统](docs/plugin-system.md) | Hook 语义、Capability Ownership、完整示例 |
| [Task 系统](docs/task-system.md) | 任务管理设计、LLM 决策器、状态机 |
| [重构方案](docs/REFACTORING-PLAN.md) | 三层洋葱架构重构方案和迁移路径 |
| [迁移审计](docs/MIGRATION-AUDIT.md) | 代码迁移状态、优先级、进度追踪 |
| [开发指南](docs/development-guide.md) | 开发环境搭建、文档同步规范、测试规范 |

---

## License

MIT