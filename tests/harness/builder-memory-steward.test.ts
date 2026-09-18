import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '../../src/harness/agent-building/builder.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import type { ModelProvider, LLMRequest } from '../../src/core/interfaces/model-provider.js';
import { join } from 'node:path';

function mockProvider(): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat(_req: LLMRequest) {
      return { content: 'ok', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
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
}

describe('AgentBuilder memory steward registration', () => {
  it('registers steward package path without ETL memoryExtraction handle', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const built = await new AgentBuilder()
      .model(mockProvider())
      .agentId('steward-agent')
      .memoryStore(memoryStore)
      .build({
        mode: 'full',
        subsystemDirs: { builtin: join(process.cwd(), 'src', 'subsystems') },
      });

    expect(built.runtime).toBeDefined();
    // ETL 句柄已删除：结果上不得再出现 memoryExtraction
    expect('memoryExtraction' in built).toBe(false);
    const tools =
      (built as any).harness?.toolBus?.getTool?.('memory_store') ??
      (built as any).agent?.context?.tools?.find?.((t: any) => t?.definition?.name === 'memory_store') ??
      (built as any).agent?.context?.tools?.['memory_store'];
    const hasMemoryStoreTool = Boolean(tools) || JSON.stringify((built as any).agent?.context?.tools ?? '').includes('memory_store');
    expect(hasMemoryStoreTool).toBe(true);
  });
});
