/**
 * ExplicitRouter — v1 显式路由
 *
 * 只认 trigger.agentId / toAgents；单 Agent 场景可配 fallbackAgentId。
 * 不做 capability 发现（Router v2）。
 */

import type { AgentRouter, RouteTarget, RuntimeAgent, Trigger } from './types.js';

export interface ExplicitRouterConfig {
  /** 未指定 agentId 时的 fallback（单 Agent 嵌入场景） */
  fallbackAgentId?: string;
}

export class ExplicitRouter implements AgentRouter {
  constructor(private readonly config: ExplicitRouterConfig = {}) {}

  async resolve(
    trigger: Trigger,
    agents: ReadonlyMap<string, RuntimeAgent>,
  ): Promise<RouteTarget[]> {
    if (trigger.toAgents && trigger.toAgents.length > 0) {
      return trigger.toAgents
        .filter((id) => agents.has(id))
        .map((agentId) => ({ agentId, sessionId: trigger.sessionId }));
    }

    if (trigger.agentId) {
      if (!agents.has(trigger.agentId)) return [];
      return [{ agentId: trigger.agentId, sessionId: trigger.sessionId }];
    }

    if (this.config.fallbackAgentId && agents.has(this.config.fallbackAgentId)) {
      return [{ agentId: this.config.fallbackAgentId, sessionId: trigger.sessionId }];
    }

    return [];
  }
}
