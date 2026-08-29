# Reliability — 可靠性

> Layer: Layer 2

Agent 循环的可靠性包装 — 重试、检测、监督、断路。

**核心理念**：每个机制直接解决对应问题，不用代理指标。

## 职责

- runAgentWithReliability() — 可靠性包装函数（核心入口）
- CircuitBreaker — 断路器
- wrapProviderWithCircuitBreaker() — Provider 断路包装
- IterationBudget — 资源约束

## 不做什么

- 不做安全检查（通过回调注入）
- 不做上下文管理（通过回调注入）

## 依赖

- Core: loop/、interfaces/、primitives/
- Harness: task-system/supervisor

## 文件说明

- run-agent.ts — runAgentWithReliability()（~550 行）
- circuit-breaker.ts — 断路器
- provider-wrapper.ts — Provider 包装
- budget.ts — IterationBudget
- index.ts — 统一导出
