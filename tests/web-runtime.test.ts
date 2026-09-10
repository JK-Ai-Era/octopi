import { describe, it, expect } from 'vitest';
import { OctopiRuntimeStore } from '../src/integration/web/runtime/store.js';

function createMockClient() {
  const state: {
    connectionFn?: Function;
    welcomeFn?: Function;
    acceptedFn?: Function;
    eventFn?: Function;
    stateFn?: Function;
    errorFn?: Function;
    subscribeCalls: Array<{ sessionId: string; agentId?: string }>;
  } = {
    subscribeCalls: [],
  };

  const client = {
    on(events: Record<string, any>) {
      state.connectionFn = events.onConnectionState;
      state.welcomeFn = events.onWelcome;
      state.acceptedFn = events.onAccepted;
      state.eventFn = events.onEvent;
      state.stateFn = events.onState;
      state.errorFn = events.onError;
    },
    connect() {
      state.connectionFn?.('connected');
      state.welcomeFn?.([]);
    },
    async listApprovals() {
      return [];
    },
    sendSubscribe(sessionId: string, agentId?: string) {
      state.subscribeCalls.push({ sessionId, agentId });
    },
    emitAccepted(sessionId: string | undefined, messageId: string | undefined) {
      state.acceptedFn?.(sessionId, messageId);
    },
    emitEvent(sessionId: string | undefined, event: Record<string, unknown>) {
      state.eventFn?.(sessionId, event);
    },
    emitState(sessionId: string | undefined, s: string) {
      state.stateFn?.(sessionId, s);
    },
    emitError(err: Error) {
      state.errorFn?.(err);
    },
    state,
  };

  return client as unknown as {
    on: (events: Record<string, any>) => void;
    connect: () => void;
    listApprovals: () => Promise<any[]>;
    sendSubscribe: (sessionId: string, agentId?: string) => void;
    emitAccepted: (sessionId: string | undefined, messageId: string | undefined) => void;
    emitEvent: (sessionId: string | undefined, event: Record<string, unknown>) => void;
    emitState: (sessionId: string | undefined, s: string) => void;
    emitError: (err: Error) => void;
    state: { subscribeCalls: Array<{ sessionId: string; agentId?: string }> };
  };
}

describe('OctopiRuntimeStore', () => {
  it('maps llm_stream_delta into streaming state', () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client as any);
    const states: string[] = [];

    store.addEventListener('stream', ((event: CustomEvent) => {
      states.push(event.detail.content);
    }) as EventListener);

    client.emitEvent(undefined, {
      type: 'llm_stream_delta',
      data: { delta: 'Hello' },
    });
    client.emitEvent(undefined, {
      type: 'llm_stream_delta',
      data: { delta: ' world' },
    });

    expect(states).toEqual(['Hello', 'Hello world']);
    expect(store.getState().chat.streamingContent).toBe('Hello world');
  });

  it('finalizes assistant message on turn.end', () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client as any);

    store.getState().chat.sessionId = 's1';
    store.getState().chat.agentId = 'a1';

    client.emitEvent(undefined, {
      type: 'llm_stream_delta',
      data: { delta: 'partial-' },
    });
    client.emitEvent(undefined, {
      type: 'turn.end',
      data: { content: 'final-answer' },
    });

    const conversation = store.getState().chat.conversation;
    expect(conversation.at(-1)?.role).toBe('assistant');
    expect((conversation.at(-1) as { content?: string }).content).toBe('final-answer');
    expect(store.getState().chat.streamingContent).toBe('');
  });

  it('tracks tool runs and inspector events', () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client as any);

    client.emitEvent(undefined, {
      type: 'tool.exec.start',
      data: { toolCallId: 't1', toolName: 'search' },
    });
    client.emitEvent(undefined, {
      type: 'tool.exec.end',
      data: { toolCallId: 't1', hasError: false },
    });
    client.emitEvent(undefined, {
      type: 'context.truncated',
      data: { from: 20, to: 10 },
    });

    expect(store.getState().chat.tools[0].status).toBe('success');
    expect(store.getState().chat.inspector.truncatedFrom).toBe(20);
  });

  it('updates inspector on tool exec error', () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client as any);

    client.emitEvent(undefined, {
      type: 'tool.exec.start',
      data: { toolCallId: 't1', toolName: 'search' },
    });
    client.emitEvent(undefined, {
      type: 'tool.exec.end',
      data: { toolCallId: 't1', isError: true, result: 'timeout' },
    });

    expect(store.getState().chat.tools[0].status).toBe('error');
    expect(store.getState().chat.inspector.lastToolError).toBe('timeout');
    expect(store.getState().chat.inspector.lastToolName).toBe('search');
  });

  it('subscribes on openSession and maps accepted/state updates', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client as any);

    (client as any).getSession = async () => ({
      meta: { id: 's1', agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    (client as any).getSessionMessages = async () => ({ messages: [] });
    (client as any).listApprovals = async () => [];

    await store.openSession('s1');
    expect(client.state.subscribeCalls).toEqual([{ sessionId: 's1', agentId: 'a1' }]);

    client.emitAccepted('s1', 'm1');
    expect(store.getState().chat.runStatus).toBe('waiting');

    client.emitState('s1', 'running');
    expect(store.getState().chat.runStatus).toBe('streaming');

    client.emitState('s1', 'idle');
    expect(store.getState().chat.runStatus).toBe('idle');
  });
});

