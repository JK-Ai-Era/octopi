import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { SessionArchiveManager } from '@octopi-agent/engine/integration/storage/archive-manager.js';
import { PluginHookAdapter, type RegisteredHook } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/hooks/adapter.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';

const directories: string[] = [];
const savedHome = process.env.OCTOPI_HOME;
let root: string;
let store: JsonlSessionStore;
let observed: Array<{ sessionId: string; agentId: string; reason: string }>;
let gateway: Gateway;

function makeGateway(): Gateway {
  const gw = new Gateway(
    { agents: [], knowledge: { service: { manageLocal: false } } } as unknown as GatewayConfig,
    store,
  );
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
  (gw as unknown as { pluginManager: { getHookPort: () => typeof port } }).pluginManager = {
    getHookPort: () => port,
  };
  return gw;
}

function endedSession(id: string, endedAt: number): SessionData {
  return {
    id, agentId: 'agent',
    meta: {
      id, agentId: 'agent', channelId: 'test', peerId: 'user', status: 'idle',
      createdAt: 1, sessionStartedAt: 1, lastInteractionAt: 1, updatedAt: 1,
    },
    messages: [{ role: 'user', content: 'finished', timestamp: 1 }],
    steps: [], metadata: {},
    lifecycle: { lifecycle: 'recent', endedAt },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'octopi-plugin-archive-'));
  directories.push(root);
  process.env.OCTOPI_HOME = root;
  store = new JsonlSessionStore({ sessionsDir: join(root, 'sessions') });
  observed = [];
  gateway = makeGateway();
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = savedHome;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('P4 Session archive observation', () => {
  it('observes session_end only after archive export and hot-store deletion', async () => {
    const id = 'session-ended';
    await store.save(id, endedSession(id, Date.now() - 200 * 24 * 60 * 60 * 1000));
    // 自动冷归档（retention 提名 → 组级封存）后观测
    await gateway.runArchiveRetention();
    expect(observed).toEqual([{ sessionId: id, agentId: 'agent', reason: 'archived' }]);
    expect(await store.load(id)).toBeNull();
    // 冷备可读回（注册表 + bundle 门面）
    const manager = new SessionArchiveManager({ archivesDir: join(root, 'archives') });
    expect(await manager.queryArchive(id)).not.toBeNull();
  });

  it('does not turn active-session deletion into archive observation', async () => {
    await store.save('active', endedSession('active', Date.now() - 1000));
    // 移到回收站（trashed）= 删除 ≠ 归档：不发 session_end(archived)
    await gateway.deleteSession('active');
    expect(observed).toEqual([]);
    // 且 active 未超期，自动冷归档也不会碰它
    await gateway.runArchiveRetention();
    expect(observed).toEqual([]);
    expect(await store.load('active')).toBeNull();
  });
});
