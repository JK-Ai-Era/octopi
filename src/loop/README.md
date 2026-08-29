# Loop — 纯执行循环

> Layer: Layer 0

Agent 的核心执行循环。纯函数 + 回调扩展，零外部依赖。

**核心理念**：agentLoop() 是一个纯 async generator — 输入消息 → 调用 LLM → 执行工具 → 输出事件。不持有状态，不依赖 EventBus、SecurityGuard 或任何原语。

## 职责

- agentLoop() 纯函数：核心循环
- Agent 类：状态管理 + 生命周期（run/continue_）
- callModel()：LLM 调用（流式 + 超时保护）
- classifyError()：错误分类（HTTP 状态码优先）

## 不做什么

- 不做安全检查（通过 beforeToolCall 回调注入）
- 不做上下文压缩（通过 transformContext 回调注入）
- 不做可靠性包装（由 harness/reliability/ 包装）
- 不持有持久状态（状态在 Agent 类中）

## 依赖

- Core: types/messages.ts（Message, ToolCall 等）
- Core: interfaces/model-provider.ts（LLM 类型，仅 type import）

## 文件说明

- agent-loop.ts — agentLoop() 纯函数（578 行，核心中的核心）
- agent.ts — Agent 类（状态管理 + 消息队列）
- call-model.ts — LLM 调用（Promise.race 竞争超时）
- error-classifier.ts — 错误分类
- types.ts — 循环内部类型（AgentLoopConfig, AgentLoopEvent 等）
- index.ts — 统一导出
