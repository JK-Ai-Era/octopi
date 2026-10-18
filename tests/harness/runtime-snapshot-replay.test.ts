/**
 * E8 快照回放语义与检索 query 净化（评审补充回归）
 *
 * 锚定三条核心规则：
 * 1. buildLlmMessages 只回放最近一条 runtimeSnapshot（旧快照不进请求，防陈旧择取固化）
 * 2. semanticHistory 排除引擎载体（快照/grounding/托管 system/contextSummary 不进 previousSummary）
 * 3. 检索 query（extractLayerQuery / resolveGroundingQuery）只采信真实用户文本，
 *    不把上轮快照（含旧记忆择取）当用户发言——防择取自我强化漂移
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

describe('runtimeSnapshot 回放语义（E8）', () => {
  it('buildLlmMessages 只回放最近一条快照（旧快照不进请求）', async () => {
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
    expect(text).not.toContain('OLD-PICKS');
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

describe('E8 快照必须进入 LLM 窗口（视图替换回归）', () => {
  it('剥旧插槽与新快照计数相等时，快照仍进请求（旧「长度相等」判据回归）', async () => {
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
    // 预置 1 条旧 knowledgeGrounding 插槽：本轮剥 1 条 + 插 1 条快照 → 长度相等，
    // 旧判据（baseMsgs.length !== session.messages.length）会误判「视图未变」而丢弃整张视图
    // ——快照消失、被过滤的旧插槽复活。锚定无条件视图替换的根因修复。
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
    expect(reqText).toContain('<runtime_snapshot>');
    expect(reqText).toContain('Current datetime:');
    // 旧插槽被过滤后不得复活（视图丢弃时它会随 session.messages 原样进请求）
    expect(reqText).not.toContain('OLD-GROUND-TEXT');
  });
});
