# Agent Loop 架构设计

> 从零设计，无历史包袱。基于 Octopi / OpenClaw / hermes-agent 三家的经验。
>
> **状态**: ✅ 已实现（v0.1.2, 2026-06-04）
>
> **重大更新**: v0.1.2 移除了 LoopAdvisor 层，统一使用 Plugin hook 扩展。

---

## 核心设计决策

### 决策 1: 事件流原生（Event-Stream Native）

**选择**: Agent Loop 是一个 `AsyncIterable<AgentEvent>`，不是返回值函数。

**理由**:
- 流式输出是 LLM 应用的基本需求，不是高级功能
- 中间状态通知（工具开始/结束、thinking 进度）需要 push 模式
- 中断控制需要事件流才能在任意点切断
- 外部可观测性（监控、日志、UI）天然需要事件

```typescript
// ❌ 返回值模式（旧 Octopi）
const result = await agentLoop.processMessage(messages, sessionId);
// 只有最终结果，没有中间状态

// ✅ 事件流模式（新 Loop）
for await (const event of runAgentLoop(config, input, signal)) {
  switch (event.type) {
    case 'llm_stream_delta': display.update(event.delta); break;
    case 'tool_call_start': showSpinner(event.toolName); break;
    case 'tool_call_result': hideSpinner(); break;
    case 'loop_end': showResult(event.response); break;
  }
}
```

### 决策 2: 内部/外部消息分离

**选择**: 内部用 `Message`（丰富元数据），LLM 边界用 `LLMMessage`（provider 格式）。

**理由**:
- 内部消息需要携带来源标记（source/taskId/turnId）
- 不同 provider 的消息格式不同（Anthropic vs OpenAI），转换应集中在一处
- 内部代码不应关心 provider 兼容性

```typescript
// 内部格式 — 丰富
interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  source?: { channel: string; senderId: string; ... }
  timestamp: number
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  metadata?: Record<string, unknown>
}

// LLM 格式 — 精简
interface LLMMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

// 转换层
interface MessageConverter {
  toLlm(messages: Message[], stripMeta?: boolean): LLMMessage[]
  fromLlm(message: LLMMessage): Message
}
```

### 决策 3: 三层架构

