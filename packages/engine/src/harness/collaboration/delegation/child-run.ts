/**
 * ChildRunPort — 子 Run 执行端口
 *
 * @layer harness/collaboration/delegation
 * 设计权威：`arch/delegation.md` §10。
 *
 * 职责：把一个 `DelegateRequest` 变成一次**真实受监督的子 Run**，产出 `ChildRunOutput`。
 *
 * 不变量落点：
 * - **D7** 子 Run 落**独立 Session**，带 `spawnBy` 父子关联（`SessionSpawnLink`）
 * - **D8** 子 Run 走 `SessionAwareRunner.handle()` —— 该入口自带
 *   per-run `AgentContext` + `RunScope` + session 锁 + SessionGate + ACL，
 *   因此**绝不写 `agent.context.messages`**（旧 multi-agent 路径的 I1 违规）
 * - **D9** 并发硬闸仍只在 SessionGate 一处（委派层不建第二把闸）
 *
 * 与 transport 的分工：
 * transport 管"怎么把请求送到目标"（进程内 / 将来跨进程）；
 * 本端口管"目标本地怎么起 Run"。两者不可互相渗透。
 */

import { randomUUID } from 'node:crypto';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';
import type { TokenUsage } from '@octopi-agent/core/types/turn.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { SessionData, SessionSpawnLink } from '../../session/types.js';
import type { DelegationBudget, DelegationContextMode } from './types.js';
import { emptyTokenUsage } from '@octopi-agent/core/types/turn.js';

// ── 端口形状 ──

/** 子 Run 入参 */
export interface ChildRunInput {
  delegationId: string;
  /** 目标 agentId（已解析） */
  childAgentId: string;
  task: string;
  input: string;
  /** 上下文传递模式 */
  context: DelegationContextMode;
  /** 父消息历史（仅 context='fork' 时携带）；调用方传快照 */
  parentMessages?: import('@octopi-agent/core/types.js').Message[];
  /** 父子关联（写入 child session 的 `spawnBy`，D7） */
  spawnBy: SessionSpawnLink;
  /**
   * 子 Session / Run ID（D7）。
   *
   * 由服务方在起子 Run **之前**生成并落库——否则子 Run 期间发起的孙代委派
   * 查不到 `childSessionId`，递归深度闸（§10.4）会失效。
   */
  childSessionId: string;
  childRunId: string;
  /** 子的 systemPrompt（模板 persona + 编排指令，§9.4） */
  systemPrompt: string;
  budget?: DelegationBudget;
  /** 权利天花板（D3：只能收紧不能放宽）；进 `RunConfig.rightsCeiling` */
  rightsCeiling?: import('../../governance/session-acl/types.js').SessionRights;
}

/** 子 Run 产出（D5：可序列化） */
export interface ChildRunOutput {
  childSessionId: string;
  childRunId: string;
  output?: string;
  /** 产物路径；未产出时**省略**（不写假空数组） */
  artifacts?: string[];
  usage?: TokenUsage;
  error?: string;
  /** 是否被中止（cascade / cancel）——用于把结果映射为 `cancelled` 而非 `failed` */
  aborted?: boolean;
}

/**
 * 子 Run 执行端口
 */
export interface ChildRunPort {
  /**
   * 起一次受监督的子 Run
   *
   * @param input - 子 Run 入参
   * @param signal - 中止信号（D4 的本地投影）
   * @returns 子 Run 产出
   */
  run(input: ChildRunInput, signal?: AbortSignal): Promise<ChildRunOutput>;
}

// ── Runner 实现 ──

/** 目标 agent 的运行时句柄 */
export interface ChildRunTarget {
  /** 该 agent 的 SessionAwareRunner（自带 harness / ACL / SessionGate） */
  runner: {
    handle(
      sessionId: string,
      input: import('@octopi-agent/core/types.js').Message,
      runConfig: import('../../run/runner.js').RunConfig,
      signal?: AbortSignal,
    ): AsyncGenerator<AgentEvent>;
  };
  /**
   * 该 agent 的 SessionStore。
   *
   * 必须与 `runner.handle()` 读的是**同一个** store，否则预创建的 child session
   * （带 `spawnBy`，D7）对子 Run 不可见。
   */
  store: SessionStore<SessionData>;
}

/** RunnerChildRunPort 配置 */
export interface RunnerChildRunPortConfig {
  /** 解析 agentId → 运行时句柄；返回 undefined 表示目标不可运行 */
  resolve(agentId: string): ChildRunTarget | undefined;
}

/**
 * 累加 turn 级 usage 到总账（决策 C2：归集到父的 run 账）
 *
 * @param total - 累计账本（原地更新）
 * @param add - 本轮 usage
 */
