# Octopi 🐙

**可嵌入的 Agent 底座框架**

> Agent 不是一个 class，而是一个完整的运行时。
> Session 不是聊天记录，而是一个完整的交互生命周期。
> 框架的价值不在于提供了多少默认实现，而在于定义了多少清晰的接口。

---

## 为什么做 Octopi

OpenClaw 是一个完整的 AI 助手平台——内置飞书、Telegram、记忆系统、心跳调度……它很强，但也意味着：你只能用它做"AI 助手"。

Octopi 提炼了 OpenClaw 中**真正通用的 Agent 运行时能力**，去除所有平台绑定：

- Agent Loop（消息 → 上下文组装 → 模型推理 → 工具执行 → 回复）
- Session 管理（生命周期、持久化、并发控制）
- 多 Provider 支持（OpenAI / Anthropic / 任何兼容协议）
- Plugin 系统（全生命周期 hook，对齐 OpenClaw）
- Task 系统（LLM 驱动的任务追踪与恢复）
- 安全守卫（注入检测、敏感信息过滤、信任分级）

你可以用它做一个 CLI bot、一个 Web 应用的 AI 后端、一个嵌入式助手、一个你自己都还没想到的东西。

---

## 快速开始

```typescript
import { AgentBuilder } from 'octopi/harness';
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

---

## 架构：三层洋葱

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Integration                                        │
│  Gateway · Protocols · Storage Backends · Observability      │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Layer 2: Harness                                        │ │
│  │  Persona · Plugin · Skill · Task · ToolPolicy            │ │
│  │  ContextPipeline · ErrorStrategy · SecurityPolicy        │ │
│  │  AgentBuilder · SessionAwareRunner                       │ │
│  │                                                          │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │  Layer 1: Core                                       │ │ │
│  │  │  AgentEngine · EventBus · SecurityGuard · Budget     │ │ │
│  │  │  ModelProvider · ToolExecutor · ContextPipeline      │ │ │
│  │  │  ErrorStrategy · Observer                            │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向：外 → 内。内层不知道外层的存在。**

### Core 层（`src/core/`）

纯引擎 + 接口契约。零实现依赖。

| 组件 | 职责 |
|---|---|
| `AgentEngine` | 无状态循环引擎（输入 → 推理 → 工具 → 输出） |
| `EventBus` | 内置事件总线（全链路可观测） |
| `SecurityGuard` | 内置安全守卫（注入检测、敏感信息过滤，不可禁用） |
| `IterationBudget` | 资源约束（迭代次数、工具调用、token、时间） |
| `ModelProvider` | LLM 调用接口 |
| `ToolExecutor` | 工具执行接口 |
| `ContextPipeline` | 上下文组装管道接口 |
| `ErrorStrategy` | 错误处理策略接口 |
| `Observer` | 可观测性接口 |
| `SessionStore` | Session 持久化接口 |

### Harness 层（`src/harness/`）

装具层。通过 Core 接口挂载增强功能。

| 组件 | 职责 |
|---|---|
| `AgentBuilder` | Fluent API 组装器（一行代码启动 Agent） |
| `SessionAwareRunner` | Session 生命周期管理（锁、持久化、重置） |
| `PersonaLoader` | 文件式人格系统（AGENTS.md、SOUL.md 等） |
| `DefaultContextPipeline` | 可插拔的上下文管道（Persona → Skill → Task → History → Filter） |
| `TaskTracker` / `TaskManager` | LLM 驱动的任务追踪与恢复 |
| `CapabilityEnforcer` | Plugin 信任分级运行时强制 |
| `SecurityPresets` | 安全策略预设（development/testing/production/maximum） |
| `OutputQualityGate` | 输出质量检测 |
| `LegacyAgentRunner` | v0.1.x API 兼容层 |

### Integration 层（`src/integration/`）

集成层。协议适配、存储后端、可观测性。

| 组件 | 职责 |
|---|---|
| `JsonlSessionStore` | JSONL 文件存储（默认） |
| `InMemorySessionStore` | 内存存储（测试用） |
| `NoopObserver` | 空观测器（零开销） |
| `LogObserver` | 日志观测器（开发调试） |

---

## 核心设计

### AgentEngine 是无状态的

AgentEngine 不持有 Session 状态。消息历史由调用方传入，处理后由调用方持久化。

```typescript
// AgentEngine 的 run 方法签名
async *run(messages: Message[], config: RunConfig): AsyncGenerator<AgentEvent>

