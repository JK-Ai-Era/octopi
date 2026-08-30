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

    const messages = store.getState().chat.messages;
    expect(messages.at(-1)?.role).toBe('assistant');
    expect(messages.at(-1)?.content).toBe('final-answer');
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
    // First event switches history → hybrid
    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'a' } });
    expect(store.getState().chat.viewMode).toBe('hybrid');

    const modes: string[] = [];
    store.addEventListener('viewMode', ((e: CustomEvent) => {
      modes.push(e.detail.mode);
    }) as EventListener);

    // Second event should NOT re-emit viewMode since already hybrid
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

    // First runtime event → hybrid
    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'new ' } });
    expect(store.getState().chat.viewMode).toBe('hybrid');
    expect(store.getState().chat.conversation).toHaveLength(2); // history user + streaming assistant

    // More events stay hybrid
    client.emitEvent('s1', { type: 'llm_stream_delta', data: { delta: 'reply' } });
    expect(store.getState().chat.viewMode).toBe('hybrid');
    expect(modes).toEqual(['hybrid']); // only one mode change
  });

  it('hybrid preserves history items while adding runtime items', async () => {
    const client = createMockClient();
    const store = await openHistorySession(client);

    // History has 1 user message
    const historyItem = store.getState().chat.conversation[0];
    expect(historyItem.role).toBe('user');
    expect(historyItem.source).toBe('history');

    // Runtime event adds new items
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

    // Runtime event in hybrid stays hybrid
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

    // Event in runtime stays runtime
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

    // Create session → runtime
    await store.createSession('a1');
    expect(store.getState().chat.viewMode).toBe('runtime');

    // Now open a history session
    client.getSession = async () => ({
      meta: { id: 's2', agentId: 'a1' },
      messageCount: 0,
      turnCount: 0,
    });
    client.getSessionMessages = async () => ({ messages: [] });

    await store.openSession('s2');
    expect(store.getState().chat.viewMode).toBe('history');
  });
});

describe('Session conversation cache', () => {
  function createMockClient() {
    const state: { eventFn?: Function } = {};
    const client = {
      on(events: Record<string, any>) { state.eventFn = events.onEvent; },
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

  it('switching away and back preserves conversation items', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);

    // Session A with history
    client.getSession = async (id: string) => ({
      meta: { id, agentId: 'a1' }, messageCount: 0, turnCount: 0,
    });
    client.getSessionMessages = async (id: string) => ({
      messages: id === 'A'
        ? [{ role: 'user', content: 'q1', timestamp: 100 }, { role: 'assistant', content: 'a1', timestamp: 200 }]
        : [{ role: 'user', content: 'b1', timestamp: 300 }],
    });

    // Open A
    await store.openSession('A');
    expect(store.getState().chat.conversation).toHaveLength(2);
    expect(store.getState().chat.viewMode).toBe('history');

    // Simulate runtime event on A (switches to hybrid)
    client.emitEvent('A', { type: 'llm_stream_delta', data: { delta: 'new ' } });
    client.emitEvent('A', { type: 'llm_stream_delta', data: { delta: 'content' } });
    client.emitEvent('A', { type: 'turn.end', data: { content: 'new content' } });
    expect(store.getState().chat.conversation).toHaveLength(3); // 2 history + 1 runtime assistant
    expect(store.getState().chat.viewMode).toBe('hybrid');

    // Switch to B
    await store.openSession('B');
    expect(store.getState().chat.conversation).toHaveLength(1);
    expect(store.getState().chat.viewMode).toBe('history');

    // Switch back to A — should restore cached items
    await store.openSession('A');
    const items = store.getState().chat.conversation;
    expect(items).toHaveLength(3); // preserved!
    expect(items[2].role).toBe('assistant');
    expect((items[2] as any).content).toBe('new content');
    expect(items[2].source).toBe('runtime');
    expect(store.getState().chat.viewMode).toBe('hybrid'); // preserved!
  });

  it('cache is independent per session', async () => {
    const client = createMockClient();
    const store = new OctopiRuntimeStore(client);

    client.getSession = async (id: string) => ({
      meta: { id, agentId: 'a1' }, messageCount: 0, turnCount: 0,
    });
    client.getSessionMessages = async (id: string) => ({
      messages: [{ role: 'user', content: `msg-${id}`, timestamp: 100 }],
    });

    await store.openSession('A');
    expect(store.getState().chat.conversation).toHaveLength(1);

    await store.openSession('B');
    expect(store.getState().chat.conversation).toHaveLength(1);
    expect((store.getState().chat.conversation[0] as any).content).toBe('msg-B');

    await store.openSession('A');
    expect(store.getState().chat.conversation).toHaveLength(1);
    expect((store.getState().chat.conversation[0] as any).content).toBe('msg-A');
  });
});
