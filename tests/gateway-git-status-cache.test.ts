/**
 * git-status 读节流（留观④）：per-key TTL 缓存 + 单飞 + 并发闸门。
 * 引擎读取 mock 成 spy（同 jail 接线测试），只测节流语义。
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

import { Gateway, createConcurrencyGate } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';

const L4_OK_PROFILE = {
  backend: 'mac-seatbelt',
  filesystem: 'write-jailed',
  privilege: 'dropped',
  processTree: 'killable',
  resources: 'best-effort',
  envHygiene: 'scrubbed',
  notes: [],
};

const snapshot = (path: string) => ({
  isRepo: false,
  repoRoot: null,
  branch: null,
  counts: { conflicted: 0, staged: 0, unstaged: 0, untracked: 0 },
  entries: [],
  truncated: false,
  skippedRecords: 0,
  generatedAt: `now:${path}`,
});

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

describe('createConcurrencyGate', () => {
  it('发放一次性归还句柄；重复归还不突破上限；非法上限拒绝', () => {
    const gate = createConcurrencyGate(2);
    const a = gate.tryAcquire();
    const b = gate.tryAcquire();
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    expect(gate.tryAcquire()).toBeNull(); // 满
    a!();
    a!(); // 幂等：重复归还只算一次
    const c = gate.tryAcquire();
    expect(c).toBeTypeOf('function');
    expect(gate.tryAcquire()).toBeNull(); // 双释放没有让 max+1
    b!();
    c!();
    expect(gate.tryAcquire()).toBeTypeOf('function');
    expect(() => createConcurrencyGate(0)).toThrow(/gate_invalid/);
    expect(() => createConcurrencyGate(1.5)).toThrow(/gate_invalid/);
    expect(() => createConcurrencyGate(Number.NaN)).toThrow(/gate_invalid/);
  });
});

describe('git-status 读节流', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'octopi-gitthrottle-'));
    for (let i = 0; i < 6; i += 1) await mkdir(join(base, `p${i}`));
    await mkdir(join(base, 'session'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  beforeEach(async () => {
    readSpy.mockReset();
    probeSpy.mockReset();
    probeSpy.mockResolvedValue(L4_OK_PROFILE);
    readSpy.mockImplementation(async (cwd: string) => snapshot(cwd));
  });

  async function makeGateway(): Promise<Gateway> {
    const store = new InMemorySessionStore();
    const config = {
      agents: [
        {
          id: 'a1',
          model: { provider: 'mock', model: 'mock' },
          workspace: base,
          effectPolicy: { mode: 'workspace' },
        },
      ],
    } as unknown as GatewayConfig;
    const gw = new Gateway(config, store);
    await store.save('s1', makeSession('a1', 's1'));
    await store.save('s2', makeSession('a1', 's2'));
    return gw;
  }

  it('同键 TTL 内复用快照（第二次不落 git），跨会话共享', async () => {
    const gw = await makeGateway();
    const a = await gw.getSessionGitStatus('s1', join(base, 'p0'));
    const b = await gw.getSessionGitStatus('s2', join(base, 'p0')); // 不同会话同键
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(b).toBe(a); // 缓存命中返回同一冻结 payload
  });

  it('TTL 过期后重读；不同路径互不共享', async () => {
    const gw = await makeGateway();
    await gw.getSessionGitStatus('s1', join(base, 'p1'));
    await gw.getSessionGitStatus('s1', join(base, 'p2'));
    expect(readSpy).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 1_100)); // 超过 1s TTL（真实时钟，不用假表）
    await gw.getSessionGitStatus('s1', join(base, 'p1'));
    expect(readSpy).toHaveBeenCalledTimes(3);
  });

  it('maxEntries 进键：不同截断要求互不串数据', async () => {
    const gw = await makeGateway();
    await gw.getSessionGitStatus('s1', join(base, 'p3'), { maxEntries: 5 });
    await gw.getSessionGitStatus('s1', join(base, 'p3'), { maxEntries: 2000 });
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('同键并发走单飞：5 并发只 spawn 一次 git，全数成功', async () => {
    let release!: (v: unknown) => void;
    readSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const gw = await makeGateway();
    const results = [0, 1, 2, 3, 4].map(() =>
      gw.getSessionGitStatus('s1', join(base, 'p4')).catch((e: Error) => e),
    );
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalledTimes(1));
    release(snapshot('x'));
    const settled = await Promise.all(results);
    for (const s of settled) expect(s).not.toBeInstanceOf(Error);
    expect(new Set(settled).size).toBe(1); // 同一冻结 payload
  });

  it('并发超限（不同键）报 git_status_busy，额度归还后恢复', async () => {
    const pending: Array<{ resolve: (v: unknown) => void }> = [];
    readSpy.mockImplementation(
      (cwd: string) =>
        new Promise((resolve) => {
          pending.push({ resolve });
          void cwd;
        }),
    );
    const gw = await makeGateway();
    const paths = [0, 1, 2, 3, 4, 5].map((i) => join(base, `p${i}`));
    // 6 个不同键并发：4 个拿到额度挂起，2 个被闸门拒——不能等挂起者完成再断言（会死锁）
    const results = paths.map((p) =>
      gw.getSessionGitStatus('s1', p).then(
        (v) => ({ ok: true as const, v }),
        (e: Error) => ({ ok: false as const, e }),
      ),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    for (const p of pending) p.resolve(snapshot('x'));
    const settled = await Promise.all(results);
    const rejected = settled.filter((s) => !s.ok);
    expect(rejected).toHaveLength(2); // 上限 4：6 并发中 2 个 busy
    for (const r of rejected) {
      if (!r.ok) expect(r.e.message).toMatch(/git_status_busy/);
    }
    // 额度已归还：下一次调用正常
    readSpy.mockImplementation(async (cwd: string) => snapshot(cwd));
    await expect(gw.getSessionGitStatus('s1', join(base, 'p0'))).resolves.toBeTruthy();
  });

  it('读失败不写缓存（下次重试），缓存命中不占闸门额度', async () => {
    readSpy.mockRejectedValueOnce(new Error('git_status_failed: boom'));
    const gw = await makeGateway();
    await expect(gw.getSessionGitStatus('s1', join(base, 'p5'))).rejects.toThrow(/boom/);
    await gw.getSessionGitStatus('s1', join(base, 'p5'));
    expect(readSpy).toHaveBeenCalledTimes(2); // 失败未缓存

    // p5 已缓存；用 4 个挂起占满闸门后，缓存命中仍即时返回
    const pending: Array<{ resolve: (v: unknown) => void }> = [];
    readSpy.mockImplementation(
      (cwd: string) =>
        new Promise((resolve) => {
          pending.push({ resolve });
          void cwd;
        }),
    );
    const hang = [0, 1, 2, 3].map((i) =>
      gw.getSessionGitStatus('s1', join(base, `p${i}`)).catch((e: Error) => e),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    await expect(gw.getSessionGitStatus('s1', join(base, 'p5'))).resolves.toBeTruthy();
    for (const p of pending) p.resolve(snapshot('x'));
    await Promise.all(hang);
  });
});
