import { describe, it, expect, vi } from 'vitest';
import { makeToolContext } from '../helpers/tool-context.js';

import { createToolSet } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-set.js';
import { createMemoryTools } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/memory.js';
import { createSessionTaskTools } from '@octopi-agent/engine/harness/session/tasks/tools.js';
import {
  createAskUserTool,
  ASK_USER_CANCELLED,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/ask-user.js';
import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { SessionTaskService } from '@octopi-agent/engine/harness/session/tasks/service.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

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

    expect(builtin.length).toBe(26);
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
    expect(builtin.length).toBe(26);
    expect(extensions.length).toBe(0);
    expect(all.length).toBe(26);
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
      makeToolContext({ sessionId: 's1', agentId: 'a1' }),
    )) as { stored: boolean };
    expect(stored.stored).toBe(true);

    const result = (await searchTool.handler(
      { query: 'persist' },
      makeToolContext({ sessionId: 's1', agentId: 'a1' }),
    )) as { results: Array<{ content: string }>; total: number };

    expect(result.total).toBe(1);
    expect(result.results[0].content).toContain('flush persist');
  });

  it('task tools should work with injected SessionTaskService', async () => {
    const sessionStore = new InMemorySessionStore();
    const session = createSession();
    await sessionStore.save('s1', session);
    const service = new SessionTaskService(sessionStore);
    service.attachSession(session);
    const tools = createSessionTaskTools(service);
    const byName = Object.fromEntries(tools.map((t) => [t.definition.name, t]));
    const ctx = makeToolContext({ sessionId: 's1', agentId: 'a1' });

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
      makeToolContext({ sessionId: 's1', agentId: 'a1' }),
    )) as { answer: string };

    expect(result.answer).toBe('answer');
  });

  it('ask_user should pass session context and options to callback', async () => {
    let seen: { q: string; opts?: string[]; sid?: string; aid?: string } | null = null;
    const tool = createAskUserTool(async (q, opts, ctx) => {
      seen = { q, opts, sid: ctx.sessionId, aid: ctx.agentId };
      return 'A';
    });
    const result = (await tool.handler(
      { question: 'pick', options: ['A', 'B'] },
      makeToolContext({ sessionId: 's9', agentId: 'a9' }),
    )) as { answer: string };

    expect(result.answer).toBe('A');
    expect(seen).toEqual({ q: 'pick', opts: ['A', 'B'], sid: 's9', aid: 'a9' });
  });

  it('ask_user should reject empty question', async () => {
    const tool = createAskUserTool(async () => 'x');
    const result = (await tool.handler(
      { question: '   ' },
      makeToolContext({ sessionId: 's1', agentId: 'a1' }),
    )) as { answer: string | null; error?: string };
    expect(result.answer).toBeNull();
    expect(result.error).toContain('question');
  });

  it('ask_user definition should not declare timeoutMs (no bus watchdog)', () => {
    const tool = createAskUserTool(async () => 'x');
    expect(tool.definition.timeoutMs).toBeUndefined();
  });

  it('ask_user should keep waiting past the old 5-minute timeout', async () => {
    vi.useFakeTimers();
    try {
      let release!: (v: string) => void;
      const tool = createAskUserTool(
        () => new Promise<string>((r) => { release = r; }),
      );
      const pending = tool.handler(
        { question: 'q?' },
        makeToolContext({ sessionId: 's1', agentId: 'a1' }),
      );

      // 越过旧默认 5min 超时窗口再加一小时：不得自动返回
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      release('late answer');
      const result = (await pending) as { answer: string };
      expect(result.answer).toBe('late answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ask_user should surface gateway cancel sentinel as abort error', async () => {
    const tool = createAskUserTool(async () => ASK_USER_CANCELLED);
    const result = (await tool.handler(
      { question: 'q?' },
      makeToolContext({ sessionId: 's1', agentId: 'a1' }),
    )) as { answer: string | null; error?: string };
    expect(result.answer).toBeNull();
    expect(result.error).toContain('aborted');
  });

  it('ask_user should fail when the run aborts while waiting', async () => {
    const ac = new AbortController();
    const tool = createAskUserTool(() => new Promise<string>(() => {}));
    const pending = tool.handler(
      { question: 'q?' },
      makeToolContext({ sessionId: 's1', agentId: 'a1', abortSignal: ac.signal }),
    );
    ac.abort();
    await expect(pending).rejects.toThrow('ask_user aborted');
  });
});
