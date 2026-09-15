/**
 * Core 层主入口（Layer 1）— Kernel + 机制
 *
 * 产品事件词表：harness/events
 * Domain 契约：harness 各领域
 */

// ── Kernel + Product port 类型 ──
export * from './interfaces/kernel.js';

// ── 基础设施原语 ──
export * from './primitives/index.js';
export type { AgentEvent as EventBusAgentEvent } from './primitives/event-bus.js';

// ── 安全守卫纯函数（SecurityGuard 类型已由 kernel 导出） ──
export { isValidSecurityGuard, severityToAction } from './security-guard.js';

// ── 核心类型（Kernel 词汇表） ──
export * from './types/index.js';
export { getTextContent, hasMediaContent } from './types/messages.js';
