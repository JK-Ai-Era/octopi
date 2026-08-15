/**
 * concurrency — 并发控制模块
 *
 * 提供限流、并发控制、工具结果验证和多 key 负载均衡能力。
 *
 * - RateLimiter: 令牌桶限流，控制 LLM API 调用频率
 * - SessionGate: 信号量并发控制，限制同时运行的 session 数量
 * - ToolValidator: 工具执行结果验证，noop 检测和大小限制
 * - ProviderPool: 多 Key Provider 负载均衡，粘滞路由 + 自动故障转移
 */

export { RateLimiter, ProviderRateLimitManager } from './rate-limiter.js';
export type { RateLimiterConfig, RateLimiterMetrics } from './rate-limiter.js';

export { SessionGate } from './session-gate.js';
export type { SessionGateConfig, SessionGateMetrics } from './session-gate.js';

export { ToolValidator } from './tool-validator.js';
export type { ToolValidatorConfig, ValidationResult, ToolCallRecord } from './tool-validator.js';

export { ProviderPool } from './provider-pool.js';
export type {
  ProviderPoolConfig,
  PoolSlotConfig,
  RoutingConfig,
  SlotMetrics,
} from './provider-pool.js';
