/**
 * ClientKnowledgeGrounding — AutoGroundPort 走 Knowledge Service
 */
import { describe, it, expect } from 'vitest';
import { ClientKnowledgeGrounding } from '@octopi-agent/engine/harness/knowledge/client.js';
import { GroundingAssembler } from '@octopi-agent/engine/harness/knowledge/grounding.js';
import type { Message } from '@octopi-agent/core/types.js';

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('ClientKnowledgeGrounding', () => {
  it('autoGround 透传 agentId/query 并合并 defaultRecall', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      async ensurePrincipal() {
        return undefined;
      },
      async autoGround(agentId: string, q: string, opts: Record<string, unknown>) {
        calls.push({ agentId, q, opts });
        return {
          mode: 'hint',
          hits: [],
          hint: '存在与本问相关的材料（1 处）：a.md',
          reason: 'hint',
          coverage: 1,
          scoreFloor: 0.72,
        };
      },
    };
    const port = new ClientKnowledgeGrounding(fakeClient as never, 'hint');
    const d = await port.autoGround('compliance retention policy', {
      agentId: 'a1',
      sessionId: 's1',
      limit: 8,
    });
    expect(d.mode).toBe('hint');
    expect(calls[0]?.agentId).toBe('a1');
    expect((calls[0]?.opts as { recall?: string }).recall).toBe('hint');
  });

  it('GroundingAssembler 可用 client 端口产出 hint 正文', async () => {
    const fakeClient = {
      async ensurePrincipal() {
        return undefined;
      },
      async autoGround() {
        return {
          mode: 'hint',
          hits: [],
          hint: '存在与本问相关的材料（1 处）：a.md',
          reason: 'hint',
          coverage: 1,
          scoreFloor: 0.72,
        };
      },
    };
    const asm = new GroundingAssembler({
      retriever: new ClientKnowledgeGrounding(fakeClient as never, 'hybrid'),
      skipIfUserTokensBelow: 0,
    });
    const pack = await asm.assemble({
      agentId: 'a1',
      sessionId: 's',
      messages: [user('compliance retention policy document please')],
    });
    expect(pack.mode).toBe('hint');
    expect(pack.text).toContain('knowledge-grounding');
    expect(pack.hint).toContain('相关的材料');
  });
});
