# Core — 机制原语 + 接口契约

> Layer: Layer 1

框架的基础设施层。定义所有接口契约，提供机制原语（EventBus 等），定义核心类型。

**核心理念**：Core 只包含机制，不包含策略。所有策略实现在 Harness 层。

## 职责

- 定义接口契约（interfaces/）
- 提供基础设施原语（primitives/）
- 定义核心类型（types/）
- 提供安全守卫纯函数（security-guard.ts）

## 不做什么

- 不实现任何接口的具体策略
- 不 import 任何外层模块（Harness、Integration）
- 不持有持久状态

## 依赖

- Loop: types/ 和 interfaces/（Core 不依赖 Loop）

## 文件说明

- interfaces/ — 18 个接口契约
- primitives/ — EventBus、StateMachine、AsyncTask、ProcessModel
- types/ — 核心类型定义（Message、ToolCall、Session 等）
- security-guard.ts — severityToAction() + isValidSecurityGuard()
- index.ts — 统一导出
- types.ts — barrel re-export
