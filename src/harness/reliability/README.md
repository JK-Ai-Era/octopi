# Reliability — 可靠性

> Layer: Layer 2

Agent 循环的可靠性包装 — 重试、检测、监督、断路。

**核心理念**：每个机制直接解决对应问题，不用代理指标。

## 职责

- `runAgentWithReliability()` — 可靠性包装（底层实现；**业务入口请用 `Agent.run()`**）
- `HarnessLoopEvent` — Loop 协议事件 + budget / run_guard 扩展
- CircuitBreaker — 断路器
- wrapProviderWithCircuitBreaker() — Provider 断路包装

## 不做什么

- 不做安全检查（通过 SecurityGuard 注入 harness 装备）
- 不做上下文管理（通过 transformContext 回调注入）
- 不是公共运行门面（门面在 `harness/agent` 的 `Agent.run()`）

## 依赖

- Loop: agentLoop、AgentLoopEvent（纯协议）
- Core: interfaces/reliability、error-strategy、run-guard
- Harness: budget、run-guard（可选注入）

## 文件说明

- run-agent.ts — runAgentWithReliability()
- harness-events.ts — HarnessLoopEvent / budget_exceeded / run_guard_*
- circuit-breaker.ts — 断路器
- provider-wrapper.ts — Provider 包装
- fallback-provider.ts — 多模型回退
- run-metrics-collector.ts — 运行指标与外部信号
- index.ts — 统一导出