describe('ViewMode transitions', () => {
  function createMockClient() {
    const state: {
      connectionFn?: Function;
      welcomeFn?: Function;
      acceptedFn?: Function;
      eventFn?: Function;
      stateFn?: Function;
      errorFn?: Function;
      subscribeCalls: Array<{ sessionId: string; agentId?: string }>;
    } = {
      subscribeCalls: [],
    };

    const client = {
      on(events: Record<string, any>) {
        state.connectionFn = events.onConnectionState;
        state.welcomeFn = events.onWelcome;
        state.acceptedFn = events.onAccepted;
        state.eventFn = events.onEvent;
        state.stateFn = events.onState;
        state.errorFn = events.onError;
      },
      connect() {
        state.connectionFn?.('connected');
        state.welcomeFn?.([]);
      },
      async listApprovals() { return []; },
      sendSubscribe(sessionId: string, agentId?: string) {
        state.subscribeCalls.push({ sessionId, agentId });
      },
      emitEvent(sessionId: string | undefined, event: Record<string, unknown>) {
        state.eventFn?.(sessionId, event);
      },
      state,
    };
    return client as any;
  }

  it('openSession sets viewMode to history', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.getSession = async () => ({
      meta: { id: 's1', agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    client.getSessionMessages = async () => ({
      messages: [{ role: 'user', content: 'hi', timestamp: 1000 }],
    });
    client.listApprovals = async () => [];

    await store.openSession('s1');
    expect(store.getState().chat.viewMode).toBe('history');
  });

  it('createSession sets viewMode to runtime', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.createSession = async () => ({
      id: 's2', agentId: 'a1', channelId: '', peerId: '',
      status: 'idle', createdAt: 1, sessionStartedAt: 1, lastInteractionAt: 1, updatedAt: 1,
    });
    client.listApprovals = async () => [];
    client.listSessions = async () => [];
    client.sendSubscribe = () => {};

    await store.createSession('a1');
    expect(store.getState().chat.viewMode).toBe('runtime');
  });

  it('receiving event in history mode auto-switches to hybrid', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.getSession = async () => ({
      meta: { id: 's1', agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    client.getSessionMessages = async () => ({ messages: [] });
    client.listApprovals = async () => [];

    await store.openSession('s1');
    expect(store.getState().chat.viewMode).toBe('history');

    const modes: string[] = [];
    store.addEventListener('viewMode', ((e: CustomEvent) => {
      modes.push(e.detail.mode);
    }) as EventListener);

    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'hello' } });

    expect(store.getState().chat.viewMode).toBe('hybrid');
    expect(modes).toEqual(['hybrid']);
  });

  it('sendMessage from history switches to hybrid', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.getSession = async () => ({
      meta: { id: 's1', agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    client.getSessionMessages = async () => ({ messages: [] });
    client.listApprovals = async () => [];
    client.sendChat = () => {};

    await store.openSession('s1');
    expect(store.getState().chat.viewMode).toBe('history');

    const modes: string[] = [];
    store.addEventListener('viewMode', ((e: CustomEvent) => {
      modes.push(e.detail.mode);
    }) as EventListener);

    await store.sendMessage('test');
    expect(store.getState().chat.viewMode).toBe('hybrid');
    expect(modes).toEqual(['hybrid']);
  });

  it('viewMode event is emitted on openSession', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.getSession = async () => ({
      meta: { id: 's1', agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    client.getSessionMessages = async () => ({ messages: [] });
    client.listApprovals = async () => [];

    const modes: string[] = [];
    store.addEventListener('viewMode', ((e: CustomEvent) => {
      modes.push(e.detail.mode);
    }) as EventListener);

    await store.openSession('s1');
    expect(modes).toEqual(['history']);
  });

  it('does not re-emit viewMode if mode is unchanged', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.getSession = async () => ({
      meta: { id: 's1', agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    client.getSessionMessages = async () => ({ messages: [] });
    client.listApprovals = async () => [];
    client.sendChat = () => {};

    await store.openSession('s1');
    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'a' } });
    expect(store.getState().chat.viewMode).toBe('hybrid');

    const modes: string[] = [];
    store.addEventListener('viewMode', ((e: CustomEvent) => {
      modes.push(e.detail.mode);
    }) as EventListener);

    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'b' } });
    expect(modes).toEqual([]);
  });

  it('conversation items are built on openSession', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.getSession = async () => ({
      meta: { id: 's1', agentId: 'a1' },
      messageCount: 2,
      turnCount: 1,
    });
    client.getSessionMessages = async () => ({
      messages: [
        { role: 'user', content: 'q1', timestamp: 100 },
        { role: 'assistant', content: 'a1', timestamp: 200 },
      ],
    });
    client.listApprovals = async () => [];

    await store.openSession('s1');
    const conv = store.getState().chat.conversation;
    expect(conv).toHaveLength(2);
    expect(conv[0].role).toBe('user');
    expect(conv[1].role).toBe('assistant');
    expect(conv[1].source).toBe('history');
  });
});

