import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { createMemoryStoreTool, createMemorySearchTool } from '../../src/harness/plugin-ecosystem/tools/memory.js';

async function execTool(tool: { definition: { name: string }; handler: (args: any, ctx?: any) => Promise<any> }, args: any) {
  return tool.handler(args, { sessionId: 'sess-1' });
}

describe('AgentBuilder memory tools (new slots)', () => {
  it('stores via memory_store slots and searches including shadow', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const storeTool = createMemoryStoreTool(memoryStore);
    const searchTool = createMemorySearchTool(memoryStore);

    const rejected = await execTool(storeTool, {
      type: 'norm',
      proposition: '用户在会话中确认了 2 条约束',
      evidence: 'ok',
      channel: 'model_inference',
    });
    expect(rejected.stored).toBe(false);

    const stored = await execTool(storeTool, {
      type: 'fact',
      proposition: 'Memory 持久化使用 SqliteMemoryStore 挂在 agent.db',
      evidence: '定过了：SqliteMemoryStore',
      channel: 'decision',
      future_use: '当配置记忆后端时',
      anchors: ['SqliteMemoryStore', 'agent.db'],
    });
    expect(stored.stored).toBe(true);

    const shadow = await execTool(storeTool, {
      type: 'norm',
      proposition: '回答前先联网核实再下判断',
      evidence: '"不要那么主观嘛，你通过网络先了解一下"',
      channel: 'user_directive',
    });
    expect(shadow.stored).toBe(true);
    expect(shadow.status).toBe('shadow');

    const search = await execTool(searchTool, { query: 'SqliteMemoryStore' });
    expect(search.total).toBeGreaterThanOrEqual(1);
    expect(search.results[0].content).toContain('SqliteMemoryStore');
  });
});
