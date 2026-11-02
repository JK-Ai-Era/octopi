/**
 * 生产 Runner 的附件局部召回：upload → intent plan → private index → turn_context。
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMRequest, ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { SessionAttachmentService } from '@octopi-agent/engine/harness/session/attachments/service.js';

function textOf(req: LLMRequest): string {
  return req.messages.map((m) => {
    if (typeof m.content === 'string') return m.content;
    return (m.content ?? []).map((b) => b.type === 'text' ? b.text : '').join('\n');
  }).join('\n');
}

describe('SessionAwareRunner attachment recall', () => {
  it('injects focus top-k from the uploaded attachment into the main model turn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'octopi-runner-recall-'));
    try {
      const sessionsDir = join(home, 'sessions');
      const svc = new SessionAttachmentService({ sessionsDir });
      const attachment = await svc.save('s1', {
        name: 'large.md',
        data: `${'unrelated opening\n'.repeat(30)}# Billing\nThe local recall passage is beyond the opening.`,
      });
      const mainRequests: LLMRequest[] = [];
      const intentRequests: LLMRequest[] = [];
      const provider: ModelProvider = {
        name: 'mock',
        defaultModel: 'm',
        async chat(req: LLMRequest) {
          if (req.messages.some((m) => typeof m.content === 'string' && m.content.includes('You triage how to open uploaded attachments'))) {
            intentRequests.push(req);
            return {
              content: JSON.stringify({ mode: 'recall_tools', focus: 'local recall', targets: ['large.md'], reason: 'local' }),
              model: 'm',
              finishReason: 'stop' as const,
            };
          }
          mainRequests.push(req);
          return { content: 'ok', model: 'm', finishReason: 'stop' as const };
        },
        async *stream() {
          yield { type: 'done' as const };
        },
        async isAvailable() { return true; },
        getModelInfo() { return { name: 'm', contextWindow: 32000 }; },
        getModelInfos() { return [{ name: 'm', contextWindow: 32000 }]; },
      };
      const { runner } = await new AgentBuilder()
        .model(provider)
        .systemPrompt('test')
        .store(new InMemorySessionStore())
        .runnerConfig({ sessionsDir, sessionAttachmentInject: { fullTextMaxChars: 40, recallTopK: 1 } })
        .build();

      for await (const _ of runner.handle(
        's1',
        {
          role: 'user',
          content: 'Where is the local recall passage?',
          timestamp: Date.now(),
          metadata: { attachmentIds: [attachment.id] },
        } as Message,
        { systemPrompt: '', agentId: 'a', sessionId: 's1' },
      )) {
        void _;
      }

      expect(intentRequests).toHaveLength(1);
      expect(mainRequests.length).toBeGreaterThan(0);
      const text = textOf(mainRequests[0]!);
      expect(text).toContain('The local recall passage is beyond the opening.');
      expect(text).toContain('第 31-32 行');
      expect(text).not.toContain('unrelated opening\nunrelated opening');
      expect(text).toContain('trust="untrusted"');
      expect(attachment.searchableSourceId).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
