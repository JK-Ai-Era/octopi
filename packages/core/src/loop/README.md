# Loop — 纯执行循环

> Layer: Layer 0

Agent 的核心执行循环。纯函数 + 回调扩展，零外部依赖。

**核心理念**：`agentLoop()` 是一个纯 async generator — 输入消息 → 调用 LLM → 执行工具 → 输出协议事件。不持有状态，不依赖 EventBus、SecurityGuard。**可运行门面在 `harness/agent`（`Agent.run()`）。**

## 职责

- agentLoop() 纯函数：核心循环
- callModel()：LLM 调用（流式 + 超时 + finishReason 透传）
- classifyError()：错误分类（HTTP 状态码优先）

## 不做什么

- 不做安全检查（通过 beforeToolCall 回调注入）
- 不做上下文压缩（通过 transformContext 回调注入）
- 不做可靠性包装（harness/reliability + harness/agent）
- 不产出 budget / run_guard 事件（见 HarnessLoopEvent）
- **不为 LLM 业务错误 throw**：`onError` 仅 `retry` / `abort`

## 关键不变量

1. LLM 业务失败永不 throw：终止必 yield `agent_end`
2. 批次内全部 `terminate=true` → `agent_end(should_stop)`
3. `tool_results` 与 `tool_calls` 一一对应（含中止占位）
4. `tool_end.toolCall` 携带原始 arguments
5. 流式优先使用 provider `finishReason`（done chunk）
6. `turn_end.phase`：`pre_tools` | `final`（工具路径不会在工具后再补 final）
7. 事件类型仅 Loop 协议

## 文件说明

- agent-loop.ts — agentLoop()
- call-model.ts — callModel()
- error-classifier.ts — classifyError()
- types.ts — AgentLoopConfig / AgentLoopEvent 等
- index.ts — 统一导出
