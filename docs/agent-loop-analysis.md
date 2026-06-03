# Agent Loop 对比分析

> 对比 Octopi / OpenClaw / hermes-agent 的 agent-loop 实现，提炼可借鉴的设计

**日期**: 2026-06-02

---

## 三个实现的定位

| 维度 | Octopi | OpenClaw | hermes-agent |
|------|--------|----------|-------------|
| 语言 | TypeScript | TypeScript | Python |
| 行数 | ~300 行 | ~200 行 (核心) + harness 层 | ~4800 行 |
| 定位 | 框架级（精简） | SDK 级（可组合） | 产品级（全功能） |
| 设计风格 | Class-based OOP | Functional + callbacks | Class-based OOP |

---

## 关键差异分析

### 1. 消息抽象层

**OpenClaw** 有一个 `AgentMessage` 抽象层，内部用自定义消息格式，只在 LLM 调用边界转换：

```typescript
// OpenClaw: AgentMessage 是内部格式，Message 是 LLM 格式
convertToLlm: (messages: AgentMessage[]) => Message[]
transformContext: (messages: AgentMessage[]) => Promise<AgentMessage[]>
```

好处：
- 内部可以有自定义消息类型（UI通知、状态消息等）
- 转换逻辑集中在一处，不散落在各处
- 可以在转换层做消息过滤、重组

**hermes-agent** 直接用 OpenAI 格式，但在 API 调用前做大量清理：
- `_sanitize_messages_surrogates` — 清理非法 Unicode
- `_repair_tool_call_arguments` — 修复畸形 JSON 参数
- `_repair_message_sequence` — 修复角色交替错误
- `_copy_reasoning_content_for_api` — provider 特定的 reasoning 回传
- `_sanitize_tool_calls_for_strict_api` — 清理 strict API 不接受的字段

**Octopi** 用 `Message` 类型直接贯穿全程，没有内部/外部的区分。

**借鉴**：
- 采纳 OpenClaw 的 `convertToLlm` 模式，在 Context Engine 的 `assemble` 阶段做转换
- 采纳 hermes-agent 的消息清理策略，在转换层统一处理

---

### 2. 迭代预算管理

**hermes-agent** 的 `IterationBudget` 是线程安全的 consume/refund 计数器：

```python
class IterationBudget:
    def consume(self) -> bool:  # 尝试消费一次，返回是否允许
    def refund(self) -> None:   # 退还一次（如 execute_code 等工具调用）
```

关键设计：
- 工具调用可以 refund（execute_code 等程序化调用不计入预算）
- Grace call：预算耗尽后给一次额外机会
- 每个 Agent（父/子）独立预算

**Octopi** 只有简单的 `maxIterations` 计数器，没有 refund、没有 grace call。

**借鉴**：直接实现 `IterationBudget` 类，支持 consume/refund/grace。

---

### 3. 流式支持

**OpenClaw** 的 Agent Loop 天生基于 EventStream：
```typescript
agentLoop(...): EventStream<AgentEvent, AgentMessage[]>
```
事件流包括 `message_start`、`message_update`、`message_end`，天然支持流式。

**hermes-agent** 的流式实现极其复杂：
- `_interruptible_streaming_api_call` — 可中断的流式调用
- 90s stale-stream detection — 流超时检测
- 60s read timeout — 读超时
- Stream scrubbing — 处理流中的损坏数据
- Think scrubber — 处理推理块的流式输出

**Octopi** 完全没有流式支持，只有同步的 `provider.complete()`。

**借鉴**：
- P1: 在 `LLMProvider` 接口增加 `stream()` 方法，返回 `AsyncIterable<LLMChunk>`
- P2: 在 Agent Loop 中增加事件流模式，`processMessage` 返回 `AsyncIterable<AgentEvent>`

---

### 4. 错误处理与重试

**hermes-agent** 有完整的错误分类和重试策略：

```python
# 错误分类
classified = classify_api_error(api_error)
# → FailoverReason.rate_limit / billing / context_length / auth / ...

# 不同错误不同策略
if classified.reason == FailoverReason.context_length:
    # 压缩上下文后重试
if classified.reason == FailoverReason.rate_limit:
    # 等待 Retry-After 后重试
if classified.reason == FailoverReason.billing:
    # 切换 fallback provider
```

重试使用 jittered backoff：
```python
wait_time = jittered_backoff(retry_count, base_delay=2.0, max_delay=60.0)
# 中断感知的 sleep
while time.time() < sleep_end:
    if agent._interrupt_requested:
        break
    time.sleep(0.2)
```

**Octopi** 没有任何重试逻辑，LLM 调用失败直接抛异常。

**借鉴**：
- 实现 `classifyApiError()` 错误分类器
- 实现带 jitter 的 exponential backoff
- 实现 provider fallback 链
- 重试期间支持中断检测

---

### 5. 中断支持

**OpenClaw** 通过 `AbortSignal` 贯穿整个管线：
```typescript
agentLoop(..., signal?: AbortSignal, ...)
beforeToolCall(context, signal?: AbortSignal)
```

**hermes-agent** 通过 `_interrupt_requested` 标志位，在多个检查点检测：
- 循环开始时
- 重试 sleep 中
- API 调用中（流式可中断）

**Octopi** 没有任何中断机制。

**借鉴**：
- 在 `processMessage` 接受 `AbortSignal`
- 在循环的每个迭代检查 `signal.aborted`
- 将 signal 传递给 LLM 调用和工具执行

---

### 6. 工具调用的丰富处理

