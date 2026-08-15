# 并发控制模块架构（v0.6.0）

## 定位

并发控制模块解决多用户并发场景下的三个核心问题：

1. **API 限流** — 多个 API key 分散 rate limit 压力
2. **资源保护** — 限制同时运行的 Agent Loop 数量
3. **执行质量** — 工具结果验证，防止死循环

## 架构全景

```
┌─────────────────────────────────────────────────────┐
│                   octopi.json                       │
│  concurrency: { providerPool: {...}, sessionGate }  │
└───────────────────────┬─────────────────────────────┘
                        │ 配置驱动
                        ▼
┌─────────────────────────────────────────────────────┐
│                  AgentBuilder                       │
│  .provider() → .concurrency() → .build()            │
│                                                     │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────┐ │
│  │ ProviderPool │  │ SessionGate│  │ToolValidator │ │
│  │  (Harness)   │  │  (Harness) │  │  (Harness)   │ │
│  └──────┬───────┘  └─────┬──────┘  └──────┬───────┘ │
└─────────┼────────────────┼────────────────┼──────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
│  Engine.run()   │ │ Runner      │ │  Engine.run()   │
│  (ModelProvider │ │ .handle()   │ │  (工具执行后)    │
│   透明替换)     │ │ 入口门控    │ │  替换内联 noop  │
└─────────────────┘ └─────────────┘ └─────────────────┘
```

## 组件详情

### ProviderPool — 多 Key 负载均衡器

**文件：** `src/harness/concurrency/provider-pool.ts`

**核心能力：**
- 实现 `ModelProvider` 接口，对 Engine 完全透明
- 多 key 分发：同一模型多个 API key
- 粘滞路由：同一 session 尽量路由同一 key（prompt cache 命中）
- per-key 限流：每个 key 独立 RateLimiter
- 自动故障转移：连续 5 次错误 → 标记不健康 → 跳过

**路由策略：**
- `sticky`（默认）：加权随机首次选择，后续粘滞
- `round-robin`：加权轮询
- `least-loaded`：选负载最低的 slot

**集成点：** Builder.buildEngine() 中，当 `concurrency.providerPool` 配置存在且注册了 named providers 时，自动创建 ProviderPool 替换单个 provider。

### SessionGate — 信号量并发控制

**文件：** `src/harness/concurrency/session-gate.ts`

**核心能力：**
- 限制同时运行的 Agent Loop 数量
- FIFO 公平队列，防饥饿
- 可配置超时

**集成点：** Builder 从 `concurrency.sessionGate` 配置创建，传给 Runner。Runner.handle() 入口处 gate.enter()，finally 中 gateRelease()。

### RateLimiter — 令牌桶限流

**文件：** `src/harness/concurrency/rate-limiter.ts`

**核心能力：**
- 令牌桶算法：平滑限流，允许突发
- 定期补充令牌
- 超时保护

**集成点：** 嵌入 ProviderPool 每个 slot，独立限流。

### ToolValidator — 工具结果验证

**文件：** `src/harness/concurrency/tool-validator.ts`

**核心能力：**
- No-op 检测（`__noop` 标记 + 空值检测）
- 结果大小限制和截断
- 连续 no-op 阈值检测（可配置，默认 3）
- 工具调用历史追踪

**集成点：** Engine 中替换内联 noop 检测。Builder 在有 concurrency 配置时自动创建。

## 配置格式

```json
{
  "concurrency": {
    "providerPool": {
      "slots": [
        { "provider": "openai-1", "weight": 2, "rateLimit": { "requestsPerMinute": 120 } },
        { "provider": "openai-2" },
        { "provider": "anthropic-1" }
      ],
      "routing": { "strategy": "sticky", "stickyTtlMs": 1800000 },
      "rateLimit": { "requestsPerMinute": 60 }
    },
    "sessionGate": { "maxConcurrent": 50, "waitTimeoutMs": 30000 }
  }
}
```

## 向后兼容

不配 `concurrency` 字段 → 零行为变化，完全向后兼容。

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/harness/concurrency/provider-pool.ts` | 多 Key 负载均衡器 |
| `src/harness/concurrency/session-gate.ts` | 信号量并发控制 |
| `src/harness/concurrency/rate-limiter.ts` | 令牌桶限流器 |
| `src/harness/concurrency/tool-validator.ts` | 工具结果验证 |
| `src/harness/concurrency/index.ts` | 统一导出 |
| `src/config-schema.ts` | 并发配置 Schema |
| `src/config.ts` | 并发配置类型 |
| `src/harness/builder.ts` | Builder 集成 |
| `src/core/engine.ts` | Engine 集成 ToolValidator |
| `src/harness/runner.ts` | Runner 集成 SessionGate |