// 消息从哪来？调用方决定。
// AgentEngine 只负责：消息 → 推理 → 工具 → 输出
```

**好处：**
- 可测试 — 不需要 mock SessionStore
- 可复用 — 同一个引擎可以有 Session 或无 Session
- 关注点分离 — "怎么循环"和"怎么存储"是两个独立问题

### Persona 是文件式的

```
my-agent/
├── AGENTS.md    ← 操作指令
├── SOUL.md      ← 人格特质
├── IDENTITY.md  ← 身份定义
└── USER.md      ← 用户上下文
```

```typescript
const { engine } = await new AgentBuilder()
  .model('gpt-4')
  .persona('./my-agent')  // 加载目录中的所有 .md 文件
  .build();
```

无 schema → 自由表达。扩展 = 加文件。组合 = 目录叠加。

### 安全是内置的

- **SecurityGuard** 不可禁用 — 注入检测 + 敏感信息过滤
- **IterationBudget** 不可绕过 — 资源消耗硬约束
- **CapabilityEnforcer** 运行时强制 — Plugin 信任分级

### Plugin 系统对齐 OpenClaw

完整的 hook 系统，支持拦截语义和观察语义：

```typescript
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'my-plugin',
  name: 'My Plugin',
  register(api) {
    api.on('before_tool_call', async (event) => {
      if (event.toolName === 'shell') {
        return { requireApproval: { title: 'Execute shell', severity: 'warning' } };
      }
      return null; // 放行
    }, { priority: 50 });
  },
});
```

### Task 系统 — Agent 的工作记忆

LLM 驱动的任务追踪。用户中途聊别的，回来后 Agent 自动恢复上下文：

```typescript
import { TaskTracker, TaskManager } from 'octopi/harness';

// 通过 ContextPipeline 的 TaskStage 自动集成
// Agent 在 system prompt 中看到任务上下文，自然地决定行为
```

---

## 使用示例

### 最简集成

```typescript
import { createAgent } from 'octopi/harness';

const { engine, runner } = await createAgent({
  model: myProvider,
  persona: './my-agent',
});
```

### 自定义存储

```typescript
import { AgentBuilder } from 'octopi/harness';

const { engine, runner } = await new AgentBuilder()
  .model('gpt-4')
  .store(new RedisSessionStore({ host: 'localhost' }))
  .build();
```

### 事件订阅

```typescript
import { AgentEvents } from 'octopi/core';

engine.deps.events.on(AgentEvents.MODEL_CALL_END, (event) => {
  console.log(`模型调用: ${event.data.durationMs}ms`);
});

engine.deps.events.on(AgentEvents.INJECTION_DETECTED, (event) => {
  console.warn(`检测到注入: ${event.data}`);
});
```

### 安全策略

```typescript
import { AgentBuilder, SecurityPresets } from 'octopi/harness';

const { engine } = await new AgentBuilder()
  .model('gpt-4')
  .securityPolicy(SecurityPresets.production)
  .build();
```

### Agent 调用 Agent

```typescript
const reviewer = await new AgentBuilder()
  .model('gpt-4')
  .persona('./reviewer')
  .buildEngine();

const coder = await new AgentBuilder()
  .model('claude')
  .persona('./coder')
  .tool({
    definition: { name: 'review', description: '审查代码', parameters: {} },
    handler: async (args) => {
      const events = reviewer.run([{ role: 'user', content: args.code, timestamp: Date.now() }], { systemPrompt: '...' });
      // 收集结果
    },
  })
  .buildEngine();
```

---

## 向后兼容

v0.1.x API 仍然可用（deprecated）：

```typescript
// 旧方式
import { AgentRunner } from 'octopi';
const runner = new AgentRunner();
runner.registerProvider(provider);
runner.registerTool(tool);
const reply = await runner.processMessage(agent, session, channelMsg);

// 新方式（推荐）
import { AgentBuilder } from 'octopi/harness';
const { engine, runner } = await new AgentBuilder()
  .model(provider)
  .tool(tool)
  .build();
```

---

## 测试

```bash
npm test
# 325 tests passed
```

---

## 技术栈

- **语言:** TypeScript (ESM, Node.js >=20)
- **构建:** tsc
- **测试:** Vitest (node --experimental-vm-modules)

---

## 文档

| 文档 | 内容 |
|------|------|
| [架构设计](docs/ARCHITECTURE.md) | 设计哲学、三层架构详解、设计决策记录 |
| [Plugin 系统](docs/plugin-system.md) | Plugin hook 详解、Capability Ownership、完整示例 |
| [Task 系统](docs/task-system.md) | 任务管理设计、LLM 决策器、状态机 |
| [重构方案](docs/REFACTORING-PLAN.md) | 三层洋葱架构重构方案和迁移路径 |
| [迁移审计](docs/MIGRATION-AUDIT.md) | 代码迁移状态、优先级、进度追踪 |
| [开发指南](docs/development-guide.md) | 开发环境搭建、文档同步规范、测试规范 |

---

## License

MIT
