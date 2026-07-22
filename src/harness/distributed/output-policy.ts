/**
 * Distributed Intelligence — OutputPolicy
 *
 * 定义智能体输出的格式，以及如何影响主 Agent。
 * 四种模式：intercept、replace_context、inject_context、notify。
 */

import type { Message } from '../../core/types.js';
import type {
  AgentOutput,
  InterceptOutput,
  ContextOutput,
  NotifyOutput,
  AgentContext,
} from './types.js';

// ── ResultInjectionMode ──

/**
 * 结果注入模式
 *
 * - intercept: 拦截主 Agent 的操作（安全守卫）
 * - replace_context: 替换主 Agent 的上下文（上下文压缩）
 * - inject_context: 在主 Agent 上下文中注入新信息（动态注入）
 * - notify: 发送事件给主 Agent（审计/日志）
 */
export type ResultInjectionMode =
  | 'intercept'
  | 'replace_context'
  | 'inject_context'
  | 'notify';

// ── OutputPolicy ──

/**
 * 输出策略
 *
 * 定义智能体输出的格式和注入模式。
 */
export interface OutputPolicy {
  /** 结果注入模式 */
  mode: ResultInjectionMode;
}

// ── ToolResult ──

/**
 * 工具执行结果（intercept 模式返回）
 */
export interface InterceptResult {
  /** 是否继续执行原始工具调用 */
  proceed: boolean;
  /** 不继续时的结果 */
  result?: unknown;
}

// ── handleIntercept ──

/**
 * 处理 intercept 模式的输出
 *
 * 直接决定操作结果：
 * - allow: 继续执行原始工具调用
 * - degrade: 执行替代命令
 * - block: 返回错误
 */
export function handleIntercept(output: InterceptOutput, _ctx: AgentContext): InterceptResult {
  switch (output.decision) {
    case 'allow':
      return { proceed: true };
    case 'degrade':
      return {
        proceed: false,
        result: {
          degraded: true,
          alternative: output.alternative,
          notice: output.alternative?.notice ?? 'Operation degraded by safety guard',
        },
      };
    case 'block':
      return {
        proceed: false,
        result: {
          blocked: true,
          reason: output.reason,
        },
      };
  }
}

// ── handleReplaceContext ──

/**
 * 处理 replace_context 模式的输出
 *
 * 替换主 Agent 的消息数组。
 * 注意：此函数直接修改 ctx.messages 数组引用。
 */
export function handleReplaceContext(output: ContextOutput, ctx: AgentContext): void {
  // 清空现有消息
  ctx.messages.length = 0;
  // 推入压缩后的消息
  for (const msg of output.messages) {
    ctx.messages.push({
      ...msg,
      timestamp: Date.now(),
      metadata: output.compressed ? { compressed: true } : undefined,
    } as Message);
  }
}

// ── handleInjectContext ──

/**
 * 处理 inject_context 模式的输出
 *
 * 在主 Agent 的 messages 末尾追加系统消息。
 */
export function handleInjectContext(output: ContextOutput, ctx: AgentContext): void {
  for (const msg of output.messages) {
    ctx.messages.push({
      role: 'system',
      content: msg.content,
      timestamp: Date.now(),
      metadata: { source: 'distributed_agent' },
    } as Message);
  }
}

// ── handleNotify ──

/**
 * 处理 notify 模式的输出
 *
 * 通过 EventBus 发送事件。
 */
export function handleNotify(output: NotifyOutput, ctx: AgentContext): void {
  ctx.events.emit({
    type: 'distributed_agent.notify',
    timestamp: Date.now(),
    data: { content: output.content, level: output.level },
  });
}

// ── InjectionQueue ──

/**
 * 注入队列条目
 */
export interface InjectionEntry {
  /** 来源智能体 ID */
  agentId: string;
  /** 输出内容 */
  output: ContextOutput;
  /** 注入模式 */
  mode: 'replace_context' | 'inject_context';
}

/**
 * InjectionQueue — 解决竞态条件
 *
 * replace_context 和 inject_context 不直接修改主 Agent 的 messages 数组
 * （主 Agent 可能正在 LLM 调用中）。而是通过注入队列机制：
 *
 * 1. 分布式智能体完成时，将结果加入队列
 * 2. 主 Agent 的 ContextEngine 在 assemble 之前调用 applyPendingInjections()
 * 3. 这是安全的时间点：两次 LLM 调用之间
 */
export class InjectionQueue {
  private queue: InjectionEntry[] = [];

  /**
   * 入队注入请求
   */
  enqueue(entry: InjectionEntry): void {
    this.queue.push(entry);
  }

  /**
   * 应用所有待处理的注入
   *
   * 在主 Agent 的 ContextEngine.assemble() 之前调用。
   * 处理完成后清空队列。
   *
   * @param messages - 主 Agent 的消息数组引用
   */
  applyPending(messages: Message[]): void {
    // 按优先级排序：replace_context 优先于 inject_context
    const sorted = [...this.queue].sort((a, b) => {
      const priorityA = a.mode === 'replace_context' ? 0 : 1;
      const priorityB = b.mode === 'replace_context' ? 0 : 1;
      return priorityA - priorityB;
    });

    for (const entry of sorted) {
      if (entry.mode === 'replace_context') {
        // 替换：清空并推入新消息
        messages.length = 0;
        for (const msg of entry.output.messages) {
          messages.push({
            ...msg,
            timestamp: Date.now(),
            metadata: { compressed: entry.output.compressed },
          } as Message);
        }
      } else if (entry.mode === 'inject_context') {
        // 注入：追加系统消息
        for (const msg of entry.output.messages) {
          messages.push({
            role: 'system',
            content: msg.content,
            timestamp: Date.now(),
            metadata: { source: 'distributed_agent' },
          } as Message);
        }
      }
    }

    this.queue.length = 0;
  }

  /**
   * 队列中待处理的注入数量
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue.length = 0;
  }
}
