/**
 * 委派编排的生产接线
 *
 * @layer harness/collaboration/delegation
 * 设计权威：`arch/delegation.md` §7 / §14。
 *
 * 把 `DelegateService` + 4 个 `delegate_*` 工具 + notify 通道 + 状态提示
 * 接到 agent 上。**显式依赖注入**，不隐式假设共享总线。
 *
 * 两种形态：
 * - {@link createDelegationRuntime} — 可增量 `attach`，适配 Gateway 的**惰性构建**
 * - {@link wireDelegation} — 批量一次接完，适配 `buildFromConfig`
 *
 * 关键依赖约束：
 * - **notify 总线必须与 `AgentSignalSource` 监听的是同一条**
 *   （`arch/agent-runtime.md`）。Gateway 路径天然满足（所有 agent 共享
 *   `gatewayBus`）；库嵌入需自行传共享总线，否则 notify 静默失联（poll 仍可用）。
 * - `RunnerChildRunPort.resolve` 是**惰性**的，因此服务可先建、
 *   agent 后 attach，不存在循环依赖。
 */

import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { RegisteredTool } from '@octopi-agent/core/types.js';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';
import type { SessionData } from '../../session/types.js';
import type { Agent } from '../../run/agent/index.js';
import type { SessionAwareRunner } from '../../run/runner.js';
import type { AgentDelegationPolicy, AgentRegistry } from './registry-types.js';
import { effectiveDelegationPolicy } from './registry-types.js';
import { DefaultAgentRegistry } from './registry.js';
import { DelegationStore } from './store.js';
import { DelegateService } from './service.js';
import { InProcessTransport } from './transport.js';
import {
  RunnerChildRunPort,
  createChildRunExecutor,
} from './child-run.js';
import { createDelegationNotifier } from './notifier.js';
import { createDelegationTools } from '../../extension/plugin-ecosystem/tools/delegation.js';

// 供 Gateway / 组装层经同一入口取生效策略
export {
  DEFAULT_DELEGATION_POLICY,
  effectiveDelegationPolicy,
} from './registry-types.js';

/** 参与委派的一个 agent 的运行时 */
export interface DelegatableAgent {
  agentId: string;
  agent: Agent;
  runner: SessionAwareRunner;
  /**
   * 该 agent 的 SessionStore。
   *
   * 必须与 `runner.handle()` 读的是同一个 store，否则预创建的 child session
   * （带 `spawnBy`，D7）对子 Run 不可见。
   */
  store: SessionStore<SessionData>;
  /** 特质标签（`AgentConfig.traits`） */
  traits?: string[];
  /** 委派策略（`AgentConfig.delegation`） */
  delegation?: AgentDelegationPolicy;
  /** persona（进子的 systemPrompt） */
  persona?: string;
  /**
   * 工具注册入口。
   *
   * `RegisteredTool` 须经 `convertToAgentTool` 转成 `AgentTool` 后注册，
   * 且要同步 SecurityGuard 的未注册工具硬边界名单；故由组装层
   * （`AgentBuildResult.registerTools` / Gateway）注入，本模块不触碰 builder 内部。
   * 缺省 = 不挂工具（服务仍可用，poll 通道不受影响）。
   */
  registerTools?: (tools: RegisteredTool[]) => void;
}

/** `createDelegationRuntime` 配置 */
export interface DelegationRuntimeOptions {
  /**
   * notify 用事件总线；须与 `AgentSignalSource` 监听的同一条。
   * Gateway 路径天然满足（共享 `gatewayBus`）；缺省 = **不接线 notify**（poll 仍可用）。
   */
  events?: EventBus;
  /** 单父 session 未闭合委派上限（失控防护，§8） */
  maxActiveDelegationsPerSession?: number;
}

