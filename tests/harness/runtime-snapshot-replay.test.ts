/**
 * Turn 全回放 + 检索 query 净化
 *
 * 锚定规则：
 * 1. buildLlmMessages **全回放**（append-only）：旧快照/插槽一律进请求，保前缀缓存
 * 2. semanticHistory 排除引擎载体 / 剥 turn_context（不进 previousSummary）
 * 3. 检索 query 只采信 `<user_message>` / 真实用户文本
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { ModelProvider, LLMRequest } from '@octopi-agent/core/interfaces/model-provider.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { extractLayerQuery } from '@octopi-agent/engine/harness/context/layer-types.js';
import { resolveGroundingQuery } from '@octopi-agent/engine/harness/knowledge/grounding.js';

function msg(role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return { role, content, timestamp: Date.now(), ...extra };
}

const snap = (text: string): Message =>
  msg('user', `<runtime_snapshot>${text}</runtime_snapshot>`, {
    metadata: { source: 'runtimeSnapshot' },
  });

describe('runtimeSnapshot 全回放（E8 + 全回放）', () => {
  it('buildLlmMessages 全回放：旧快照也进请求（append-only）', async () => {
    const engine = new DefaultContextEngine();
    const messages = [
      msg('user', 'q1'),
      snap('OLD-PICKS'),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
      snap('FRESH-PICKS'),
    ];
    const result = await engine.assemble({
      sessionId: 'snap-replay',
      messages,
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 100000,
    });
    const text = result.messages.map((m) => String(m.content ?? '')).join('\n');
    expect(text).toContain('FRESH-PICKS');
    expect(text).toContain('OLD-PICKS');
    // 托管 system 不重复
    expect(text).not.toContain('hosted-system');
  });

  it('semanticHistory 排除快照等引擎载体（不进 previousSummary）', () => {
    const engine = new DefaultContextEngine();
    // semanticHistory 是摘要/压缩的语义输入过滤器；直接锚定其契约
    const sem = (
      engine as unknown as { semanticHistory(ms: Message[]): Message[] }
    ).semanticHistory;
    const messages = [
      msg('user', 'real-user-text'),
      snap('SNAPSHOT-TEXT'),
      msg('user', 'ground-text', { metadata: { source: 'knowledgeGrounding' } }),
      msg('system', 'hosted-system', { metadata: { source: 'systemPrompt' } }),
      msg('assistant', 'real-assistant-text'),
    ];
    const out = sem(messages);
    const text = out.map((m) => String(m.content ?? '')).join('\n');
    expect(text).toContain('real-user-text');
    expect(text).toContain('real-assistant-text');
    expect(text).not.toContain('SNAPSHOT-TEXT');
    expect(text).not.toContain('ground-text');
    expect(text).not.toContain('hosted-system');
  });
});

describe('检索 query 净化（防择取自我强化）', () => {
  it('extractLayerQuery 不采信快照/grounding 等引擎载体文本', () => {
    const messages = [
      msg('user', '真实的上一条用户问题'),
      snap('OLD-MEMORY-PICKS 陈旧记忆择取'),
      msg('user', 'ground-text', { metadata: { source: 'knowledgeGrounding' } }),
      msg('user', '继续'),
    ];
    const q = extractLayerQuery(messages);
    expect(q).toContain('继续');
    expect(q).toContain('真实的上一条用户问题');
    expect(q).not.toContain('OLD-MEMORY-PICKS');
    expect(q).not.toContain('ground-text');
  });

  it('resolveGroundingQuery 不采信快照文本', () => {
    const messages = [
      snap('OLD-MEMORY-PICKS'),
      msg('user', '真实问题'),
    ];
    const q = resolveGroundingQuery(messages, { includePriorUserTurns: 2 });
    expect(q).toContain('真实问题');
    expect(q).not.toContain('OLD-MEMORY-PICKS');
  });
});

describe('全回放必须进入 LLM 窗口（视图替换回归）', () => {
  it('旧插槽与本轮 turn_start 一并进请求（append-only，无剥除）', async () => {
    const captured: LLMRequest[] = [];
    const provider: ModelProvider = {
      name: 'mock',
      defaultModel: 'm',
      async chat(req: LLMRequest) {
        captured.push(req);
        return { content: 'ok', model: 'm', finishReason: 'stop' as const };
      },
      async *stream(req: LLMRequest) {
        captured.push(req);
        yield { type: 'done' as const };
      },
      async isAvailable() {
        return true;
      },
      getModelInfo() {
        return { name: 'm', contextWindow: 32000 };
      },
      getModelInfos() {
        return [{ name: 'm', contextWindow: 32000 }];
      },
    };
    const store = new InMemorySessionStore();
    await store.save('s1', {
      id: 's1',
      agentId: 'a',
      meta: {
        id: 's1',
        agentId: 'a',
        channelId: 'web',
        peerId: 'ui',
        status: 'idle',
        createdAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages: [
        msg('user', 'OLD-GROUND-TEXT', { metadata: { source: 'knowledgeGrounding' } }),
        msg('user', 'q1'),
      ],
      turns: [],
      metadata: {},
    });

    const { runner } = await new AgentBuilder()
      .model(provider)
      .systemPrompt('You are test-agent.')
      .store(store)
      .build();

    for await (const _ of runner.handle('s1', msg('user', 'q2'), {
      systemPrompt: '',
      agentId: 'a',
      sessionId: 's1',
    })) {
      void _;
    }

    const reqText = (captured[0]?.messages ?? [])
      .map((m) => String((m as { content?: unknown }).content ?? ''))
      .join('\n');
    expect(reqText).toContain('<turn_start');
    expect(reqText).toContain('Current datetime:');
    expect(reqText).toContain('<user_message>');
    // 全回放：旧插槽不得被剥除（剥除 = 历史中部改写 = 打穿前缀缓存）
    expect(reqText).toContain('OLD-GROUND-TEXT');
    expect(reqText).toContain('q1');
    expect(reqText).toContain('q2');
  });
});
