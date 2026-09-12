import { describe, it, expect } from 'vitest';

import { createToolSet } from '../../src/harness/plugin-ecosystem/tools/tool-set.js';
import { createMemoryTools } from '../../src/harness/plugin-ecosystem/tools/memory.js';
import { createTaskTools } from '../../src/harness/plugin-ecosystem/tools/task-tools.js';
import { createAskUserTool } from '../../src/harness/plugin-ecosystem/tools/ask-user.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { TaskTracker } from '../../src/harness/task-system/tasks/tracker.js';

describe('extension tools', () => {
  it('createToolSet should separate builtin and extension tools', () => {
    const store = new InMemoryMemoryStore();
    const tracker = new TaskTracker();
    const { builtin, extensions, all } = createToolSet({
      memoryStore: store,
      taskTracker: tracker,
      askUser: async () => 'ok',
    });

    expect(builtin.length).toBe(8);
    expect(extensions.map((t) => t.definition.name)).toEqual(expect.arrayContaining([
      'memory_store',
      'memory_search',
      'task_create',
      'task_list',
      'task_update',
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

    await storeTool.handler(
      { content: 'hello', type: 'lesson' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );

    const result = (await searchTool.handler(
      { query: 'hello' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { results: Array<{ content: string }>; total: number };

    expect(result.total).toBe(1);
    expect(result.results[0].content).toBe('hello');
  });

  it('task tools should work with injected tracker', async () => {
    const tracker = new TaskTracker();
    const [create, list, update] = createTaskTools(tracker);

    const created = (await create.handler(
      { description: 'write docs' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { id: string; description: string; status: string };

    expect(created.description).toBe('write docs');

    const listResult = (await list.handler(
      {},
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { tasks: Array<{ id: string; description: string }>; total: number };

    expect(listResult.total).toBe(1);

    const updateResult = (await update.handler(
      { task_id: created.id, action: 'complete' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    )) as { id: string; action: string };

    expect(updateResult.id).toBe(created.id);
    expect(updateResult.action).toBe('complete');
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
