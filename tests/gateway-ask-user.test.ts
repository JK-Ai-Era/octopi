/**
 * Gateway ask_user pending questions
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from '../src/integration/gateway/gateway.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';
import type { AgentDefinition } from '../src/harness/shared/types/agent-definition.js';
import { InMemorySessionStore } from '../src/integration/storage/memory.js';

function makeProvider(): ModelProvider {
  return {
    name: 'openai',
    defaultModel: 'gpt-5-mini',
    getModelInfo: (m: string) => ({ name: m }),
    getModelInfos: () => [{ name: 'gpt-5-mini' }],
    isAvailable: async () => true,
    chat: async () => ({ content: '', model: 'gpt-5-mini', finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  };
}

function makeAgent(id: string): AgentDefinition {
  return {
    id,
    home: '',
    workspace: '',
    persona: { name: id, description: '', systemPrompt: 'test' },
    tools: { allow: ['*'] },
    model: { provider: 'openai', model: 'gpt-5-mini' },
  };
}

describe('Gateway ask_user questions', () => {
  let gateway: Gateway;

  beforeEach(async () => {
    gateway = new Gateway({ agents: [makeAgent('assistant')] }, new InMemorySessionStore());
    gateway.registerProvider(makeProvider());
    await gateway.start();
  });

  it('askUser → pending → resolve with answer', async () => {
    const pending = gateway.askUser({
      sessionId: 's1',
      agentId: 'assistant',
      question: 'Which option?',
      options: ['A', 'B'],
    });

    const list = gateway.listPendingQuestions('s1');
    expect(list).toHaveLength(1);
    expect(list[0]!.question).toBe('Which option?');
    expect(list[0]!.status).toBe('pending');

    const resolved = gateway.resolvePendingQuestion(list[0]!.id, { answer: 'A' });
    expect(resolved?.status).toBe('answered');
    expect(resolved?.answer).toBe('A');

    await expect(pending).resolves.toBe('A');
    expect(gateway.listPendingQuestions('s1')).toHaveLength(1);
    expect(gateway.listPendingQuestions('s1')[0]!.status).toBe('answered');
  });

  it('cancelPendingQuestions marks cancelled and wakes waiter with sentinel', async () => {
    const pending = gateway.askUser({
      sessionId: 's2',
      agentId: 'assistant',
      question: 'Confirm?',
    });

    gateway.cancelPendingQuestions('s2');
    await expect(pending).resolves.toBe('__ask_user_cancelled__');
    const q = gateway.listPendingQuestions('s2')[0]!;
    expect(q.status).toBe('cancelled');
    expect(q.decidedAt).toBeGreaterThan(0);
  });

  it('resolvePendingQuestion on missing or already answered returns null', () => {
    expect(gateway.resolvePendingQuestion('nope', { answer: 'x' })).toBeNull();

    gateway.askUser({ sessionId: 's3', agentId: 'assistant', question: 'Q' });
    const q = gateway.listPendingQuestions('s3')[0]!;
    expect(gateway.resolvePendingQuestion(q.id, { answer: 'ok' })).not.toBeNull();
    expect(gateway.resolvePendingQuestion(q.id, { answer: 'again' })).toBeNull();
    expect(gateway.resolvePendingQuestion(q.id, { answer: 'x' })).toBeNull();
  });

  it('sync answer during ask_user.pending broadcast does not deadlock', async () => {
    const events: string[] = [];
    gateway.on((ev) => {
      events.push(ev.type);
      const data = ev.data as { question?: { id?: string; status?: string } } | undefined;
      if (ev.type === 'ask_user.pending' && data?.question?.id) {
        // 模拟监听器同步作答
        gateway.resolvePendingQuestion(data.question.id, { answer: 'fast' });
      }
    });

    const answer = await gateway.askUser({
      sessionId: 's4',
      agentId: 'assistant',
      question: 'sync?',
    });
    expect(answer).toBe('fast');
    expect(events).toContain('ask_user.pending');
    expect(events).toContain('ask_user.resolved');
  });
});
