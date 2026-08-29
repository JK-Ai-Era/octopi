# Primitives — 基础设施原语

> Layer: Layer 1

框架的基础设施原语。机制性组件，供 Harness 层使用。

**核心理念**：原语是可组合的基础设施，不是策略。

## 职责

- EventBus — 一对多事件广播（33 个文件使用）
- StateMachine — 状态机（状态转换管理）
- AsyncTask — 异步原语（取消、超时、重试）
- ProcessModel — 进程模型（生命周期、spawn、IPC）

## 不做什么

- 不包含业务逻辑
- 不依赖外层

## 依赖

- Core: types/、interfaces/

## 文件说明

每个文件一个原语。index.ts 统一导出。
