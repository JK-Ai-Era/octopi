/**
 * 浏览器引擎管理面（arch/browser-capability.md §3.9）：
 * - BrowserInstallJobs：任务生命周期 / 并发闸 / 输出截断（安装器注入假实现）
 * - WebApiRouter /browser 路由：状态 / 启动 / 轮询 / 404 / 非法引擎 / /config/browser
 * - probeEngines 形状 + installEngine 非法引擎 fail-loud
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { BrowserInstallJobs } from '@octopi-agent/gateway/web/api/browser-install.js';
import {
  installEngine,
  probeEngines,
} from '@octopi-agent/engine/integration/browser/install.js';

type FakeInstaller = (
  engine: string,
  options: { onProgress?: (line: string) => void },
) => Promise<{ ok: boolean; detail: string }>;

function fakeInstaller(behavior: 'done' | 'failed' | 'hang'): {
  installer: FakeInstaller;
  started: string[];
  finish?: () => void;
} {
  const started: string[] = [];
  let release: (() => void) | undefined;
  const installer: FakeInstaller = async (engine, options) => {
    started.push(engine);
    options.onProgress?.(`[${engine}] line-1`);
    options.onProgress?.(`[${engine}] line-2`);
    if (behavior === 'hang') {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return behavior === 'failed'
      ? { ok: false, detail: `${engine} exploded` }
      : { ok: true, detail: `${engine} ready` };
  };
  return { installer, started, finish: () => release?.() };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('BrowserInstallJobs（安装器注入）', () => {
  it('生命周期：running → done，输出按行缓冲', async () => {
    const fake = fakeInstaller('done');
    const jobs = new BrowserInstallJobs(fake.installer as never);
    const started = jobs.start('rebrowser');
    expect('error' in started).toBe(false);
    if ('error' in started) return;
    expect(started.status).toBe('running');
    await tick();
    const view = jobs.get(started.id)!;
    expect(view.status).toBe('done');
    expect(view.detail).toBe('rebrowser ready');
    expect(view.lines).toEqual(['[rebrowser] line-1', '[rebrowser] line-2']);
  });

  it('安装失败落到任务（非无声卡死）', async () => {
    const fake = fakeInstaller('failed');
    const jobs = new BrowserInstallJobs(fake.installer as never);
    const started = jobs.start('camoufox');
    if ('error' in started) throw new Error('unexpected error');
    await tick();
    const view = jobs.get(started.id)!;
    expect(view.status).toBe('failed');
    expect(view.detail).toBe('camoufox exploded');
  });

  it('同引擎并发拒绝（409 语义），不同引擎并行放行', async () => {
    const fake = fakeInstaller('hang');
    const jobs = new BrowserInstallJobs(fake.installer as never);
    const first = jobs.start('playwright');
    if ('error' in first) throw new Error('unexpected error');
    const second = jobs.start('playwright');
    expect('error' in second).toBe(true);
    const other = jobs.start('camoufox');
    expect('error' in other).toBe(false);
    fake.finish?.();
    await tick();
  });

  it('非法引擎 fail-loud', () => {
    const jobs = new BrowserInstallJobs((async () => ({ ok: true, detail: '' })) as never);
    const r = jobs.start('cloud');
    expect('error' in r && r.error).toMatch(/unknown browser engine/);
  });

  it('输出超上限截断并标 truncated（不静默吞行）', async () => {
    const jobs = new BrowserInstallJobs((async (
      _e: string,
      options: { onProgress?: (line: string) => void },
    ) => {
      for (let i = 0; i < 500; i += 1) options.onProgress?.(`line ${i}`);
      return { ok: true, detail: 'ok' };
    }) as never);
    const started = jobs.start('stealth');
    if ('error' in started) throw new Error('unexpected error');
    await tick();
    const view = jobs.get(started.id)!;
    expect(view.truncated).toBe(true);
    expect(view.lines.length).toBe(400);
    expect(view.lines[view.lines.length - 1]).toBe('line 499');
  });
});

interface CallResult {
  handled: boolean;
  status: number;
  body: { ok: boolean; error?: string; data?: unknown } | null;
}

async function call(
  router: WebApiRouter,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
): Promise<CallResult> {
  const req = Object.assign(
    Readable.from([body === undefined ? '' : JSON.stringify(body)]),
    { url, method, headers: { host: 'localhost' } },
  ) as unknown as IncomingMessage;
  let status = 0;
  let payload: CallResult['body'] = null;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    setHeader() {
      return this;
    },
    end(text?: string) {
      payload = text ? JSON.parse(text) : null;
      return this;
    },
  } as unknown as ServerResponse;
  const handled = await router.handle(req, res);
  return { handled, status, body: payload };
}

function makeRouter(installer: FakeInstaller) {
  const jobs = new BrowserInstallJobs(installer as never);
  const applyStub = {
    getBrowserView: vi.fn(() => ({ engine: 'stealth', hash: 'h1' })),
    updateBrowserEngine: vi.fn(async () => ({
      hash: 'h2',
      applied: 'next-run',
      affectedAgents: [],
    })),
  };
  const router = new WebApiRouter({
    gateway: {} as unknown as Gateway,
    configApply: applyStub as never,
    browserInstalls: jobs,
  });
  return { router, applyStub, jobs };
}

describe('WebApiRouter /browser 管理面', () => {
  it('GET /browser/engines 返回状态清单（host 面放行）', async () => {
    const { router } = makeRouter(fakeInstaller('done').installer);
    const r = await call(router, 'GET', '/api/v1/browser/engines');
    expect(r.status).toBe(200);
    const data = r.body?.data as Array<{ engine: string; ready: boolean }>;
    expect(data.some((e) => e.engine === 'stealth')).toBe(true);
  });

  it('POST install → 任务视图；GET install/:jobId 轮询 → done', async () => {
    const fake = fakeInstaller('done');
    const { router } = makeRouter(fake.installer);
    const started = await call(router, 'POST', '/api/v1/browser/engines/rebrowser/install', {});
    expect(started.status).toBe(200);
    const job = started.body?.data as { id: string; status: string };
    expect(job.status).toBe('running');
    await tick();
    const polled = await call(router, 'GET', `/api/v1/browser/engines/install/${job.id}`);
    expect(polled.status).toBe(200);
    expect((polled.body?.data as { status: string }).status).toBe('done');
  });

  it('POST install 非法引擎 → 400；未知任务 → 404；未知路由 → 404', async () => {
    const { router } = makeRouter(fakeInstaller('done').installer);
    const bad = await call(router, 'POST', '/api/v1/browser/engines/cloud/install', {});
    expect(bad.status).toBe(400);
    const missing = await call(router, 'GET', '/api/v1/browser/engines/install/nope');
    expect(missing.status).toBe(404);
    const unknown = await call(router, 'GET', '/api/v1/browser/whatever');
    expect(unknown.status).toBe(404);
  });

  it('同引擎安装在途 → 409', async () => {
    const fake = fakeInstaller('hang');
    const { router } = makeRouter(fake.installer);
    await call(router, 'POST', '/api/v1/browser/engines/playwright/install', {});
    const again = await call(router, 'POST', '/api/v1/browser/engines/playwright/install', {});
    expect(again.status).toBe(409);
    fake.finish?.();
  });

  it('/config/browser GET/PUT 走 hash 乐观锁', async () => {
    const { router, applyStub } = makeRouter(fakeInstaller('done').installer);
    const view = await call(router, 'GET', '/api/v1/config/browser');
    expect(view.status).toBe(200);
    expect(applyStub.getBrowserView).toHaveBeenCalled();
    const put = await call(router, 'PUT', '/api/v1/config/browser/engine', {
      engine: 'camoufox',
      hash: 'h1',
    });
    expect(put.status).toBe(200);
    expect(applyStub.updateBrowserEngine).toHaveBeenCalledWith('camoufox', 'h1');
  });
});

describe('install 单一实现（engine）', () => {
  it('installEngine 非法引擎 fail-loud（不静默）', async () => {
    const r = await installEngine('cloud');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/unknown browser engine/);
  });

  it('probeEngines 形状：五引擎 + cdp-attach 恒就绪', () => {
    const statuses = probeEngines();
    expect(statuses.map((s) => s.engine)).toEqual([
      'playwright',
      'rebrowser',
      'camoufox',
      'stealth',
      'cdp-attach',
    ]);
    expect(statuses.find((s) => s.engine === 'cdp-attach')?.ready).toBe(true);
    for (const s of statuses) expect(s.detail.length).toBeGreaterThan(0);
  });
});