function addUsage(total: TokenUsage, add: TokenUsage | undefined): void {
  if (!add) return;
  total.outputTokens += add.outputTokens ?? 0;
  total.inputUncachedTokens += add.inputUncachedTokens ?? 0;
  total.inputCachedTokens += add.inputCachedTokens ?? 0;
  total.inputCacheWriteTokens += add.inputCacheWriteTokens ?? 0;
  if (add.inputReportedTokens != null) {
    total.inputReportedTokens = (total.inputReportedTokens ?? 0) + add.inputReportedTokens;
  }
  if (add.cacheAware) total.cacheAware = true;
}

/**
 * RunnerChildRunPort — 以 `SessionAwareRunner.handle()` 起子 Run
 *
 * 保证 D7/D8/D9：独立 session、per-run 上下文、并发闸仍只在 SessionGate。
 */
export class RunnerChildRunPort implements ChildRunPort {
  /**
   * @param config - 目标解析与 session 存储
   */
  constructor(private readonly config: RunnerChildRunPortConfig) {}

  /**
   * 起一次受监督的子 Run
   *
   * @param input - 子 Run 入参
   * @param signal - 中止信号
   * @returns 子 Run 产出
   * @throws 目标不可运行，或 session 预创建失败
   */
  async run(input: ChildRunInput, signal?: AbortSignal): Promise<ChildRunOutput> {
    const target = this.config.resolve(input.childAgentId);
    if (!target) {
      throw new Error(`delegate target not runnable: ${input.childAgentId}`);
    }

    // id 由服务方在起 Run 前生成并落库（D7）；此处只消费，不生成
    const childSessionId = input.childSessionId;
    const childRunId = input.childRunId;

    // D7：预创建 child session 并写入父子关联。
    // 随后 `handle()` 会 load 到本 session（而非 createSession），spawnBy 得以保留。
    await target.store.save(childSessionId, this.newChildSession(childSessionId, input));

    const userText = input.context === 'fork' && input.parentMessages?.length
      ? `${renderForkHeader(input.parentMessages)}\n\n${input.task}\n\n${input.input}`
      : `${input.task}\n\n${input.input}`;

    const userMessage: import('@octopi-agent/core/types.js').Message = {
      role: 'user',
      content: userText,
      timestamp: Date.now(),
    };

    const runConfig: import('../../run/runner.js').RunConfig = {
      systemPrompt: input.systemPrompt,
      agentId: input.childAgentId,
      sessionId: childSessionId,
      // D3：委派权利天花板，Runner 会与模板天花板取交集
      rightsCeiling: input.rightsCeiling,
    };

    const usage = emptyTokenUsage();
    let output: string | undefined;
    let error: string | undefined;
    let aborted = false;
    const artifacts: string[] = [];

    try {
      for await (const event of target.runner.handle(childSessionId, userMessage, runConfig, signal)) {
        switch (event.type) {
          case 'turn.end': {
            const data = event.data as {
              content?: unknown;
              usage?: TokenUsage;
              error?: unknown;
            };
            // 失败尝试的 content 是中断残句，不是委派结果；error 布尔标记也不是错误文本
            //（String(true)='true' 会占位并挡住后面 engine.error 的真消息）
            const failed = Boolean(data.error);
            if (!failed && typeof data.content === 'string' && data.content.length > 0) {
              output = data.content;
            }
            addUsage(usage, data.usage);
            if (error == null) {
              if (data.error instanceof Error) error = data.error.message;
              else if (typeof data.error === 'string' && data.error.length > 0) error = data.error;
            }
            break;
          }
          case 'engine.error': {
            const data = event.data as { error?: unknown };
            const message =
              data.error instanceof Error ? data.error.message : String(data.error ?? 'unknown error');
            error = message;
            break;
          }
          case 'engine.end': {
            // 非 signal.aborted 触发的 aborted（loop 检测到取消）也要如实归中止，
            // 不得走 default 当成功
            const data = event.data as { reason?: unknown };
            if (data.reason === 'aborted') aborted = true;
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (signal?.aborted) aborted = true;

    const finalError = aborted ? (error ?? 'aborted') : error;
    return {
      childSessionId,
      childRunId,
      // 失败/中止不出 output：前一轮成功正文或残句不得冒充「已交付结果」
      ...(finalError ? {} : { output }),
      ...(artifacts.length > 0 ? { artifacts } : {}),
      usage,
      error: finalError,
      aborted,
    };
  }

  /** 构造带 `spawnBy` 的 child session 骨架 */
  private newChildSession(sessionId: string, input: ChildRunInput): SessionData {
    const timestamp = Date.now();
    return {
      id: sessionId,
      agentId: input.childAgentId,
      primaryAgentId: input.childAgentId,
      spawnBy: { ...input.spawnBy },
      meta: {
        title: `delegation: ${input.task}`.slice(0, 120),
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'idle',
      } as SessionData['meta'],
      messages: [],
      turns: [],
      metadata: { delegationId: input.delegationId },
    };
  }
}

/**
 * 渲染 fork 模式的父历史前缀（§9.4：显式 `context: 'fork'` 才继承）
 *
 * @param parentMessages - 父消息历史（只取可序列化文本）
 * @returns 前缀文本
 */
function renderForkHeader(parentMessages: unknown[]): string {
  const lines = parentMessages.map((m) => {
    const msg = m as { role?: unknown; content?: unknown };
    const role = typeof msg?.role === 'string' ? msg.role : 'unknown';
    const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? '');
    return `- [${role}] ${content}`;
  });
  return [
    '[Context Fork] 以下是从父会话分叉的上下文，供你理解任务背景：',
    ...lines,
  ].join('\n');
}

// ── 胶水：ChildRunPort → LocalDelegateExecutor ──

/** 委派指令片段（§9.4：模板 persona + 编排指令） */
export interface DelegationPromptOptions {
  /** 子 agent 的 persona（来自 `AgentConfig.persona`） */
  persona: string;
  /** 附加编排指令（缺省用 `DEFAULT_DELEGATION_DIRECTIVE`） */
  directive?: string;
}

/** 缺省编排指令 */
export const DEFAULT_DELEGATION_DIRECTIVE =
  'You are being delegated a task by a parent agent. ' +
  'Work the task independently and end your run with a concise conclusion as your final message. ' +
  'Do not wait for further instructions.';

/**
 * 构造子的 systemPrompt（§9.4）
 *
 * @param options - persona 与编排指令
 * @param parentAgentId - 父 agentId（进指令文本）
 * @returns systemPrompt 文本
 */
export function buildChildSystemPrompt(
  options: DelegationPromptOptions,
  parentAgentId: string,
): string {
  const directive = options.directive ?? DEFAULT_DELEGATION_DIRECTIVE;
  return [options.persona, directive, `Delegating parent: ${parentAgentId}`]
    .filter((s) => s && s.length > 0)
    .join('\n\n');
}

/**
 * 把 `ChildRunPort` 适配成 `LocalDelegateExecutor`（供 `InProcessTransport` 使用）
 *
 * @param port - 子 Run 执行端口
 * @param options - systemPrompt 构造选项
 * @param resolvePersona - 从 childAgentId 取 persona（缺省取空串）
 * @returns transport 可用的执行器
 */
export function createChildRunExecutor(
  port: ChildRunPort,
  options: DelegationPromptOptions,
  resolvePersona?: (childAgentId: string) => string,
): import('./transport.js').LocalDelegateExecutor {
  return async (request, signal) => {
    const childAgentId = request.to.agentId;
    if (!childAgentId) {
      return {
        delegationId: request.delegationId,
        status: 'failed',
        error: 'delegate_request: unresolved target agentId',
        schemaVersion: request.schemaVersion,
      };
    }

    const persona = resolvePersona?.(childAgentId) ?? options.persona;
    const systemPrompt = buildChildSystemPrompt(
      { persona, directive: options.directive },
      request.from.agentId,
    );

    const output = await port.run(
      {
        delegationId: request.delegationId,
        childAgentId,
        // D7：id 由服务方在起 Run 前生成并落库，此处透传
        childSessionId: request.childSessionId,
        childRunId: request.childRunId,
        task: request.task,
        input: request.input,
        context: request.context,
        parentMessages: request.parentMessages,
        spawnBy: {
          delegationId: request.delegationId,
          parentAgentId: request.from.agentId,
          parentSessionId: request.from.sessionId,
          parentRunId: request.from.runId,
        },
        systemPrompt,
        budget: request.budget,
        rightsCeiling: request.rightsCeiling,
      },
      signal,
    );

    return {
      delegationId: request.delegationId,
      // 中止 ≠ 失败：cascade / cancel 落 cancelled，其余失败落 failed（补-2）
      status: output.aborted ? 'cancelled' : output.error ? 'failed' : 'completed',
      childSessionId: output.childSessionId,
      childRunId: output.childRunId,
      output: output.output,
      artifacts: output.artifacts,
      usage: output.usage,
      error: output.error,
      schemaVersion: request.schemaVersion,
    };
  };
}
