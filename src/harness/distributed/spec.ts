/**
 * Distributed Intelligence — DistributedAgentSpec
 *
 * 分布式智能体的完整规格定义。
 * 组合 Trigger + InputPolicy + Execution + OutputPolicy + lifecycle + limits。
 */

import type { TriggerRule } from './trigger.js';
import type { InputPolicy } from './input-policy.js';
import type { ExecutionMode } from './execution.js';
import type { OutputPolicy } from './output-policy.js';
import type { TriggerContext, AgentOutput } from './types.js';

/**
 * 分布式智能体规格
 *
 * 定义一个完整的分布式智能体：什么时候触发、输入什么、怎么执行、输出什么。
 *
 * @example
 * ```ts
 * const safetyGuard: DistributedAgentSpec = {
 *   id: 'safety-guard',
 *   name: 'Safety Guard',
 *   description: 'Intercepts dangerous tool calls',
 *   triggers: [{ type: 'event', event: { type: 'tool_call.risk_unknown' } }],
 *   inputPolicy: { visible: ['task_summary', 'pending_tool_call', 'working_directory'], snapshot: 'structured' },
 *   execution: { kind: 'llm', systemPrompt: '...', maxIterations: 1 },
 *   outputPolicy: { mode: 'intercept' },
 * };
 * ```
 */
export interface DistributedAgentSpec {
  // ── 身份 ──

  /** 唯一标识 */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** 描述 */
  description: string;

  // ── 触发规则 ──

  /** 触发规则列表 */
  triggers: TriggerRule[];

  // ── 输入策略 ──

  /** 输入策略 */
  inputPolicy: InputPolicy;

  // ── 执行模式 ──

  /** 执行模式 */
  execution: ExecutionMode;

  // ── 输出策略 ──

  /** 输出策略 */
  outputPolicy: OutputPolicy;

  // ── 生命周期钩子（可选） ──

  lifecycle?: {
    /** 触发前检查，返回 false 取消执行 */
    onTrigger?: (ctx: TriggerContext) => boolean;
    /** 智能体启动时 */
    onStart?: () => void;
    /** 智能体完成时 */
    onComplete?: (result: AgentOutput) => void;
    /** 智能体出错时 */
    onError?: (error: Error) => void;
  };

  // ── 资源限制（可选） ──

  limits?: {
    /** 最大执行时长（毫秒） */
    maxDurationMs?: number;
    /** 最大 token 数 */
    maxTokens?: number;
    /** 同时运行的最大实例数，达到上限时排队等待 */
    maxConcurrent?: number;
  };
}
