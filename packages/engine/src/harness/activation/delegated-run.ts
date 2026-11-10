/**
 * delegated-run — 委派子 run 的执行腿适配（arch/service-topology.md §9.5 S1 收口）。
 *
 * attach / child-run 不持裸 runner：RunnerChildRunPort 调的 `handle()` 经
 * RunRequest → host.startRun（准入闸门 + in-flight 计数 + abort 判据 + 退役可见），
 * 不再直连 SessionAwareRunner.handle。与 SessionRunnerDispatcher（RunRequest →
 * runner.handle）互为正反映射。
 */

import { randomUUID } from 'node:crypto';
import type { Message } from '@octopi-agent/core/types.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { RunRequest, Trigger } from './types.js';
import type { RunConfig } from '../run/runner.js';

/** 执行腿依赖面（RunHost 结构子集：get / ensureMounted / startRun + 定义查询） */
export interface DelegatedLegDeps {
  /** 挂载查询：已挂载返回真值 */
  get(agentId: string): unknown;
  /** get-or-mount（B1 单飞语义在 host 内） */
  ensureMounted(agentId: string, definition: Record<string, unknown>): Promise<unknown>;
  /** 契约执行入口（startRun：准入 + in-flight + abort） */
  startRun(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  /** 目标 agent 定义查询；undefined = 不可委派 */
  getDefinition(agentId: string): Record<string, unknown> | undefined;
}

/**
 * 构造委派子 run 的 RunRequest（纯映射）。
 * D3 天花板随 req 透传，由 Runner 与模板天花板取交集（只能收紧）。
 *
 * @param sessionId - 子会话 id（D7 预创建，含 spawnBy）
 * @param input - RunnerChildRunPort 交给 handle 的用户输入
 * @param runConfig - 子 run 配置（systemPrompt / rightsCeiling / model）
 * @returns 契约 RunRequest
 * @throws runConfig.agentId 缺失（委派执行腿必有目标）
 */
export function buildDelegatedRunRequest(
  sessionId: string,
  input: Message,
  runConfig: RunConfig,
): RunRequest {
  const agentId = runConfig.agentId;
  if (!agentId) {
    throw new Error('delegate child run requires runConfig.agentId');
  }
  const text =
    typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? '');
  const trigger: Trigger = {
    id: `child-${randomUUID()}`,
    type: 'message',
    agentId,
    sessionId,
    timestamp: Date.now(),
    payload: { kind: 'user_message', content: text },
  };
  return {
    requestId: `child-${randomUUID()}`,
    triggers: [trigger],
    agentId,
    sessionId,
    messages: [input],
    actorType: 'agent',
    ...(runConfig.model === undefined ? {} : { modelOverride: runConfig.model }),
    ...(runConfig.modelProvider === undefined ? {} : { modelProvider: runConfig.modelProvider }),
    ...(runConfig.systemPrompt === undefined ? {} : { systemPrompt: runConfig.systemPrompt }),
    ...(runConfig.rightsCeiling === undefined ? {} : { rightsCeiling: runConfig.rightsCeiling }),
  };
}

/**
 * 委派子 run 的执行腿 handle（SessionAwareRunner.handle 的结构替代面）。
 * 目标未挂载即 get-or-mount（/runs 同语义）；缺定义 fail-loud。
 *
 * @param deps - 执行腿依赖面
 * @returns handle(sessionId, input, runConfig, signal) 事件流
 */
export function createDelegatedLegHandle(
  deps: DelegatedLegDeps,
): (
  sessionId: string,
  input: Message,
  runConfig: RunConfig,
  signal?: AbortSignal,
) => AsyncGenerator<AgentEvent> {
  return (sessionId, input, runConfig, signal) =>
    (async function* (): AsyncGenerator<AgentEvent> {
      const agentId = runConfig.agentId;
      if (!agentId) {
        throw new Error('delegate child run requires runConfig.agentId');
      }
      const def = deps.getDefinition(agentId);
      if (!def) {
        throw new Error(`delegate target not runnable: ${agentId}`);
      }
      if (!deps.get(agentId)) {
        await deps.ensureMounted(agentId, def);
      }
      yield* deps.startRun(buildDelegatedRunRequest(sessionId, input, runConfig), signal);
    })();
}
