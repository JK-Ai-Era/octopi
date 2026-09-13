/**
 * Compiler — Trigger → Message
 *
 * 不伪装真人用户；runtime 注入的 user 消息带 metadata.source。
 */

import { randomUUID } from 'node:crypto';
import type { Message } from '../../core/types.js';
import type { RunRequest, RuntimeAgent, Trigger } from './types.js';

export function resolveSessionId(agent: RuntimeAgent, trigger: Trigger): string {
  if (agent.resolveSession) return agent.resolveSession(trigger);
  if (trigger.sessionId) return trigger.sessionId;
  return `${agent.agentId}:main`;
}

export function compileMessages(triggers: Trigger[]): Message[] {
  return triggers.map((t) => compileOne(t));
}

function compileOne(trigger: Trigger): Message {
  const timestamp = trigger.timestamp ?? Date.now();
  const isChannelUser =
    trigger.type === 'message' && trigger.payload.kind === 'user_message';

  const metadata = {
    triggerId: trigger.id,
    triggerType: trigger.type,
    // 真人通道消息不打 runtime 标记，避免下游误判
    ...(isChannelUser ? {} : { source: 'runtime' }),
    ...(trigger.metadata?.source ? { origin: trigger.metadata.source } : {}),
    ...(trigger.metadata?.parentAgentId
      ? { parentAgentId: trigger.metadata.parentAgentId }
      : {}),
  };

  const base = { timestamp, metadata };

  switch (trigger.payload.kind) {
    case 'user_message':
      return {
        role: 'user',
        content: trigger.payload.content,
        source: trigger.payload.source,
        ...base,
      } as Message;
    case 'system_note':
      return {
        role: 'user',
        content: trigger.payload.content,
        ...base,
      } as Message;
    case 'structured':
      return {
        role: 'user',
        content: JSON.stringify(trigger.payload.data),
        ...base,
      } as Message;
    default:
      return {
        role: 'user',
        content: '',
        ...base,
      } as Message;
  }
}

export function buildRunRequest(
  agent: RuntimeAgent,
  triggers: Trigger[],
  sessionId: string,
): RunRequest {
  return {
    requestId: randomUUID(),
    triggers,
    agentId: agent.agentId,
    sessionId,
    messages: compileMessages(triggers),
  };
}
