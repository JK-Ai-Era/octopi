/**
 * Distributed Intelligence — Execution Modes
 *
 * 三种执行模式：LLM、Code、Hybrid。
 * 不是所有分布式智能体都需要 LLM，执行模式是多态的。
 */

import type { RegisteredTool } from '../../core/types.js';
import type { AgentInput, AgentOutput } from './types.js';

// ── LLMExecution ──

/**
 * LLM 驱动执行模式
 *
 * 用于语义判断、生成类任务。
 * 自动创建独立 Engine 实例。
 */
export interface LLMExecution {
  kind: 'llm';
  /** 系统提示词 */
  systemPrompt: string;
  /**
   * 工具配置
   * - string[]: 工具名列表，从主 Agent 的工具集中查找
   * - RegisteredTool[]: 工具定义列表，直接使用
   * - 不传: 继承主 Agent 的工具集
   */
  tools?: string[] | RegisteredTool[];
  /** 模型覆盖，不填用主 Agent 的模型 */
  model?: string;
  /** 最大迭代次数（默认 1） */
  maxIterations?: number;
}

// ── CodeExecution ──

/**
 * 代码驱动执行模式
 *
 * 用于确定性算法。直接调用 handler 函数，不需要 Engine。
 */
export interface CodeExecution {
  kind: 'code';
  /** 执行函数 */
  handler: (input: AgentInput) => Promise<AgentOutput>;
}

// ── HybridExecution ──

/**
 * 混合执行模式
 *
 * 代码预处理 + LLM 判断 + 代码后处理。
 */
export interface HybridExecution {
  kind: 'hybrid';
  /** 预处理函数（可选） */
  preProcess?: (input: AgentInput) => Promise<AgentInput>;
  /** LLM 配置 */
  llm: LLMExecution;
  /** 后处理函数（可选） */
  postProcess?: (output: AgentOutput) => Promise<AgentOutput>;
}

// ── ExecutionMode ──

/**
 * 执行模式联合类型
 */
export type ExecutionMode = LLMExecution | CodeExecution | HybridExecution;