```
┌─────────────────────────────────────────────────────┐
│                    Agent Loop                        │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  Layer 1: Pre-iteration Hooks (扩展层)         │  │
│  │                                               │  │
│  │  Plugin hook: before_iteration                │  │
│  │  ┌─────────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │ TaskManager │ │ Steering │ │  Policy   │  │  │
│  │  │   Plugin     │ │  Plugin  │ │  Plugin   │  │  │
│  │  │  priority=10 │ │ priority │ │  priority │  │  │
│  │  │            │ │   =20    │ │    =30    │  │  │
│  │  └─────────────┘ └──────────┘ └───────────┘  │  │
│  │                                               │  │
│  │  输出: MetaDecision (inject/override/stop)     │  │
│  └───────────────────────────────────────────────┘  │
│                       ↓                             │
│  ┌───────────────────────────────────────────────┐  │
│  │  Layer 2: LLM Decision (模型层)                │  │
│  │                                               │  │
│  │  ContextEngine.assemble() → LLMRequest        │  │
│  │  LLMProvider.stream() → LLMResponse           │  │
│  │  MessageConverter.toLlm() / fromLlm()         │  │
│  │                                               │  │
│  │  输出: AssistantMessage (content + toolCalls)   │  │
│  └───────────────────────────────────────────────┘  │
│                       ↓                             │
│  ┌───────────────────────────────────────────────┐  │
│  │  Layer 3: Tool Execution (执行层)              │  │
│  │                                               │  │
│  │  参数验证 → 修复 → 去重 → 截断检测              │  │
│  │  ToolRegistry.execute() → ToolResult           │  │
│  │                                               │  │
│  │  输出: ToolResult[]                             │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  Cross-cutting: IterationBudget / AbortSignal  │  │
│  │  ErrorClassifier / RetryPolicy                 │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 决策 4: Task Management 通过 Plugin Hook 集成

**选择**: TaskManager 通过 `before_iteration` hook 集成，loop 架构从设计之初就感知任务。

**理由**:
- 任务状态影响循环行为（shouldStop、shouldContinue）
- 任务上下文注入发生在每轮迭代前，与 loop 生命周期强耦合
- 通过 Plugin hook 实现解耦，TaskManager 是一个普通 Plugin
- 支持拦截语义：返回非 null 可中断后续 hooks

---

## 实现的类型定义

### AgentEvent（28 种事件）

```typescript
type AgentEvent =
  // ── 循环生命周期 ──
  | { type: 'loop_start'; sessionId: string }
  | { type: 'loop_end'; reason: LoopEndReason; response?: string }

  // ── Turn 生命周期 ──
  | { type: 'turn_start'; turnId: string; turnIndex: number }
  | { type: 'turn_end'; turnId: string; shouldContinue: boolean }

  // ── Meta-decision 阶段 ──
  | { type: 'meta_decision'; decisions: MetaDecision[] }
  | { type: 'messages_injected'; count: number; source: string }

  // ── LLM 阶段 ──
  | { type: 'llm_request'; model: string; estimatedTokens: number }
  | { type: 'llm_thinking_delta'; delta: string }
  | { type: 'llm_stream_delta'; delta: string }
  | { type: 'llm_response'; content: string; toolCalls?: ToolCall[]; usage?: TokenUsage; durationMs: number }

  // ── 工具阶段 ──
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; arguments: string }
  | { type: 'tool_call_result'; toolCallId: string; toolName: string; result: string; durationMs?: number }
  | { type: 'tool_call_error'; toolCallId: string; toolName: string; error: string }

  // ── 错误和重试 ──
  | { type: 'error'; error: ClassifiedError; retrying: boolean }
  | { type: 'retry_wait'; attempt: number; maxRetries: number; waitMs: number }
  | { type: 'context_compressed'; beforeTokens: number; afterTokens: number }

  // ── 中断 ──
  | { type: 'interrupt_requested' }
  | { type: 'interrupted'; phase: string }
```

### LoopEndReason

```typescript
type LoopEndReason =
  | 'completed'         // LLM 返回最终响应，无 tool calls
  | 'max_turns'         // 达到最大轮次
  | 'budget_exhausted'  // IterationBudget 耗尽
  | 'plugin_stop'       // before_iteration hook 返回 stop
  | 'interrupted'       // 用户中断
  | 'error';            // 不可恢复的错误
