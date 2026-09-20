/**
 * Web store Observer 刷新：会话切换守卫 + entry/final 乱序
 */

import { describe, expect, it } from 'vitest';
import { OctopiRuntimeStore } from '../../src/integration/web/runtime/store.js';
import type { OctopiClient } from '../../src/integration/web/sdk/client.js';

type Snapshot = {
  sessionId: string;
  runId: string;
  scope: { sessionId: string; agentId: string; capturedAt: number };
  observer: { enabled: boolean; level: string; webPanel: boolean };
};

function makeSnapshot(sessionId: string, runId: string): Snapshot {
  return {
    sessionId,
    runId,
    scope: { sessionId, agentId: 'default', capturedAt: Date.now() },
    observer: { enabled: true, level: 'full', webPanel: true },
  };
}

function messagesSnap(
  sessionId: string,
  runId: string,
  phase: 'entry' | 'final',
  notes: string,
): Record<string, unknown> {
  return {
    sessionId,
    runId,
    view: 'workspace',
    phase,
    summary: {
      count: phase === 'entry' ? 1 : 2,
      byRole: {},
      systemPromptCount: 0,
      contextSummaryCount: 0,
      hiddenFromChatCount: 0,
      chars: phase === 'entry' ? 1 : 9,
      agentIds: [],
    },
    notes,
  };
}

function makeMockClient(handlers?: {
  getObservatory?: (
    sessionId: string,
  ) => Promise<{ snapshot: Snapshot | null; observer?: unknown }>;
  getMessages?: (
    sessionId: string,
    options?: { phase?: string; runId?: string; view?: string },
  ) => Promise<Record<string, unknown> | null>;
}): OctopiClient {
  return {
    on: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    updateOptions: () => undefined,
    sendSubscribe: () => undefined,
    getAgents: async () => [],
    getModels: async () => ({ models: [], agents: [] }),
    listSessions: async () => [],
    getSession: async (sessionId: string) => ({
      meta: { sessionId, agentId: 'default', status: 'idle', updatedAt: Date.now() },
    }),
    getSessionTasks: async () => [],
    listApprovals: async () => [],
    getSessionMessages: async () => ({ messages: [] }),
    getSessionContextLayers: async () => null,
    getAgentContextHealth: async () => null,
    getSessionModel: async () => null,
    getSessionRunObservatory:
      handlers?.getObservatory ??
      (async (sessionId: string) => ({ snapshot: makeSnapshot(sessionId, `run_${sessionId}`) })),
    getSessionRunMessages:
      handlers?.getMessages ??
      (async (sessionId: string, options?: { phase?: string; runId?: string }) =>
        messagesSnap(
          sessionId,
          options?.runId ?? `run_${sessionId}`,
          options?.phase === 'entry' ? 'entry' : 'final',
          options?.phase === 'entry' ? 'entry-body' : 'final-body',
        )),
  } as unknown as OctopiClient;
}

describe('OctopiRuntimeStore observer refresh guards', () => {
  it('drops observatory REST write after session switch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = makeMockClient({
      getObservatory: async (sessionId) => {
        if (sessionId === 's-a') await gate;
        return { snapshot: makeSnapshot(sessionId, `run_${sessionId}`) };
      },
    });
    const store = new OctopiRuntimeStore(client);

    const openA = store.openSession('s-a');
    await Promise.resolve();
    await Promise.resolve();
    const openB = store.openSession('s-b');
    await openB;
    release();
    await openA;

    const chat = store.getState().chat;
    expect(chat.sessionId).toBe('s-b');
    const obs = chat.inspector.runObservatory;
    if (obs) {
      expect(obs.sessionId).toBe('s-b');
    }
  });

  it('keeps final messages when late entry response arrives', async () => {
    const store = new OctopiRuntimeStore(makeMockClient());
    await store.openSession('s-x');
    const anyStore = store as unknown as {
      chat: { sessionId?: string; inspector: { runMessages?: { phase?: string; notes?: string; runId?: string } } };
      refreshRunMessages: (
        phase?: string,
        runId?: string,
        view?: string,
      ) => Promise<void>;
      client: {
        getSessionRunMessages: (
          sessionId: string,
          options?: { phase?: string; runId?: string; view?: string },
        ) => Promise<Record<string, unknown> | null>;
      };
    };

    // 先写 final
    anyStore.client.getSessionRunMessages = async (sessionId, options) =>
      messagesSnap(sessionId, options?.runId ?? 'run_x', 'final', 'final-body');
    await anyStore.refreshRunMessages('final', 'run_x', 'workspace');
    expect(anyStore.chat.inspector.runMessages?.phase).toBe('final');

    // 后到的 entry 不得覆盖 final
    anyStore.client.getSessionRunMessages = async (sessionId, options) =>
      messagesSnap(sessionId, options?.runId ?? 'run_x', 'entry', 'entry-body');
    await anyStore.refreshRunMessages('entry', 'run_x', 'workspace');
    expect(anyStore.chat.inspector.runMessages?.phase).toBe('final');
    expect(anyStore.chat.inspector.runMessages?.notes).toBe('final-body');
  });
});
