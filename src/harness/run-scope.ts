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

/** 工具执行时可见的 Run 运行时上下文 */
export interface RunToolRuntime {
  sessionId: string;
  agentId: string;
  messages: Message[];
  /** 工具 cwd（通常来自 agent.workspace / 宿主注入） */
  cwd?: string;
}

/** 一次 Run 的作用域身份（I1） */
export interface RunScope {
  sessionId: string;
  agentId: string;
  /** 本轮 systemPrompt 装配结果；供 convertToLlm / 层装配 */
  systemPrompt?: string;
  /** 工具运行时上下文；缺省时由 Provider 回退 */
  toolRuntime?: RunToolRuntime;
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