```

### MetaDecision

```typescript
interface MetaDecision {
  injectMessages?: Message[]       // 消息注入
  overrideModel?: string           // 覆盖模型
  overrideThinking?: ThinkingLevel // 覆盖 thinking level
  overrideMaxTokens?: number       // 覆盖最大输出 token
  shouldStop?: boolean             // 决定停止循环
  stopReason?: string              // 停止原因
  taskContext?: string             // 任务上下文（注入到 system prompt）
}
```

### IterationContext

```typescript
interface IterationContext {
  sessionId: string
  turnId: string
  turnIndex: number
  messages: Message[]
  iterationBudget: { used: number; remaining: number; max: number }
  abortSignal: AbortSignal
}
```

### ClassifiedError

```typescript
interface ClassifiedError {
  reason: ErrorReason       // rate_limit | context_length | auth | billing | network | timeout | server | unknown
  provider?: string
  model?: string
  statusCode?: number
  retryAfterMs?: number
  message: string
  originalError: unknown
}
```

### AgentLoopConfig

```typescript
interface AgentLoopConfig {
  provider: LLMProvider
  contextEngine: ContextEngine
  toolRegistry: { getDefinitions(): unknown[]; execute(name: string, args: string, ctx: unknown): Promise<ToolResult> }
  messageConverter: MessageConverter
  pluginManager: PluginManager  // 用于 before_iteration / after_iteration hooks
  defaultModel: string
  maxTurns: number
  iterationBudget: number
  maxConsecutiveErrors: number
  retry: RetryConfig
  onEvent?: (event: AgentEvent) => void
  onSteering?: () => Promise<Message[]>
}
```

---

## 核心循环实现

```typescript
async function* runAgentLoop(
  config: AgentLoopConfig,
  input: Message,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  const { provider, contextEngine, toolRegistry, messageConverter, pluginManager } = config;
  const budget = new IterationBudget(config.iterationBudget);
  const messages: Message[] = [input];
  let turnIndex = 0;
  let consecutiveErrors = 0;

  yield { type: 'loop_start', sessionId };

  try {
    while (true) {
      // ── 检查中断 / 预算 / 最大轮次 ──
      if (signal?.aborted) { yield { type: 'interrupted', phase: 'loop_check' }; return; }
      if (!budget.consume()) { yield { type: 'loop_end', reason: 'budget_exhausted' }; return; }
      if (turnIndex >= config.maxTurns) { yield { type: 'loop_end', reason: 'max_turns' }; return; }

      yield { type: 'turn_start', turnId, turnIndex };

      // ═══ Layer 1: Pre-iteration Hooks (扩展层) ═══
      // 通过 PluginManager 触发 before_iteration hook
      const decisions = await pluginManager.emit('before_iteration', { sessionId, messages, turnIndex });
      // 应用 hook 返回的 MetaDecision（拦截语义：首个返回非 null 的中断后续）
      for (const decision of decisions) {
        if (decision?.injectMessages) messages.push(...decision.injectMessages);
        if (decision?.shouldStop) { yield { type: 'loop_end', reason: 'plugin_stop' }; return; }
      }
      yield { type: 'meta_decision', decisions };

      // ═══ Layer 2: LLM Decision (模型层) ═══
      yield { type: 'llm_request', model, estimatedTokens };
      const response = await streamLLMWithRetry(provider, model, llmMessages, signal, config.retry);
      yield { type: 'llm_response', content, toolCalls, usage, durationMs };
      messages.push(assistantMsg);

      // 无 tool calls → 最终响应
      if (!toolCalls?.length) {
        yield { type: 'loop_end', reason: 'completed', response: content };
        return;
      }

      // ═══ Layer 3: Tool Execution (执行层) ═══
      for (const tc of dedupedCalls) {
        yield { type: 'tool_call_start', toolCallId, toolName, arguments };
        const result = await toolRegistry.execute(name, args, ctx);
        yield { type: 'tool_call_result', toolCallId, toolName, result, durationMs };
        messages.push(toolMsg);
      }

      // ── Turn 后处理 ──
      yield { type: 'turn_end', turnId, shouldContinue: true };
      // 触发 after_iteration hook（观察语义：全部执行，不中断）
      await pluginManager.emit('after_iteration', { sessionId, messages, turnResult });
      turnIndex++;
    }
  } catch (error) {
    yield { type: 'error', error: classifyError(error), retrying: false };
    yield { type: 'loop_end', reason: 'error' };
  }
}
```

---

## 与 Task Management System 的集成

TaskManager 通过 `before_iteration` hook 集成到 Agent Loop：

```typescript
// src/tasks/plugin.ts
export const taskManagerPlugin: PluginDefinition = {
  name: 'task-manager',

  hooks: {
    // 在每轮迭代前做任务决策
    before_iteration: {
      priority: 10,  // 在 steering (20) 和 policy (30) 之前执行

      handler: async (api, event) => {
        const { sessionId, messages } = event.data;
        const tracker = api.getService('taskTracker');
        const manager = api.getService('taskManager');

        const lastUserMsg = getLastUserMessage(messages);
        const currentTasks = tracker.getActiveTasks(sessionId);
        const decision = await manager.decide({ sessionId, currentTasks, newMessage, recentContext });
        applyDecision(sessionId, decision);

        return decision.injectTaskContext ? { taskContext: decision.taskContext } : null;
      }
    },

    // 每轮迭代后的清理/状态更新
    after_iteration: {
      priority: 10,
      handler: async (api, event) => {
        // 目前不做自动更新，由 TaskManager 在下一轮 before_iteration 中判断
      }
    }
  }
};
```

关键设计点：
1. **TaskManager 是 Plugin hook 的一环**，不是 loop 内部硬编码
2. **priority 10**：在 steering (20) 之前执行，确保任务状态先确定
3. **拦截语义**：返回 MetaDecision 可中断后续 hooks 和 loop 执行
4. **可替换**：可以有不同的 TaskManager 实现（规则引擎 vs LLM）

---

## 错误分类器

7 种错误类型，各有不同的重试策略：

| 错误类型 | 可重试 | 策略 |
|---------|--------|------|
| `rate_limit` | ✅ | 尊重 Retry-After 头，exponential backoff |
| `network` | ✅ | exponential backoff + jitter |
| `timeout` | ✅ | exponential backoff |
| `server` (5xx) | ✅ | exponential backoff |
| `context_length` | ❌ | 压缩上下文后重试（不是 backoff 重试） |
| `auth` | ❌ | 不重试，直接报错 |
| `billing` | ❌ | 不重试，直接报错 |
| `unknown` | ❌ | 不重试 |

重试策略：`jitteredBackoff(attempt, baseDelayMs, maxDelayMs)`
- 基础延迟 × 2^attempt
- 加 0~25% 随机抖动（防止 thundering herd）
- 尊重 rate limit 的 Retry-After 头

---

## IterationBudget

```typescript
class IterationBudget {
  consume(): boolean      // 消费一次迭代，返回是否允许
  refund(): void          // 退还一次（如程序化工具调用）
  consumeGrace(): boolean // 预算耗尽后给一次额外机会，仅一次
  reset(): void           // 重置（新 session 时）
}
```

默认预算：90 次迭代。父 Agent 的预算来自 `config.iterationBudget`。

---

## 实际文件结构

```
src/
├── loop/                          # ✅ 新 Loop 模块
│   ├── agent-loop.ts              # runAgentLoop() 异步生成器（255 行核心循环）
│   ├── iteration-budget.ts        # IterationBudget 计数器
│   ├── error-classifier.ts        # 错误分类 + jitteredBackoff
│   ├── message-converter.ts       # 内部/LLM 消息转换器
│   └── index.ts                   # 统一导出
├── core/
│   └── types.ts                   # 扩展：AgentEvent(28种)、MetaDecision 等
├── tasks/
│   ├── task-manager.ts            # 不变
│   ├── tracker.ts                 # 不变
│   └── plugin.ts                  # ✅ 使用 before_iteration / after_iteration hooks
├── plugins/
│   └── manager.ts                 # Plugin hook 系统
├── agent/
│   └── agent-runner.ts            # AgentRunner（调用 runAgentLoop）
└── ...                            # 其余不变

tests/
└── loop.test.ts                   # ✅ 新测试（IterationBudget / ErrorClassifier / MessageConverter / runAgentLoop）
```

---

## 与旧代码的关系

| 组件 | 状态 | 说明 |
|------|------|------|
| `src/loop/agent-loop.ts` | ✅ 主力 | 异步生成器，三层架构 |
| `src/agent/agent-runner.ts` | ✅ 新增 | 替代旧 AgentLoop class |
| `PluginManager` | 不变 | hook 系统继续用，新增 before_iteration/after_iteration |
| `ContextEngine` 接口 | 不变 | 4 阶段生命周期保持 |
| `ToolRegistry` | 不变 | 工具注册与执行 |
| `TaskTracker` / `TaskManager` | 不变 | 通过 plugin.ts 集成 |
| `src/tasks/advisor.ts` | ✅ 已删除 | 被 plugin.ts 替代 |

---

_本设计基于 Octopi / OpenClaw / hermes-agent 三家经验，目标是"最优架构"而非"最小改动"。_
_已实现并验证：v0.1.2, 148 tests 全通过，0 errors。_