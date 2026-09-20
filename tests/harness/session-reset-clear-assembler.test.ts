/**
 * clearSession 接线：会话 daily/idle 重置时清理 Assembler 指纹
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentBuilder } from '../../src/harness/agent-building/builder.js';
import type { ModelProvider } from '../../src/core/interfaces/model-provider.js';
import type { Message } from '../../src/core/types.js';
import type { SessionData } from '../../src/harness/session-types.js';
import type { SessionStore } from '../../src/core/interfaces/session-store.js';

function mockProvider(): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat() {
      return { content: 'ok', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() { return true; },
    getModelInfo() {
      return { name: 'm', contextWindow: 8000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 8000 }];
    },
  };
}

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('session reset → clearSession', () => {
  it('idle 超时后重置会话会清掉 fingerprint 与 contextCompact', async () => {
    const sessions = new Map<string, SessionData>();
    const oldTs = Date.now() - 3 * 60 * 60 * 1000; // 3h 前
    sessions.set('s-idle', {
      id: 's-idle',
      agentId: 'default',
      meta: {
        id: 's-idle',
        agentId: 'default',
        channelId: 'test',
        peerId: 'p',
        status: 'idle',
        createdAt: oldTs,
        updatedAt: oldTs,
        lastInteractionAt: oldTs,
        sessionStartedAt: oldTs,
      },
      messages: [userMsg('old')],
      turns: [],
      metadata: {},
      contextCompact: {
        summary: '[Conversation Summary]\n\nold',
        lastProactiveMessageCount: 5,
      },
    });

    const store: SessionStore<SessionData> = {
      async load(_a: string, id: string) {
        return sessions.get(id) ?? null;
      },
      async save(_a: string, id: string, data: SessionData) {
        sessions.set(id, JSON.parse(JSON.stringify(data)) as SessionData);
      },
      async delete(_a: string, id: string) {
        sessions.delete(id);
      },
      async list(agentId: string) {
        return [...sessions.values()].filter((s) => s.agentId === agentId).map((s) => s.meta);
      },
      async exists(_a: string, id: string) {
        return sessions.has(id);
      },
    };

    const { runner, agent } = await new AgentBuilder()
      .model(mockProvider())
      .store(store)
      .build();

    // 预置 agent 侧压缩状态
    agent.setSessionCompactState('s-idle', 'default', {
      summary: '[Conversation Summary]\n\nold',
      lastProactiveMessageCount: 5,
    });

    // spy clearSession（build 已挂；再包一层验证调用）
    const clearSpy = vi.fn();
    runner.setSystemPromptAssembler(
      async () => ({ systemPrompt: 'p' }),
      (sid) => {
        clearSpy(sid);
        agent.setSessionCompactState(sid, 'default', undefined);
      },
    );

    for await (const ev of runner.handle('s-idle', userMsg('hi'), {
      systemPrompt: '',
      agentId: 'default',
      sessionId: 's-idle',
      // idleExpiry 默认 2h，预置 lastInteractionAt 为 3h 前 → 会重置
    })) {
      if (ev.type === 'engine.end' || ev.type === 'engine.error') break;
    }

    expect(clearSpy).toHaveBeenCalledWith('s-idle');
    expect(agent.getSessionCompactState('s-idle', 'default')).toBeUndefined();
  });
});
