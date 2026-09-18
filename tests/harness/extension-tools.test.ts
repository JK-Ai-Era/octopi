import { describe, it, expect } from 'vitest';

import { createToolSet } from '../../src/harness/plugin-ecosystem/tools/tool-set.js';
import { createMemoryTools } from '../../src/harness/plugin-ecosystem/tools/memory.js';
import { createSessionTaskTools } from '../../src/harness/session-tasks/tools.js';
import { createAskUserTool } from '../../src/harness/plugin-ecosystem/tools/ask-user.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { InMemorySessionStore } from '../../src/integration/storage/memory.js';
import { SessionTaskService } from '../../src/harness/session-tasks/service.js';
import type { SessionData } from '../../src/harness/session-types.js';

function createSession(id = 's1', agentId = 'a1'): SessionData {
  return {
    id,
    agentId,
    meta: {
      id,
      agentId,
      channelId: 'test',
      peerId: 'test',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    turns: [],
    metadata: {},
    tasks: [],
  };
}

describe('extension tools', () => {
  it('createToolSet should separate builtin and extension tools', () => {
    const store = new InMemoryMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const taskService = new SessionTaskService(sessionStore);
    const { builtin, extensions, all } = createToolSet({
      memoryStore: store,
      sessionTaskService: taskService,
      askUser: async () => 'ok',
    });

    expect(builtin.length).toBe(8);
    expect(extensions.map((t) => t.definition.name)).toEqual(expect.arrayContaining([
      'memory_store',
      'memory_search',
      'task_create',
      'task_list',
      'task_plan',
      'task_complete',
      'ask_user',
    ]));
    expect(all.length).toBe(builtin.length + extensions.length);
  });

  it('createToolSet with no config should return only builtin', () => {
    const { builtin, extensions, all } = createToolSet();
    expect(builtin.length).toBe(8);
    expect(extensions.length).toBe(0);
    expect(all.length).toBe(8);
  });

  it('memory tools should work with injected store', async () => {
    const store = new InMemoryMemoryStore();
    const [storeTool, searchTool] = createMemoryTools(store);

    const stored = (await storeTool.handler(
      {
        type: 'method',
        proposition: 'flush persist before asserting store',
        evidence: 'test lesson',
        channel: 'admin',
        future_use: 'when writing store tests',
        anchors: ['persist', 'store'],
      },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { stored: boolean };
    expect(stored.stored).toBe(true);

    const result = (await searchTool.handler(
      { query: 'persist' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { results: Array<{ content: string }>; total: number };

    expect(result.total).toBe(1);
    expect(result.results[0].content).toContain('flush persist');
  });

  it('task tools should work with injected SessionTaskService', async () => {
    const sessionStore = new InMemorySessionStore();
    const session = createSession();
    await sessionStore.save('a1', 's1', session);
    const service = new SessionTaskService(sessionStore);
    service.attachSession(session);
    const tools = createSessionTaskTools(service);
    const byName = Object.fromEntries(tools.map((t) => [t.definition.name, t]));
    const ctx = { sessionId: 's1', agentId: 'a1', messages: [] };

    const created = (await byName.task_create.handler(
      { description: 'write docs' },
      ctx,
    )) as { id: string; description: string; status: string };

    expect(created.description).toBe('write docs');
    expect(created.status).toBe('open');

    const listResult = (await byName.task_list.handler({}, ctx)) as {
      tasks: Array<{ id: string; description: string }>;
      total: number;
    };

    expect(listResult.total).toBe(1);

    await byName.task_complete.handler({ task_id: created.id }, ctx);
    const after = (await byName.task_list.handler({ active_only: true }, ctx)) as { total: number };
    expect(after.total).toBe(0);
  });

  it('ask_user should invoke injected callback', async () => {
    const tool = createAskUserTool(async () => 'answer');
    const result = (await tool.handler(
      { question: 'hi?' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { answer: string };

    expect(result.answer).toBe('answer');
  });
});
