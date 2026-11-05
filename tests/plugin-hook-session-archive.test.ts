import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { SessionArchiveManager } from '@octopi-agent/engine/integration/storage/archive-manager.js';
import { PluginHookAdapter, type RegisteredHook } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/hooks/adapter.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('P4 Session archive observation', () => {
  it('observes session_end only after archive export and hot-store deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'octopi-plugin-archive-'));
    directories.push(root);
    const store = new JsonlSessionStore({ sessionsDir: join(root, 'sessions') });
    const observed: Array<{ sessionId: string; agentId: string; reason: string }> = [];
    const hook: RegisteredHook = {
      pluginId: 'acme.archive', hookName: 'session_end', phase: 'single', priority: 0,
      handler: (event: never) => {
        observed.push(event as unknown as { sessionId: string; agentId: string; reason: string });
      },
    };
    const port = new PluginHookAdapter({
      getHooks: () => [hook], getPluginConfig: () => undefined,
      recordHook: () => undefined, approveToolCall: async () => ({ allowed: false, decision: 'deny', timedOut: false, denyReason: 'no_channel', denyDetail: 'not configured' }),
    });
    const gateway = new Gateway({ agents: [], knowledge: { service: { manageLocal: false } } }, store);
    (gateway as unknown as { pluginManager: { getHookPort: () => typeof port } }).pluginManager = {
      getHookPort: () => port,
    };
    const manager = await gateway.createSessionArchiveManager({ archiveDir: join(root, 'archives'), recentRetentionDays: 0 });
    const id = 'session-ended';
    const session: SessionData = {
      id, agentId: 'agent',
      meta: {
        id, agentId: 'agent', channelId: 'test', peerId: 'user', status: 'idle',
        createdAt: 1, sessionStartedAt: 1, lastInteractionAt: 1, updatedAt: 1,
      },
      messages: [{ role: 'user', content: 'finished', timestamp: 1 }], steps: [], metadata: {},
      lifecycle: { lifecycle: 'recent', endedAt: Date.now() - 1000 },
    };
    await store.save(id, session);
    expect(await manager.runArchive()).toBe(1);
    expect(observed).toEqual([{ sessionId: id, agentId: 'agent', reason: 'archived' }]);
    expect(await store.load(id)).toBeNull();
    expect(await manager.queryArchive(id)).not.toBeNull();
  });

  it('does not turn active-session deletion into archive observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'octopi-plugin-delete-'));
    directories.push(root);
    const store = new JsonlSessionStore({ sessionsDir: join(root, 'sessions') });
    let observations = 0;
    const manager = new SessionArchiveManager(store, {
      archiveDir: join(root, 'archives'), recentRetentionDays: 0,
      onSessionArchived: () => { observations++; },
    });
    const session = {
      id: 'active', agentId: 'agent',
      meta: { id: 'active', agentId: 'agent', channelId: 'test', peerId: 'user', status: 'idle', createdAt: 1, sessionStartedAt: 1, lastInteractionAt: 1, updatedAt: 1 },
      messages: [], steps: [], metadata: {},
    } satisfies SessionData;
    await store.save('active', session);
    await store.delete('active');
    expect(await manager.runArchive()).toBe(0);
    expect(observations).toBe(0);
  });
});
