/**
 * Run 作用域 — 跨切面身份与工具运行时（ALS）
 *
 * 宪法 I1：可变上下文只活在 Run。本模块承载 **身份与旁路读取**
 * （sessionId / agentId / systemPrompt / toolRuntime），供 convertToLlm、
 * 工具 handler、RunGuard checkpoint 使用；messages 工作区仍经
 * `Agent.run({ context })` 的 AgentContext 显式传递。
 *
 * @module harness/run-scope
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Message } from '../core/types.js';
import type { ToolIsolationMode } from './tool-effect/isolation.js';

/** 工具执行时可见的 Run 运行时上下文 */
export interface RunToolRuntime {
  sessionId: string;
  agentId: string;
  messages: Message[];
  /** 工具 cwd（解析自 RunConfig.cwd / agent.workspace + toolIsolation） */
  cwd?: string;
  /** 本 Run 生效的工具效应隔离模式（I5） */
  isolation?: ToolIsolationMode;
}

/** 一次 Run 的作用域身份（I1） */
export interface RunScope {
  sessionId: string;
  agentId: string;
  /**
   * 本 episode 的 Run 标识（与宪法 Run=(sessionId, agentId, …) 对齐）。
   * 由 Runner 在组装 RunScope 时生成；Observer/审计共用，不另造第二套 ID。
   */
  runId?: string;
  /** 本轮 systemPrompt 装配结果；供 convertToLlm / 层装配 */
  systemPrompt?: string;
  /**
   * turn 级 Knowledge grounding（arch/knowledge-layer.md §4.4）。
   * 内容命中不进 system；消息侧插槽 source='knowledgeGrounding'。
   */
  grounding?: {
    query: string;
    mode: 'inject' | 'hint' | 'none';
    hitCount: number;
    coverage?: number;
    tokens: number;
  };
  /** 工具运行时上下文；缺省时由 Provider 回退 */
  toolRuntime?: RunToolRuntime;
  /** Agent 模板 revision（Reserved：AgentRevision 绑 Run） */
  agentRevision?: string;
}

let runIdSeq = 0;

/**
 * 生成与 RunScope 对齐的 runId（含 sessionId/agentId，可读且可排序）
 *
 * @param sessionId - 会话 id
 * @param agentId - Agent id
 * @param at - 起始时间戳
 * @returns runId
 */
export function createRunId(sessionId: string, agentId: string, at: number = Date.now()): string {
  runIdSeq += 1;
  return `run_${at.toString(36)}_${runIdSeq.toString(36)}_${sessionId}_${agentId}`;
}

const runScopeStorage = new AsyncLocalStorage<RunScope>();

/**
 * 在 RunScope 上下文中驱动 generator（每步 next 进入同一 store）
 *
 * @param scope - 本 run 的作用域身份
 * @param gen - 事件流
 * @yields 原 generator 事件
 */
export async function* withRunScope<T>(
  scope: RunScope,
  gen: AsyncGenerator<T>,
): AsyncGenerator<T> {
  while (true) {
    const result = await runScopeStorage.run(scope, () => gen.next());
    if (result.done) {
      return result.value;
    }
    yield result.value;
  }
}

/**
 * 读取当前 RunScope
 *
 * @returns 当前作用域；不在 run 中时 undefined
 */
export function getRunScope(): RunScope | undefined {
  return runScopeStorage.getStore();
}

/**
 * 读取当前 run 的 sessionId
 *
 * @param fallback - 无 ALS 时的回退（如 Agent.contextSessionId）
 * @returns sessionId
 */
export function getRunSessionId(fallback?: string): string | undefined {
  return runScopeStorage.getStore()?.sessionId ?? fallback;
}
