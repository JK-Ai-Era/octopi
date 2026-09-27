/**
 * Agent 门面（Harness）
 *
 * Loop 层只有 agentLoop 纯函数；可运行的 Agent 门面住在 Harness，
 * 以便 `run()` 自带可靠性包装且不违反外→内依赖。
 */

export { Agent } from './agent.js';
export type { AgentOptions } from './agent.js';