**OpenClaw** 的 `BeforeToolCallContext` 包含丰富的上下文：
```typescript
interface BeforeToolCallContext {
    assistantMessage: AssistantMessage;  // 触发此调用的 assistant 消息
    toolCall: AgentToolCall;             // 原始 tool call 块
    args: unknown;                       // 已验证的参数
    context: AgentContext;               // 当前 agent 上下文
}
```

`AfterToolCallResult` 支持覆盖工具结果：
```typescript
interface AfterToolCallResult {
    content?: (TextContent | ImageContent)[];  // 替换内容
    details?: unknown;                          // 替换详情
    isError?: boolean;                          // 替换错误标志
    terminate?: boolean;                        // 提前终止提示
}
```

**hermes-agent** 的工具调用处理：
- 参数 JSON 验证 + 自动修复（空字符串 → `{}`）
- 工具名称验证（不存在的工具返回错误而不是崩溃）
- 工具调用去重（`_deduplicate_tool_calls`）
- 截断检测（参数不以 `}` 或 `]` 结尾 → 拒绝执行）
- Tool guardrails（危险工具调用可被 halt）
- Housekeeping 工具分类（memory/todo/skill_manage 是"家务"工具）

**Octopi** 的工具执行非常简单：验证必填参数 → 执行。

**借鉴**：
- 扩展 `BeforeToolCallEvent` 和 `AfterToolCallEvent` 的上下文
- 增加工具参数 JSON 验证和修复
- 增加工具调用去重
- 增加截断检测

---

### 7. Steering 和 Follow-up 消息

**OpenClaw** 的两个关键 hooks：

```typescript
// 中途注入：agent 正在工作时，用户发送新消息
getSteeringMessages?: () => Promise<AgentMessage[]>;

// 后续消息：agent 完成一轮后，还有排队的消息等待处理
getFollowUpMessages?: () => Promise<AgentMessage[]>;
```

**hermes-agent** 实现了 `/steer` 命令：
- 用户在 agent 工作时发送 `/steer some guidance`
- 在下一次 API 调用前注入到最后一条 tool 消息中
- 如果没有 tool 消息可注入，则暂存等待

**Octopi** 完全没有这个能力。用户中途发的消息会被丢弃或等到下一轮。

**借鉴**：
- 实现 `getSteeringMessages` 回调
- 在每次迭代的 API 调用前检查并注入 steering 消息
- 实现 `getFollowUpMessages` 在循环结束后处理排队消息

---

### 8. 上下文压缩时机

**hermes-agent** 的 preflight compression：
```python
# 在循环开始前就检查是否需要压缩
if compressor.should_compress(estimated_tokens):
    messages, system_prompt = agent._compress_context(messages, system_prompt)
```

还有 API 错误触发的压缩：
```python
if classified.reason == FailoverReason.context_length:
    # 压缩后重试
    restart_with_compressed_messages = True
```

**Octopi** 的 Context Engine 有 `compact()` 方法，但 Agent Loop 从未调用它。

**借鉴**：
- 在循环开始前调用 `contextEngine.shouldCompact()`
- 在 context_length 错误时触发压缩后重试

---

### 9. shouldStopAfterTurn / prepareNextTurn

**OpenClaw** 的动态控制：

```typescript
// 一轮结束后，决定是否停止
shouldStopAfterTurn?: (context) => boolean | Promise<boolean>;

// 准备下一轮，可以替换 context/model/thinking level
prepareNextTurn?: (context) => AgentLoopTurnUpdate | undefined;
```

这允许运行时动态调整策略，比如：
- 上下文快满时主动停止
- 根据对话进展切换模型
- 调整 thinking level

**Octopi** 没有这个能力。

**借鉴**：在 AgentLoopConfig 中增加这两个回调。

---

## 优先级排序

### P0 — 必须立即实现（框架可用性）

| 功能 | 来源 | 工作量 |
|------|------|--------|
| `IterationBudget` 类 | hermes | 小 |
| `AbortSignal` 支持 | OpenClaw | 中 |
| 流式 LLM 接口 (`stream()`) | 两者 | 中 |
| 错误分类 + 重试 | hermes | 中 |
| 工具参数 JSON 验证/修复 | hermes | 小 |
| Context compact 调用 | hermes | 小 |

### P1 — 近期实现（生产就绪）

| 功能 | 来源 | 工作量 |
|------|------|--------|
| `convertToLlm` 转换层 | OpenClaw | 中 |
| Steering 消息注入 | OpenClaw + hermes | 中 |
| `shouldStopAfterTurn` 回调 | OpenClaw | 小 |
| `prepareNextTurn` 回调 | OpenClaw | 小 |
| Provider fallback 链 | hermes | 中 |
| 工具调用去重 + 截断检测 | hermes | 小 |

### P2 — 后续迭代

| 功能 | 来源 | 工作量 |
|------|------|--------|
| `FollowUpMessages` 队列 | OpenClaw | 中 |
| 工具 guardrails | hermes | 中 |
| 流式健康检测 | hermes | 小 |
| 消息序列修复 | hermes | 小 |

---

## 建议的重构方向

```
当前:  processMessage() → 同步返回 Message
目标:  processMessage() → AsyncIterable<AgentEvent>

AgentEvent = {
    type: 'turn_start' | 'turn_end' | 'message_start' | 'message_update'
         | 'message_end' | 'tool_start' | 'tool_end' | 'error' | 'abort'
}
```

这样一次重构就能同时支持：
- 流式输出
- 中间状态通知
- 中断控制
- 外部可观测性

---

_本分析基于 Octopi commit 95b6023, OpenClaw 2026.6.1, hermes-agent 当前 main 分支。_
