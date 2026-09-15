/**
 * Builder ContextEngine 接线：sessionId 隔离 + droppedSummary
 */

import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '../../src/harness/agent-building/builder.js';
import type { ModelProvider } from '../../src/core/interfaces/model-provider.js';
import type { ContextEngine, AssembleParams, AssembleResult } from '../../src/harness/context/types.js';
import type { Message } from '../../src/core/types.js';

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

function msg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('ContextEngine wiring', () => {
  it('convertToLlm 使用 agent.contextSessionId（多 session 不串味）', async () => {
    const seen: string[] = [];
    const spyEngine: ContextEngine = {
      info: { id: 'spy', name: 'spy', ownsCompaction: false },
      async assemble(params: AssembleParams): Promise<AssembleResult> {
        seen.push(params.sessionId);
        return { messages: [], estimatedTokens: 0, systemPrompt: params.systemPrompt };
      },
    };
    const builder = new AgentBuilder().model(mockProvider()).contextEngine(spyEngine);
    const { agent } = await builder.buildAgent();

    agent.setContextSessionId('s1');
    await agent.config.convertToLlm!([msg('a')]);
    agent.setContextSessionId('s2');
    await agent.config.convertToLlm!([msg('b')]);

    expect(seen).toEqual(['s1', 's2']);
  });

  it('droppedSummary 注入 system 提示', async () => {
    const spyEngine: ContextEngine = {
      info: { id: 'spy', name: 'spy', ownsCompaction: true },
      async assemble(): Promise<AssembleResult> {
        return {
          messages: [{ role: 'user', content: 'hi' }],
          estimatedTokens: 10,
          systemPrompt: 'sys',
          droppedSummary: '丢掉了旧工具输出',
        };
      },
    };
    const builder = new AgentBuilder().model(mockProvider()).contextEngine(spyEngine);
    const { agent } = await builder.buildAgent();
    const llm = await agent.config.convertToLlm!([msg('x')]);
    expect(llm[0]?.role).toBe('system');
    expect(String((llm[0] as { content?: string }).content)).toContain('丢掉了旧工具输出');
  });
});
