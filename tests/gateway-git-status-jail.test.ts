/**
 * Gateway.getSessionGitStatus — 隔离对齐（留观①）：
 * untrusted 会话的快照读取必须携带 requireJail=true，普通会话为 false；
 * 判据来自 effect-policy 的共享谓词 requiresJail（与 runner 同源）。
 * 探针与快照读取 mock 掉，只测推导与接线。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { readSpy, probeSpy } = vi.hoisted(() => ({ readSpy: vi.fn(), probeSpy: vi.fn() }));

vi.mock('@octopi-agent/engine', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    readGitStatusSnapshot: (cwd: string, options?: unknown) => readSpy(cwd, options),
    probeProcessIsolation: () => probeSpy(),
  };
});

import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';

/** L4 最低线以上的宿主画像（untrusted admission 放行） */
const L4_OK_PROFILE = {
  backend: 'mac-seatbelt',
  filesystem: 'write-jailed',
  privilege: 'dropped',
  processTree: 'killable',
  resources: 'best-effort',
  envHygiene: 'scrubbed',
  notes: [],
};

function makeSession(agentId: string, sessionId: string): SessionData {
  return {
    id: sessionId,
    agentId,
    meta: {
      id: sessionId,
      agentId,
      channelId: 'web',
      peerId: 'ui',
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

describe('getSessionGitStatus 的 jail 推导', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'octopi-gitjail-'));
    await mkdir(join(base, 'target'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  beforeEach(async () => {
    readSpy.mockReset();
    probeSpy.mockReset();
    probeSpy.mockResolvedValue(L4_OK_PROFILE);
    readSpy.mockResolvedValue({
      isRepo: false,
      repoRoot: null,
      branch: null,
      counts: { conflicted: 0, staged: 0, unstaged: 0, untracked: 0 },
      entries: [],
      truncated: false,
      skippedRecords: 0,
      generatedAt: 'now',
    });
  });

  async function gatewayWithMode(mode: string): Promise<Gateway> {
    const store = new InMemorySessionStore();
    const config = {
      agents: [
        {
          id: 'a1',
          model: { provider: 'mock', model: 'mock' },
          workspace: base,
          effectPolicy: { mode },
        },
      ],
    } as unknown as GatewayConfig;
    const gw = new Gateway(config, store);
    await store.save('s1', makeSession('a1', 's1'));
    return gw;
  }

  it('untrusted 会话：快照读取携带 requireJail=true', async () => {
    const gw = await gatewayWithMode('untrusted');
    await gw.getSessionGitStatus('s1', join(base, 'target'));
    expect(readSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requireJail: true }),
    );
  });

  it('workspace 会话：requireJail=false（jail 建立失败回落 supervised，fail-open）', async () => {
    const gw = await gatewayWithMode('workspace');
    await gw.getSessionGitStatus('s1', join(base, 'target'));
    expect(readSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requireJail: false }),
    );
  });

  it('untrusted admission 拒绝（L4 不足）：端点如实抛错，不降级装成功', async () => {
    probeSpy.mockResolvedValue({
      ...L4_OK_PROFILE,
      processTree: 'best-effort', // 不满足 L4 最低线
    });
    const gw = await gatewayWithMode('untrusted');
    await expect(gw.getSessionGitStatus('s1', join(base, 'target'))).rejects.toThrow(
      /untrusted_refused/,
    );
    expect(probeSpy).toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });
});