describe('Hybrid mode paths', () => {
  function createMockClient() {
    const state: { eventFn?: Function } = {};
    const client = {
      on(events: Record<string, any>) {
        state.eventFn = events.onEvent;
      },
      async listApprovals() { return []; },
      async listSessions() { return []; },
      sendSubscribe() {},
      sendChat() {},
      emitEvent(sessionId: string | undefined, event: Record<string, unknown>) {
        state.eventFn?.(sessionId, event);
      },
      state,
    };
    return client as any;
  }

  async function openHistorySession(client: any) {
    const store = new OctopiRuntimeStore(client);
    client.getSession = async () => ({
      meta: { id: 's1', agentId: 'a1' },
      messageCount: 1,
      turnCount: 1,
    });
    client.getSessionMessages = async () => ({
      messages: [{ role: 'user', content: 'old question', timestamp: 100 }],
    });
    client.listApprovals = async () => [];
    await store.openSession('s1');
    return store;
  }

  it('history → hybrid on runtime event, stays hybrid on subsequent events', async () => {
    const client = createMockClient();
    const store = await openHistorySession(client);
    expect(store.getState().chat.viewMode).toBe('history');
    expect(store.getState().chat.conversation).toHaveLength(1);

    const modes: string[] = [];
    store.addEventListener('viewMode', ((e: CustomEvent) => {
      modes.push(e.detail.mode);
    }) as EventListener);

    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'new ' } });
    expect(store.getState().chat.viewMode).toBe('hybrid');
    expect(store.getState().chat.conversation).toHaveLength(2);

    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'reply' } });
    expect(store.getState().chat.viewMode).toBe('hybrid');
    expect(modes).toEqual(['hybrid']);
  });

  it('hybrid preserves history items while adding runtime items', async () => {
    const client = createMockClient();
    const store = await openHistorySession(client);

    const historyItem = store.getState().chat.conversation[0];
    expect(historyItem.role).toBe('user');
    expect(historyItem.source).toBe('history');

    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'answer' } });
    client.emitEvent('s1', { type: 'turn.end', data: { content: 'answer' } });

    const items = store.getState().chat.conversation;
    expect(items).toHaveLength(2);
    expect(items[0].source).toBe('history');
    expect(items[1].source).toBe('runtime');
    expect(items[1].role).toBe('assistant');
  });

  it('sendMessage from history → hybrid then further events stay hybrid', async () => {
    const client = createMockClient();
    const store = await openHistorySession(client);
    expect(store.getState().chat.viewMode).toBe('history');

    await store.sendMessage('new question');
    expect(store.getState().chat.viewMode).toBe('hybrid');

    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'response' } });
    expect(store.getState().chat.viewMode).toBe('hybrid');
  });

  it('createSession stays runtime (not hybrid)', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.createSession = async () => ({
      id: 's2', agentId: 'a1', channelId: '', peerId: '',
      status: 'idle', createdAt: 1, sessionStartedAt: 1, lastInteractionAt: 1, updatedAt: 1,
    });
    client.listApprovals = async () => [];
    client.listSessions = async () => [];

    await store.createSession('a1');
    expect(store.getState().chat.viewMode).toBe('runtime');

    client.emitEvent('s2', { type: 'llm_stream_delta', data: { delta: 'hi' } });
    expect(store.getState().chat.viewMode).toBe('runtime');
  });

  it('openSession always resets to history regardless of previous mode', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);
    client.createSession = async () => ({
      id: 's1', agentId: 'a1', channelId: '', peerId: '',
      status: 'idle', createdAt: 1, sessionStartedAt: 1, lastInteractionAt: 1, updatedAt: 1,
    });
    client.listApprovals = async () => [];
    client.listSessions = async () => [];
    client.sendChat = () => {};

    await store.createSession('a1');
    expect(store.getState().chat.viewMode).toBe('runtime');

    client.getSession = async () => ({
      meta: { id: 's2', agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    client.getSessionMessages = async () => ({ messages: [] });
    await store.openSession('s2');
    expect(store.getState().chat.viewMode).toBe('history');
  });

  it('conversation items persist across session switches with caching', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);

    client.getSession = async (sessionId: string) => ({
      meta: { id: sessionId, agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    client.getSessionMessages = async () => ({ messages: [] });
    client.listApprovals = async () => [];

    await store.openSession('s1');
    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'hello from s1' } });
    expect(store.getState().chat.conversation).toHaveLength(1);

    await store.openSession('s2');
    expect(store.getState().chat.conversation).toHaveLength(0);

    await store.openSession('s1');
    expect(store.getState().chat.conversation).toHaveLength(1);
    expect((store.getState().chat.conversation[0] as { content?: string }).content).toContain('hello from s1');
  });
});
