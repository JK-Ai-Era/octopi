# Concurrency — 并发控制

> Layer: Layer 2

多 key 分发、会话粘滞、限流、工具验证。

**核心理念**：核心不是排队限流，是多 key 分发 + 会话粘滞。

## 职责

- ProviderPool — 多 Key LLM Provider 负载均衡
- RateLimiter — 令牌桶限流器
- SessionGate — 并发 session 门控
- ToolValidator — 工具结果验证

## 不做什么

- 不做安全检查
- 不做任务管理

## 依赖

- Core: interfaces/model-provider、types/

## 文件说明

- provider-pool.ts — 多 Key 负载均衡
- rate-limiter.ts — 令牌桶限流
- session-gate.ts — 信号量门控
- tool-validator.ts — 工具验证
- index.ts — 统一导出