/** 委派编排运行时 */
export interface DelegationRuntime {
  service: DelegateService;
  registry: AgentRegistry;
  delegationStore: DelegationStore;
  /** 是否已接 notify 通道 */
  notifyWired: boolean;
  /** 已挂载的 agentId */
  readonly attached: readonly string[];
  /**
   * 挂载一个 agent（幂等：同 agentId 重复调用只生效一次）。
   *
   * 只有 `delegation.canDelegate` 的 agent 才挂 `delegate_*` 工具与状态提示；
   * 其余 agent 仅登记进 Registry 供被委派。
   */
  attach(agent: DelegatableAgent): void;
}

/**
 * 创建可增量挂载的委派运行时
 *
 * @param options - 总线 / store / 限额
 * @returns 委派运行时
 */
export function createDelegationRuntime(
  options: DelegationRuntimeOptions,
): DelegationRuntime {
  const registry = new DefaultAgentRegistry();
  const byId = new Map<string, DelegatableAgent>();

  const childRunPort = new RunnerChildRunPort({
    resolve: (agentId) => {
      const a = byId.get(agentId);
      return a ? { runner: a.runner, store: a.store } : undefined;
    },
  });

  const personaOf = (agentId: string): string => byId.get(agentId)?.persona ?? '';
  const transport = new InProcessTransport(
    createChildRunExecutor(childRunPort, { persona: '' }, personaOf),
  );

  const delegationStore = new DelegationStore(options.events);
  const notifyWired = Boolean(options.events);

  const service = new DelegateService(delegationStore, registry, transport, {
    maxActiveDelegationsPerSession: options.maxActiveDelegationsPerSession,
    notifier: options.events ? createDelegationNotifier({ events: options.events }) : undefined,
    // 父 session 深度：子 session 的深度 = 创建它的那张委派单的 depth（§10.4，权威查询）
    resolveParentDepth: (sessionId) => delegationStore.findDepthByChildSession(sessionId) ?? 0,
  });

  const delegateTools = createDelegationTools(service);
  const attached = new Set<string>();

  const runtime: DelegationRuntime = {
    service,
    registry,
    delegationStore,
    notifyWired,
    get attached() {
      return [...attached];
    },
    attach(agent: DelegatableAgent): void {
      if (attached.has(agent.agentId)) return;
      attached.add(agent.agentId);
      byId.set(agent.agentId, agent);

      registry.register({
        id: agent.agentId,
        name: agent.agentId,
        traits: agent.traits ?? [],
        delegation: effectiveDelegationPolicy(agent.delegation),
        status: 'idle',
      });

      // delegate_* 工具只挂给能委派的 agent（§9.3 命名委派）
      if (effectiveDelegationPolicy(agent.delegation).canDelegate) {
        agent.registerTools?.(delegateTools);

        // §7.3：长 Run 每轮可见的委派状态提示。
        // 经 RunScope ALS 取**本 Run** 的 sessionId，避免共享 Agent 实例串味（I1）。
        agent.agent.setSteeringMessages(async () => {
          const { getRunSessionId } = await import('../../run/run-scope.js');
          const sessionId = getRunSessionId(agent.agent.contextSessionId);
          if (!sessionId) return [];
          const hint = service.renderStatusHint(sessionId);
          return hint
            ? [{ role: 'system' as const, content: hint, timestamp: Date.now() }]
            : [];
        });
      }
    },
  };

  return runtime;
}

/**
 * 给一组建好的 agent 批量接上委派编排
 *
 * @param agents - 参与委派的 agent
 * @param options - 总线 / store / 限额
 * @returns 委派编排组件；无任何 agent 可委派时返回 undefined
 */
export function wireDelegation(
  agents: DelegatableAgent[],
  options: DelegationRuntimeOptions,
): DelegationRuntime | undefined {
  // 缺省默认可委派（arch/delegation.md §9.2）：只有全部显式关闭才不接线
  const canDelegateAny = agents.some(
    (a) => effectiveDelegationPolicy(a.delegation).canDelegate,
  );
  if (!canDelegateAny) return undefined;

  const runtime = createDelegationRuntime(options);
  for (const a of agents) runtime.attach(a);
  return runtime;
}
