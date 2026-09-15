# Types — 核心类型定义

> Layer: Layer 1

框架的核心类型。按职责拆分为子模块。

**核心理念**：类型是接口的基础。定义在 Core 层，供所有层使用。

## 职责

- messages.ts — Message、ContentBlock、ToolCall、ToolResult
- agent-definition.ts — ModelInfo、ToolPolicy（Kernel；AgentDefinition/Persona/ModelConfig 在 harness/types）
- session.ts — SessionStatus、SessionMeta
- turn.ts — TokenUsage、Turn
- tools.ts — ToolDefinition、RegisteredTool、ToolHandler
- queue-mode.ts — QueueMode
- thinking-level.ts — ThinkingLevel

测试编排词表（AgentEventDetail）与产品事件 Map 已迁 `harness/events/`。

Skill 类型与 SkillManager 已迁至 harness/plugin-ecosystem/skills（非 Kernel）。

## 不做什么

- 不 re-export 外层类型（已清理）
- 不包含实现逻辑
- 不定义 LLMStreamChunk（规范在 `interfaces/model-provider.ts`）

## 依赖

- 无

## 文件说明

每个文件按职责定义一类类型。index.ts barrel 导出。types.ts 再次 barrel 保持兼容。
