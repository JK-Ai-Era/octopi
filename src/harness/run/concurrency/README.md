# Concurrency — 并发控制

> Layer: Layer 2

多 key 分发、会话粘滞、限流、工具验证。

**核心理念**：核心不是排队限流，是多 key 分发 + 会话粘滞。

## 职责

- ProviderPool — 多 Key LLM Provider 负载均衡
- RateLimiter — 令牌桶限流器
- SessionGate — 并发 session 门控
- ToolValidator — 工具结果验证
- **SessionLease / InProcessSessionLock** — 会话租约端口（E2/E7）。键 = `sessionId`。v1 进程内 FIFO；**Gateway 向所有 Runner 注入同一实例**。跨进程部署必须替换实现，禁止假设内存锁全局有效

## 不做什么

- 不做安全检查
- 不做任务管理
- 不做分布式 Lease 后端（仅接口位）

## 依赖

- Core: interfaces/model-provider、types/

## 文件说明

- provider-pool.ts — 多 Key 负载均衡
- rate-limiter.ts — 令牌桶限流
- session-gate.ts — 信号量门控
- tool-validator.ts — 工具验证
- **session-lease.ts** — `SessionLease` + `InProcessSessionLock` + `DistributedSessionLease` 契约
- index.ts — 统一导出
