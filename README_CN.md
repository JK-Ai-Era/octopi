# Octopi 🐙

**可嵌入的 Agent 底座框架**

> Agent 不是一个 class —— 它是一个完整的运行时。
> Session 不是聊天记录 —— 它是一个完整的交互生命周期。
> 框架的价值不在于提供了多少默认实现，而在于定义了多少清晰的接口。

[English](./README.md)

---

## 为什么做 Octopi

大多数 Agent 框架给你一个整体：固定的 Agent Loop、固定的 Session 模型、固定的集成方式。你可以直接用，但一旦需要不同的东西 —— 自定义上下文管道、不同的存储后端、在自己的产品里嵌入一个 Agent —— 你就在和框架打架。

Octopi 从第一性原理出发，构建了一套**运行时工具箱**：

- **AgentEngine** — 无状态消息循环（输入 → 上下文组装 → 模型推理 → 工具执行 → 输出）
- **Session 管理** — 生命周期、持久化、并发控制，全部可插拔
- **多 Provider LLM** — OpenAI、Anthropic，或任何实现 `ModelProvider` 接口的提供者
- **Plugin 系统** — 完整的生命周期 hook，支持拦截语义和观察语义
- **Task 系统** — LLM 驱动的任务追踪、上下文恢复、自主规划
- **安全内置** — 注入检测、敏感信息过滤、信任分级 —— 不可选、不可移除

你可以用它做一个 CLI bot、一个 Web 应用的 AI 后端、一个嵌入式助手，或者一个你还没想到的东西。

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

### Core 层（`src/core/`）—— 纯引擎

零实现依赖。只有接口和最小的 Agent 循环。

| 组件 | 职责 |
|---|---|
| `AgentEngine` | 无状态循环引擎 —— 框架的心脏 |
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
  .model('gpt-4')
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
  .model('gpt-4')
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
| **定位** | 完整的 AI 助手平台 | 可嵌入的运行时工具箱 |
| **架构** | 集成系统 | 三层分离（Core / Harness / Integration） |
| **Agent 模型** | 有状态的 class | 无状态引擎 + 可插拔 Session |
| **耦合度** | 平台绑定（频道、记忆、调度） | Core 层零平台依赖 |
| **目标用户** | 终端用户构建助手 | 开发者在产品中嵌入 Agent |
| **扩展性** | Plugin 系统 | Plugin 系统 + 每层接口均可替换 |

OpenClaw 是一个优秀的项目。Octopi 是当你问"如果只提取运行时，让它可组合呢？"时会发生的事。

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
