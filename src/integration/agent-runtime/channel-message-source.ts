/**
 * ChannelMessageSource — Integration 适配
 *
 * 将 ChannelMessage 转为 Trigger 并 dispatch。
 * 协议解耦在 Integration；Harness 只见 Trigger（arch/agent-runtime.md）。
 */

import { randomUUID } from 'node:crypto';
import type { ChannelMessage } from '../types/channels.js';
import type { AgentRuntime } from '../../harness/agent-runtime/runtime.js';
import type { Trigger } from '../../harness/agent-runtime/types.js';

export interface ChannelMessageSourceOptions {
  runtime: AgentRuntime;
  /** ChannelMessage → agentId；必填 */
  resolveAgentId: (msg: ChannelMessage) => string | undefined;
  /** ChannelMessage → sessionId */
  resolveSessionId: (msg: ChannelMessage) => string;
}

export function channelMessageToTrigger(
  msg: ChannelMessage,
  agentId: string,
  sessionId: string,
): Trigger {
  const modelOverride = msg.metadata?.model;
  return {
    id: `trg-${randomUUID().slice(0, 12)}`,
    type: 'message',
    agentId,
    sessionId,
    timestamp: msg.timestamp,
    payload: {
      kind: 'user_message',
      content: msg.content,
      source: {
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        messageId: msg.id,
        conversationId: msg.conversationId,
      },
    },
    metadata: {
      source: `channel:${msg.channel}`,
      reason: 'channel_message',
      ...(modelOverride
        ? {
            modelOverride: String(modelOverride),
            ...(msg.metadata?.modelProvider
              ? { modelProvider: String(msg.metadata.modelProvider) }
              : {}),
          }
        : {}),
    },
  };
}

/**
 * dispatch 一条通道消息（模型 A：await 至 Run 结束）。
 * onEvent 用于 Gateway 流式广播 / 捕获最终回复。
 */
export async function dispatchChannelMessage(
  options: ChannelMessageSourceOptions & {
    msg: ChannelMessage;
    onEvent?: Parameters<AgentRuntime['dispatch']>[1] extends infer O
      ? O extends { onEvent?: infer F }
        ? F
        : never
      : never;
  },
): Promise<ReturnType<AgentRuntime['dispatch']>> {
  const { runtime, msg, resolveAgentId, resolveSessionId, onEvent } = options;
  const agentId = resolveAgentId(msg);
  if (!agentId) {
    return { status: 'skipped', reason: 'no_agent' as const };
  }
  const sessionId = resolveSessionId(msg);
  const trigger = channelMessageToTrigger(msg, agentId, sessionId);
  return runtime.dispatch(trigger, onEvent ? { onEvent } : undefined);
}
