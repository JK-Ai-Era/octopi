# Types — 核心类型定义

> Layer: Layer 1

框架的核心类型。按职责拆分为子模块。

**核心理念**：类型是接口的基础。定义在 Core 层，供所有层使用。

## 职责

- messages.ts — Message、ContentBlock、ToolCall、ToolResult
- agent-definition.ts — AgentPersona、ModelConfig、AgentDefinition
- session.ts — SessionStatus、SessionMeta
- turn.ts — TokenUsage、Turn
- tools.ts — ToolDefinition、RegisteredTool、ToolHandler
- skills.ts — SkillDefinition、SkillManager
- events.ts — AgentEventDetail、LoopEndReason
- queue-mode.ts — QueueMode（规范定义）
- thinking-level.ts — ThinkingLevel（规范定义）

## 不做什么

- 不 re-export 外层类型（已清理）
- 不包含实现逻辑

## 依赖

- 无

## 文件说明

每个文件按职责定义一类类型。index.ts barrel 导出。types.ts 再次 barrel 保持兼容。
