/**
 * QueueMode — 消息队列模式
 *
 * Core 层类型。定义 Agent 消息队列的处理策略。
 * 由 loop/agent.ts 使用。
 */

/** 队列模式 */
export type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';
