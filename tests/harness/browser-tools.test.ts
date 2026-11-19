/**
 * browser_* 工具面测试（真实栈：DefaultBrowserService + PlaywrightBrowserPort + 真 Chromium）
 *
 * 真实性纪律（评审 M7）：
 * - fileEffects 用**真 fs 语义**替身（writeFile 不建目录，与真实 undo-log 一致）——
 *   截图路径的 mkdir 义务由被测代码承担，替身不得代劳。
 * - 本地 HTTP fixture（127.0.0.1）而非 data: URL——URL 策略只放 http/https，
 *   且路由级策略要在真实网络栈上验证。
 * - 引擎缺席时真实栈用例跳过并显式告警（不静默绿）。
 */

import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AddressInfo, createServer as createNetServer } from 'node:net';

import { createBrowserService } from '../../packages/engine/src/integration/browser/index.js';
import {
  createBrowserTools,
  confirmGateEnabled,
  domainMatches,
  assertBrowserUrlAllowed,
} from '../../packages/engine/src/harness/extension/plugin-ecosystem/tools/browser.js';
import type { BrowserService } from '../../packages/engine/src/harness/extension/plugin-ecosystem/tools/browser-types.js';
import { assembleGlobalTools } from '../../packages/engine/src/integration/tools/assemble.js';
import type {
  RegisteredTool,
  ToolExecutionContext,
} from '@octopi-agent/core/types.js';
import {
  getRunScope,
  runInScope,
  type RunScope,
} from '../../packages/engine/src/harness/run/run-scope.js';
import { DefaultBrowserService } from '../../packages/engine/src/integration/browser/service.js';
import { PlaywrightBrowserPort } from '../../packages/engine/src/integration/browser/playwright.js';
import {
  parseFallbackChain,
  StealthFallbackService,
} from '../../packages/engine/src/integration/browser/stealth.js';
import { effectiveHumanize } from '../../packages/engine/src/harness/extension/plugin-ecosystem/tools/browser.js';

// 工具 handler 契约返回 unknown；测试侧经 loosen 统一松散读取（结果形状在各用例内断言）
type ToolResult = any;
type LooseTool = {
  definition: RegisteredTool['definition'];
  handler: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolResult>;
};
function loosen(t: RegisteredTool): LooseTool {
  return { definition: t.definition, handler: (a, c) => t.handler(a, c) as Promise<ToolResult> };
}

// ── 引擎可用性（缺席跳过真实栈用例，但显式告警） ──

async function checkEngine(): Promise<boolean> {
  try {
    const service = createBrowserService({ engine: 'auto' });
    const session = await service.acquire('__probe__');
    await session.close();
    await service.dispose();
    return true;
  } catch (err) {
    // OCTOPI_REQUIRE_BROWSER_TESTS=1：缺引擎直接 fail（发布/CI 里真实栈必须核到，不许静默跳过）
    if (process.env.OCTOPI_REQUIRE_BROWSER_TESTS === '1') throw err;
    console.warn(
      `[browser-tools.test] browser engine unavailable — real-stack tests will be skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
const engineAvailable = await checkEngine();

// 装配用例的 octopiHome 必须是临时目录（N14：仓库根 credentials 污染）
const asmHome = await mkdtemp(join(tmpdir(), 'octopi-browser-asm-'));
afterAll(async () => {
  await rm(asmHome, { recursive: true, force: true });
});

// ── 本地 HTTP fixture ──

const FORM_HTML = `<!doctype html><html><head><title>FormT</title></head><body>
<h1>Hello</h1>
<form>
  <input name="user" placeholder="username">
  <input type="password" name="pw">
  <input type="checkbox" name="agree"> agree
  <select name="choice"><option value="a">A</option><option value="b">B</option></select>
  <button type="submit">Send</button>
</form>
<a href="https://example.com">more</a>
</body></html>`;

const POST_FORM_HTML = `<!doctype html><html><head><title>PostT</title></head><body>
<form method="post" action="/submit">
  <input name="q" placeholder="query">
  <button type="submit">Send</button>
</form>
</body></html>`;

const NAV_HTML = `<!doctype html><html><head><title>NavT</title></head><body>
<p>nav page</p><a href="/other">go other</a>
</body></html>`;

const OTHER_HTML = `<!doctype html><html><head><title>OtherT</title></head><body><p>other page</p></body></html>`;
const FINAL_HTML = `<!doctype html><html><head><title>FinalT</title></head><body><p>SECRET-LOADED</p></body></html>`;

let server: Server;
let baseUrl = '';
let postCount = 0;
let finalCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url.startsWith('/submit')) {
      postCount += 1;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body>submitted</body></html>');
      return;
    }
    if (url.startsWith('/redir307ext')) {
      // 307 保留 POST → 跨主机目标（localhost）：跳转目标必须逐跳复验（先于 /redir307 判定）
      res.statusCode = 307;
      res.setHeader('location', `http://localhost:${(server.address() as AddressInfo).port}/submit`);
      res.end();
      return;
    }
    if (url.startsWith('/redir307')) {
      // 307 保留方法：POST 随跳走——route-walk 闸必须看到每一跳（先于 /redir 判定）
      res.statusCode = 307;
      res.setHeader('location', '/submit');
      res.end();
      return;
    }
    if (url.startsWith('/redir')) {
      // 302 → 另一主机名（localhost vs 127.0.0.1）：路由级策略必须复验目标
      res.statusCode = 302;
      res.setHeader('location', `http://localhost:${(server.address() as AddressInfo).port}/final`);
      res.end();
      return;
    }
    if (url.startsWith('/xhr307ext')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><body><p>xhr307ext</p><script>fetch("/redir307ext", {method: "POST", body: "x"}).catch(()=>{})</script></body></html>',
      );
      return;
    }
    if (url.startsWith('/redir307ext')) {
      // 307 保留 POST → 跨主机目标（localhost）：跳转目标必须逐跳复验
      res.statusCode = 307;
      res.setHeader('location', `http://localhost:${(server.address() as AddressInfo).port}/submit`);
      res.end();
      return;
    }
    if (url.startsWith('/xhr307')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><body><p>xhr307</p><script>fetch("/redir307", {method: "POST", body: "x"})</script></body></html>',
      );
      return;
    }
    if (url.startsWith('/final')) {
      finalCount += 1;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(FINAL_HTML);
      return;
    }
    if (url.startsWith('/postform')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(POST_FORM_HTML);
      return;
    }
    if (url.startsWith('/popup')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><body><p>popup page</p><a target="_blank" href="/final">pop</a></body></html>',
      );
      return;
    }
    if (url.startsWith('/popup-noopener')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><body><p>popup page</p><a target="_blank" rel="noopener" href="/final">pop</a></body></html>',
      );
      return;
    }
    if (url.startsWith('/other')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(OTHER_HTML);
      return;
    }
    if (url.startsWith('/nav')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(NAV_HTML);
      return;
    }
    if (url.startsWith('/set-cookie')) {
      res.setHeader('set-cookie', 'octopi_test=cookievalue123; Path=/');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body><p>cookie set</p></body></html>');
      return;
    }
    if (url.startsWith('/echo-cookie')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<html><body><p>cookie:${req.headers.cookie ?? 'none'}</p></body></html>`);
      return;
    }
    if (url.startsWith('/upload')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><body><form method="post" action="/submit" enctype="multipart/form-data"><input type="file" name="f"><button type="submit">Send</button></form></body></html>',
      );
      return;
    }
    if (url.startsWith('/extract')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><body><h1 class="title">Foo</h1><ul><li class="item">a</li><li class="item">b</li></ul></body></html>',
      );
      return;
    }
    if (url.startsWith('/challenge')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing</p></body></html>',
      );
      return;
    }
    if (url.startsWith('/xhr')) {
      const peer = /^\/xhr-two\?peer=(\d+)/.exec(url)?.[1];
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        peer
          ? `<html><body><p>xhr page</p><script>fetch("/submit",{method:"POST",body:"a"}).then(()=>fetch("http://127.0.0.1:${Number(peer)}/submit",{method:"POST",body:"b"}))</script></body></html>`
          : '<html><body><p>xhr page</p><script>fetch("/submit",{method:"POST",body:"x"}).then(()=>fetch("/submit",{method:"POST",body:"y"}))</script></body></html>',
      );
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FORM_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── ctx fixture：真 fs 语义 fileEffects（不建目录；mkdir 是被测代码的义务） ──

interface Recorder {
  events: Array<{ event: string; data: Record<string, unknown> }>;
  writes: Array<{ path: string; data: Uint8Array }>;
}

function makeCtx(
  recorder: Recorder,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    messages: [],
    cwd: process.cwd(),
    fileEffects: {
      writeFile: async (p: string, d: string | Uint8Array) => {
        const bytes = typeof d === 'string' ? new TextEncoder().encode(d) : d;
        // 真实 undo-log 语义：不建父目录（ENOENT 即 ENOENT）
        await (await import('node:fs/promises')).writeFile(p, bytes);
        recorder.writes.push({ path: p, data: bytes });
      },
      appendFile: async () => {},
      recordDelete: async () => {},
      recordCreate: async () => {},
      recordRename: async () => {},
      recordOverwrite: async () => {},
      noteNotReversed: async () => {},
    },
    memoryEffects: {
      recordInsert: async () => {},
      recordUpdate: async () => {},
      recordDelete: async () => {},
    },
    recordOpsEvent: (e: { event: string; data: Record<string, unknown> }) => {
      recorder.events.push(e);
    },
    ...overrides,
  } as unknown as ToolExecutionContext;
}

function toolsFor(
  options: Parameters<typeof createBrowserTools>[1] = {},
  serviceOptions: Parameters<typeof createBrowserService>[0] = { engine: 'playwright' },
) {
  const service = createBrowserService(serviceOptions) as BrowserService & {
    dispose(): Promise<void>;
  };
  const tools = createBrowserTools(service, {
    allowPrivateNetwork: true,
    ...options,
  });
  const byName = new Map<string, LooseTool>(tools.map((t) => [t.definition.name, loosen(t)]));
  return { service, tools: byName };
}

const disposables: Array<{ dispose(): Promise<void> }> = [];
function track<T extends { dispose(): Promise<void> }>(s: T): T {
  disposables.push(s);
  return s;
}
afterEach(async () => {
  while (disposables.length) {
    await disposables.pop()!.dispose();
  }
});

describe('URL 策略（引擎无关）', () => {
  it('rejects non-http protocols', async () => {
    await expect(
      assertBrowserUrlAllowed('file:///etc/passwd', {}),
    ).rejects.toThrow(/protocol not allowed: file/);
  });

  it('rejects denied domains and non-allow-listed domains', async () => {
    await expect(
      assertBrowserUrlAllowed('http://evil.example.com/', { urlPolicy: { deny: ['evil.example.com'] } }),
    ).rejects.toThrow(/domain denied by policy/);
    await expect(
      assertBrowserUrlAllowed('http://bad.example.com/', {
        urlPolicy: { allow: ['good.example.com'] },
      }),
    ).rejects.toThrow(/domain not in allow list/);
  });

  it('rejects private network by default', async () => {
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:8080/', {}),
    ).rejects.toThrow();
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:8080/', { allowPrivateNetwork: true }),
    ).resolves.toBeUndefined();
  });

  it('normalizes trailing dot and IDN (评审 M1)', () => {
    expect(domainMatches('blocked.com', 'blocked.com.')).toBe(true);
    expect(domainMatches('*.example.com', 'example.com')).toBe(true);
    expect(domainMatches('*.example.com', 'sub.example.com')).toBe(true);
    expect(domainMatches('*.example.com', 'notexample.com')).toBe(false);
    // IDN 模式与 URL.hostname 的 punycode 对齐
    expect(domainMatches('блок.рф', 'xn--90ascm.xn--p1ai')).toBe(true);
    expect(domainMatches('*.блок.рф', 'xn--90ascm.xn--p1ai')).toBe(true);
  });

  it('redacts userinfo in invalid-url errors (no credential echo)', async () => {
    const err = await assertBrowserUrlAllowed('http://user:secret@', {}).catch((e: unknown) => e);
    expect(String(err)).toContain('//***@');
    expect(String(err)).not.toContain('secret');
  });
});

describe('browser tools (real stack)', () => {
  it.skipIf(!engineAvailable)(
    'navigate returns snapshot with refs and tag metadata',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx(rec);
      const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
      expect(nav.status).toBe(200);
      expect(nav.title).toBe('FormT');
      // sessionId = 浏览器会话句柄（显式 session 参数用），不是 ctx.sessionId
      expect(nav.sessionId).toMatch(/^bs_/);
      const snap = nav.snapshot as {
        items: Array<{ role: string; name: string; ref?: string; tags?: string[]; value?: string }>;
      };
      expect(snap.items.some((i) => i.role === 'heading' && i.name === 'Hello')).toBe(true);
      const submit = snap.items.find((i) => i.tags?.includes('submit'));
      expect(submit?.role).toBe('button');
      const pw = snap.items.find((i) => i.tags?.includes('password'));
      expect(pw?.ref).toBeDefined();
      const texts = snap.items.filter((i) => i.role === 'textbox');
      // user + password 两个输入
      expect(texts.length).toBeGreaterThanOrEqual(2);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'act persists form state across snapshots (fill/select/check)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx(rec);
      const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
      const items = nav.snapshot.items as Array<{ ref?: string; name: string; tags?: string[] }>;
      const userInput = items.find((i) => i.name === 'username')!;
      await tools.get('browser_act')!.handler(
        { action: 'fill', ref: userInput.ref, value: 'octopi' },
        ctx,
      );
      const snap2 = await tools.get('browser_snapshot')!.handler({}, ctx);
      expect((snap2.items as Array<{ value?: string }>).some((i) => i.value === 'octopi')).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'gate: password fill requires approval and denial blocks',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const confirmEffect = vi.fn(async () => 'deny');
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx(rec, { confirmEffect: confirmEffect as never });
      const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
      const pw = (nav.snapshot.items as Array<{ ref?: string; tags?: string[] }>).find((i) =>
        i.tags?.includes('password'),
      )!;
      await expect(
        tools.get('browser_act')!.handler({ action: 'fill', ref: pw.ref, value: 'hunter2' }, ctx),
      ).rejects.toThrow(/denied/);
      expect(confirmEffect).toHaveBeenCalledTimes(1);
      expect(rec.events.some((e) => e.event === 'browser.act.denied')).toBe(true);

      const confirmOk = vi.fn(async () => 'approve');
      const ctx2 = makeCtx(rec, { confirmEffect: confirmOk as never });
      const ok = await tools.get('browser_act')!.handler(
        { action: 'fill', ref: pw.ref, value: 'hunter2' },
        ctx2,
      );
      expect(ok.ok).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'gate: form submit click needs approval (deny blocks before submit)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const confirmEffect = vi.fn(async () => 'deny');
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx(rec, { confirmEffect: confirmEffect as never });
      const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
      const submit = (nav.snapshot.items as Array<{ ref?: string; tags?: string[] }>).find((i) =>
        i.tags?.includes('submit'),
      )!;
      await expect(
        tools.get('browser_act')!.handler({ action: 'click', ref: submit.ref }, ctx),
      ).rejects.toThrow(/denied/);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'gate: Enter-key form submit is caught at the request layer (评审 M2)；对象形态决策（生产通道）也认 (N1)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      // 生产确认通道返回 ConfirmOutcome 对象（gateway run-assembly 透传），不是裸字符串
      const confirmEffect = vi.fn(async () => ({ decision: 'deny' as const }));
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx(rec, { confirmEffect: confirmEffect as never });
      const nav = await tools.get('browser_navigate')!.handler(
        { url: `${baseUrl}postform` },
        ctx,
      );
      const input = (nav.snapshot.items as Array<{ ref?: string; name: string }>).find(
        (i) => i.name === 'query',
      )!;
      await tools.get('browser_act')!.handler(
        { action: 'press', ref: input.ref, key: 'Enter' },
        ctx,
      );
      // 请求层闸门拦下 POST：服务端零收件，账本留痕
      expect(postCount).toBe(0);
      expect(confirmEffect).toHaveBeenCalled();
      const gateDescs = confirmEffect.mock.calls.map(
        (c) => (c as unknown as [{ description?: string }])[0]?.description ?? '',
      );
      expect(gateDescs.some((d) => d.includes('POST'))).toBe(true);
      expect(
        rec.events.some((e) => e.event === 'browser.blocked' || e.event === 'browser.write.attempt'),
      ).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'confirm:off disables every gate (password fill passes without prompting)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const confirmEffect = vi.fn(async () => 'deny');
      const { service, tools } = toolsFor({ confirm: 'off' });
      track(service);
      const ctx = makeCtx(rec, { confirmEffect: confirmEffect as never });
      const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
      const pw = (nav.snapshot.items as Array<{ ref?: string; tags?: string[] }>).find((i) =>
        i.tags?.includes('password'),
      )!;
      const ok = await tools.get('browser_act')!.handler(
        { action: 'fill', ref: pw.ref, value: 'pw' },
        ctx,
      );
      expect(ok.ok).toBe(true);
      expect(confirmEffect).not.toHaveBeenCalled();
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'URL policy denies redirect targets at the request layer (评审 B2)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const { service, tools } = toolsFor({ urlPolicy: { deny: ['localhost'] } });
      track(service);
      const ctx = makeCtx(rec);
      await expect(
        tools.get('browser_navigate')!.handler({ url: `${baseUrl}redir` }, ctx),
      ).rejects.toThrow(/url_not_allowed|denied/);
      // 目标从没被真正取到
      expect(finalCount).toBe(0);
      expect(rec.events.some((e) => e.event === 'browser.blocked')).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'stale_ref after act-induced navigation (评审 M3)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx(rec);
      const nav = await tools.get('browser_navigate')!.handler({ url: `${baseUrl}nav` }, ctx);
      const link = (nav.snapshot.items as Array<{ ref?: string; role: string }>).find(
        (i) => i.role === 'link',
      )!;
      // 点击链接 = 导航离开
      await tools.get('browser_act')!.handler({ action: 'click', ref: link.ref }, ctx);
      // 旧 ref 必须 stale_ref fail-loud（而非 30s 超时）
      await expect(
        tools.get('browser_act')!.handler({ action: 'click', ref: link.ref }, ctx),
      ).rejects.toThrow(/stale_ref/);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'gate fail-closed: object ConfirmOutcome + undefined 都拒（评审 N1）',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const { service, tools } = toolsFor();
      track(service);
      const nav = async (ctx: ToolExecutionContext) => {
        const n = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
        return (n.snapshot.items as Array<{ ref?: string; tags?: string[] }>).find((i) =>
          i.tags?.includes('password'),
        )!;
      };
      // 生产通道对象形态 {decision:'deny'} 必须拒
      const denyObj = vi.fn(async () => ({ decision: 'deny' as const }));
      const pwA = await nav(makeCtx(rec, { confirmEffect: denyObj as never }));
      await expect(
        tools.get('browser_act')!.handler(
          { action: 'fill', ref: pwA.ref, value: 'x' },
          makeCtx(rec, { confirmEffect: denyObj as never }),
        ),
      ).rejects.toThrow(/denied/);
      // undefined 返回必须拒（fail-closed，不放行）
      const undef = vi.fn(async () => undefined);
      const pwB = await nav(makeCtx(rec, { confirmEffect: undef as never }));
      await expect(
        tools.get('browser_act')!.handler(
          { action: 'fill', ref: pwB.ref, value: 'x' },
          makeCtx(rec, { confirmEffect: undef as never }),
        ),
      ).rejects.toThrow(/denied/);
      // 对象形态 approve 系放行
      const okObj = vi.fn(async () => ({ decision: 'approve' as const }));
      const pwC = await nav(makeCtx(rec, { confirmEffect: okObj as never }));
      const ok = await tools.get('browser_act')!.handler(
        { action: 'fill', ref: pwC.ref, value: 'x' },
        makeCtx(rec, { confirmEffect: okObj as never }),
      );
      expect(ok.ok).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'stale_ref namespace does not collide across navigations (评审 N2)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx(rec);
      const navA = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
      const oldRef = (navA.snapshot.items as Array<{ ref?: string; name: string }>).find(
        (i) => i.name === 'username',
      )!.ref!;
      // 导航到另一页面（也有输入框）并快照：旧 ref 串不得命中新页面元素
      await tools.get('browser_navigate')!.handler({ url: `${baseUrl}postform` }, ctx);
      await tools.get('browser_snapshot')!.handler({}, ctx);
      await expect(
        tools.get('browser_act')!.handler(
          { action: 'fill', ref: oldRef, value: 'HACKED' },
          ctx,
        ),
      ).rejects.toThrow(/stale_ref/);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'popups (target=_blank) are closed and recorded (评审 N3)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx(rec);
      const nav = await tools.get('browser_navigate')!.handler(
        { url: `${baseUrl}popup` },
        ctx,
      );
      const link = (nav.snapshot.items as Array<{ ref?: string; role: string }>).find(
        (i) => i.role === 'link',
      )!;
      await tools.get('browser_act')!.handler({ action: 'click', ref: link.ref }, ctx);
      await new Promise((r) => setTimeout(r, 300));
      expect(
        rec.events.some(
          (e) =>
            e.event === 'browser.blocked' &&
            String((e.data as { reason?: string }).reason ?? '').includes('popup'),
        ),
      ).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'explicit session id cannot cross session owners (ownership check)',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const { service, tools } = toolsFor();
      track(service);
      const ctxA = makeCtx(rec, { sessionId: 'sess-A' });
      const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctxA);
      const ctxB = makeCtx(rec, { sessionId: 'sess-B' });
      await expect(
        tools.get('browser_snapshot')!.handler({ session: nav.sessionId }, ctxB),
      ).rejects.toThrow(/belongs to another session/);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'screenshot writes PNG via fileEffects and returns path (评审 B1 regression)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'octopi-browser-shot-'));
      try {
        const rec: Recorder = { events: [], writes: [] };
        const { service, tools } = toolsFor();
        track(service);
        const ctx = makeCtx(rec, { cwd: root });
        await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
        const shot = await tools.get('browser_screenshot')!.handler({}, ctx);
        expect(shot.path).toContain('browser-screenshots');
        expect(shot.mimeType).toBe('image/png');
        const bytes = await readFile(shot.path);
        expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!engineAvailable)('browser_close is idempotent and audited', async () => {
    const rec: Recorder = { events: [], writes: [] };
    const { service, tools } = toolsFor();
    track(service);
    const ctx = makeCtx(rec);
    await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
    const r1 = await tools.get('browser_close')!.handler({}, ctx);
    expect(r1.closed).toBe(true);
    const r2 = await tools.get('browser_close')!.handler({}, ctx);
    expect(r2.closed).toBe(false);
    expect(rec.events.filter((e) => e.event === 'browser.close').length).toBe(2);
  }, 30_000);
});

describe('session service', () => {
  it.skipIf(!engineAvailable)(
    'acquire is single-flight under concurrency (评审 B4)',
    async () => {
      const service = track(createBrowserService({ engine: 'playwright' }));
      const [a, b] = await Promise.all([
        service.acquire('k1'),
        service.acquire('k1'),
        service.acquire('k1'),
      ]);
      expect(a.id).toBe(b.id);
      await service.close('k1');
    },
    30_000,
  );

  it.skipIf(!engineAvailable)('dispose closes sessions and refuses further acquire', async () => {
    const service = createBrowserService({ engine: 'playwright' });
    await service.acquire('k2');
    await service.dispose();
    await expect(service.acquire('k3')).rejects.toThrow(/disposed/);
    expect(await service.get('k2')).toBeUndefined();
  }, 30_000);

  it('snapshot before navigate does not silently launch a browser', async () => {
    const rec: Recorder = { events: [], writes: [] };
    const { service, tools } = toolsFor();
    track(service);
    const ctx = makeCtx(rec);
    await expect(tools.get('browser_snapshot')!.handler({}, ctx)).rejects.toThrow(
      /browser_session_not_found/,
    );
    await expect(
      tools.get('browser_act')!.handler({ action: 'wait', ms: 1 }, ctx),
    ).rejects.toThrow(/browser_session_not_found/);
  });
});

// ── P2：attach 真实浏览器 / 持久 profile / upload / extract / 挑战 / xhr 写闸 ──

describe('P2 (real stack)', () => {
  it.skipIf(!engineAvailable)(
    'attach drives a real browser over CDP, policy still enforced, close does not kill it (P2)',
    async () => {
      // 自起一个带 CDP 端口的"用户浏览器"（临时端口防冲突）
      const port = await new Promise<number>((resolve) => {
        const probe = createNetServer();
        probe.listen(0, '127.0.0.1', () => {
          const p = (probe.address() as AddressInfo).port;
          probe.close(() => resolve(p));
        });
      });
      const pw = (await import('playwright-core')) as unknown as {
        chromium: {
          launch(options?: unknown): Promise<{
            isConnected(): boolean;
            close(): Promise<void>;
            newContext(): Promise<{
              newPage(): Promise<{ goto(url: string): Promise<unknown>; close(): Promise<void> }>;
              close(): Promise<void>;
            }>;
            contexts(): Array<{ newPage(): Promise<{ goto(url: string): Promise<unknown>; close(): Promise<void> }> }>;
          }>;
          connectOverCDP(endpoint: string): Promise<{
            contexts(): Array<{
              newPage(): Promise<{ goto(url: string): Promise<unknown>; close(): Promise<void> }>;
            }>;
            close(): Promise<void>;
          }>;
        };
      };
      const userBrowser = await pw.chromium.launch({
        headless: true,
        args: [`--remote-debugging-port=${port}`],
      });
      try {
        const { service, tools } = toolsFor(
          { urlPolicy: { deny: ['localhost'] } },
          { engine: 'cdp-attach', attach: { endpoint: `http://127.0.0.1:${port}` } },
        );
        track(service);
        const rec: Recorder = { events: [], writes: [] };
        const ctx = makeCtx(rec, {
          confirmEffect: vi.fn(async () => 'approve') as never,
        });
        const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
        expect(nav.snapshot.items.length).toBeGreaterThan(0);
        const infos = await service.list();
        expect(infos[0]?.identity).toEqual({ kind: 'attach' });
        // 请求层策略在 attach 会话上同样收口（302 目标被拦）
        await expect(
          tools.get('browser_navigate')!.handler({ url: `${baseUrl}redir` }, ctx),
        ).rejects.toThrow(/url_not_allowed/);
        // N2：用户侧标签（同 context、无 opener）不被 attach 守卫误关
        const helper = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        try {
          const userTab = await helper.contexts()[0].newPage();
          await userTab.goto(`${baseUrl}other`);
          await new Promise((r) => setTimeout(r, 300));
          await userTab.goto(`${baseUrl}nav`); // 仍可导航 = 未被守卫关掉
          await userTab.close();
        } finally {
          await helper.close();
        }
        await service.dispose();
        // 关闭 = 断开连接；"用户浏览器"必须还活着且可继续工作
        expect(userBrowser.isConnected()).toBe(true);
        const userContext = await userBrowser.newContext();
        const userTab = await userContext.newPage();
        await userTab.goto(`${baseUrl}other`);
        await userContext.close();
      } finally {
        await userBrowser.close();
      }
    },
    60_000,
  );

  it.skipIf(!engineAvailable)(
    'persistent profile round-trips cookies across sessions (P2)',
    async () => {
      const profileDir = await mkdtemp(join(tmpdir(), 'octopi-profile-'));
      const opts = { profiles: { persist: true, defaultProfile: 'p1' }, profileDir };
      try {
        {
          const { service, tools } = toolsFor(opts);
          track(service);
          const ctx = makeCtx({ events: [], writes: [] });
          await tools.get('browser_navigate')!.handler({ url: `${baseUrl}set-cookie` }, ctx);
          // 关闭 = 归档 storageState
          await tools.get('browser_close')!.handler({}, ctx);
        }
        expect(existsSync(join(profileDir, 'p1.json'))).toBe(true);
        {
          const { service, tools } = toolsFor(opts);
          track(service);
          const ctx = makeCtx({ events: [], writes: [] });
          const nav = await tools.get('browser_navigate')!.handler(
            { url: `${baseUrl}echo-cookie` },
            ctx,
          );
          expect(JSON.stringify(nav.snapshot)).toContain('octopi_test=cookievalue123');
        }
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(!engineAvailable)(
    'upload: fileUpload gate denies / approves; audit records the outbound file (P2)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'octopi-up-'));
      const tmpFile = join(root, 'doc.txt');
      await writeFile(tmpFile, 'hello upload');
      const rec: Recorder = { events: [], writes: [] };
      const deny = vi.fn(async () => ({ decision: 'deny' as const }));
      const approve = vi.fn(async () => ({ decision: 'approve' as const }));
      const { service, tools } = toolsFor({ confirm: 'standard' });
      track(service);
      try {
        const ctx = makeCtx(rec, { cwd: root, confirmEffect: deny as never });
        const nav = await tools.get('browser_navigate')!.handler({ url: `${baseUrl}upload` }, ctx);
        const fileRef = (
          nav.snapshot.items as Array<{ ref?: string; tags?: string[] }>
        ).find((i) => i.tags?.includes('file'))!.ref!;
        await expect(
          tools.get('browser_act')!.handler(
            { action: 'upload', ref: fileRef, path: 'doc.txt' },
            makeCtx(rec, { cwd: root, confirmEffect: deny as never }),
          ),
        ).rejects.toThrow(/denied/);
        expect(rec.events.some((e) => e.event === 'browser.act.denied')).toBe(true);
        const ok = await tools.get('browser_act')!.handler(
          { action: 'upload', ref: fileRef, path: 'doc.txt' },
          makeCtx(rec, { cwd: root, confirmEffect: approve as never }),
        );
        expect(ok.ok).toBe(true);
        expect(approve).toHaveBeenCalled();
        expect(
          rec.events.some(
            (e) => e.event === 'browser.upload' && String(e.data.path).endsWith('doc.txt'),
          ),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'extract returns real DOM data; unmatched fields are null (P2)',
    async () => {
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx({ events: [], writes: [] });
      await tools.get('browser_navigate')!.handler({ url: `${baseUrl}extract` }, ctx);
      const out = await tools.get('browser_extract')!.handler(
        {
          fields: {
            title: { selector: 'h1.title' },
            items: { selector: 'li.item', multiple: true },
            missing: { selector: '.nope' },
            attr: { selector: 'h1.title', attribute: 'class' },
          },
        },
        ctx,
      );
      expect(out.data).toEqual({
        title: 'Foo',
        items: ['a', 'b'],
        missing: null,
        attr: 'title',
      });
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'challenge detection surfaces marker + HITL hint (P2)',
    async () => {
      const { service, tools } = toolsFor();
      track(service);
      const ctx = makeCtx({ events: [], writes: [] });
      const nav = await tools.get('browser_navigate')!.handler(
        { url: `${baseUrl}challenge` },
        ctx,
      );
      expect(nav.challenge?.kind).toBe('interstitial');
      expect(nav.challenge?.marker).toBe('just a moment');
      expect(String(nav.hint)).toContain('ask_user');
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'xhr writes: gated once per method+origin, approval cache dedupes (P2)',
    async () => {
      postCount = 0;
      const approve = vi.fn(async () => ({ decision: 'approve' as const }));
      const { service, tools } = toolsFor({ confirm: 'strict' });
      track(service);
      const ctx = makeCtx({ events: [], writes: [] }, { confirmEffect: approve as never });
      await tools.get('browser_navigate')!.handler({ url: `${baseUrl}xhr` }, ctx);
      await new Promise((r) => setTimeout(r, 600));
      expect(postCount).toBe(2); // 两次页内 POST 都放行
      expect(approve).toHaveBeenCalledTimes(1); // 同 method+origin 只确认一次（会话级缓存）
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'xhr writes blocked at request layer when denied (P2)',
    async () => {
      postCount = 0;
      const deny = vi.fn(async () => ({ decision: 'deny' as const }));
      const { service, tools } = toolsFor({ confirm: 'strict' });
      track(service);
      const rec: Recorder = { events: [], writes: [] };
      const ctx = makeCtx(rec, { confirmEffect: deny as never });
      await tools.get('browser_navigate')!.handler({ url: `${baseUrl}xhr` }, ctx);
      await new Promise((r) => setTimeout(r, 600));
      expect(postCount).toBe(0);
      expect(rec.events.some((e) => e.event === 'browser.write.blocked')).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'attach sessions report engine cdp-attach (评审 F3)',
    async () => {
      const port = await new Promise<number>((resolve) => {
        const probe = createNetServer();
        probe.listen(0, '127.0.0.1', () => {
          const p = (probe.address() as AddressInfo).port;
          probe.close(() => resolve(p));
        });
      });
      const pw = (await import('playwright-core')) as unknown as {
        chromium: { launch(options?: unknown): Promise<{ close(): Promise<void> }> };
      };
      const userBrowser = await pw.chromium.launch({
        headless: true,
        args: [`--remote-debugging-port=${port}`],
      });
      try {
        const { service, tools } = toolsFor(
          {},
          { engine: 'cdp-attach', attach: { endpoint: `http://127.0.0.1:${port}` } },
        );
        track(service);
        const ctx = makeCtx({ events: [], writes: [] });
        const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
        expect(nav.engine).toBe('cdp-attach');
        const infos = await service.list();
        expect(infos[0]?.engine).toBe('cdp-attach');
      } finally {
        await userBrowser.close();
      }
    },
    60_000,
  );

  it.skipIf(!engineAvailable)(
    'rel=noopener popups are also closed in managed mode (评审 F2)',
    async () => {
      const { service, tools } = toolsFor();
      track(service);
      const rec: Recorder = { events: [], writes: [] };
      const ctx = makeCtx(rec);
      // noopener 弹窗的 opener() 为 null——managed 模式必须按模式分支全关，不能只认 opener
      const nav = await tools.get('browser_navigate')!.handler({ url: `${baseUrl}popup-noopener` }, ctx);
      const link = (nav.snapshot.items as Array<{ ref?: string; role: string }>).find(
        (i) => i.role === 'link',
      )!;
      await tools.get('browser_act')!.handler({ action: 'click', ref: link.ref }, ctx);
      await new Promise((r) => setTimeout(r, 300));
      expect(
        rec.events.some(
          (e) =>
            e.event === 'browser.blocked' &&
            String((e.data as { reason?: string }).reason ?? '').includes('popup'),
        ),
      ).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'late approval never sends the write (评审 F1 regression)',
    async () => {
      postCount = 0;
      // 确认决议迟到（> gate 预算）：请求必须 failRequest，迟到批准不得发出写
      const late = vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve({ decision: 'approve' as const }), 1500)),
      );
      const { service, tools } = toolsFor({ timeoutMs: 1000, confirm: 'strict' });
      track(service);
      const ctx = makeCtx({ events: [], writes: [] }, { confirmEffect: late as never });
      const nav = await tools.get('browser_navigate')!.handler({ url: `${baseUrl}postform` }, ctx);
      const input = (nav.snapshot.items as Array<{ ref?: string; name: string }>).find(
        (i) => i.name === 'query',
      )!;
      await tools
        .get('browser_act')!.handler({ action: 'fill', ref: input.ref, value: 'x' }, ctx)
        .catch(() => {});
      // Enter 提交：无 DOM 预闸，纯请求层路径——请求被暂停等待确认，动作层超时后
      // 迟到的批准不得把 POST 发出去（这正是评审 F1 的复现场景）
      await tools
        .get('browser_act')!.handler({ action: 'press', ref: input.ref, key: 'Enter' }, ctx)
        .catch(() => {
          /* 动作层超时/被拒都可接受——关键是写不得发出 */
        });
      await new Promise((r) => setTimeout(r, 2000));
      expect(postCount).toBe(0);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'corrupt profile state is quarantined and launch falls back fresh (评审 F6)',
    async () => {
      const profileDir = await mkdtemp(join(tmpdir(), 'octopi-corrupt-'));
      await writeFile(join(profileDir, 'p1.json'), '{not json');
      const { service, tools } = toolsFor({
        profiles: { persist: true, defaultProfile: 'p1' },
        profileDir,
      });
      track(service);
      try {
        const ctx = makeCtx({ events: [], writes: [] });
        const nav = await tools.get('browser_navigate')!.handler({ url: baseUrl }, ctx);
        expect(nav.snapshot.items.length).toBeGreaterThan(0);
        // 坏档被隔离（保留现场），不是被静默删
        const names = await (await import('node:fs/promises')).readdir(profileDir);
        expect(names.some((n) => n.includes('.corrupt-'))).toBe(true);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'extract honors maxItems / aggregate char budget and reports counts (评审 F9/N5)',
    async () => {
      // 聚合字符预算：全字段共享 budget，截断如实标记
      const s1 = toolsFor({ snapshotMaxChars: 2 });
      track(s1.service);
      const ctx1 = makeCtx({ events: [], writes: [] });
      await s1.tools.get('browser_navigate')!.handler({ url: `${baseUrl}extract` }, ctx1);
      const out1 = await s1.tools
        .get('browser_extract')!
        .handler({ fields: { long: { selector: 'h1.title' } } }, ctx1);
      expect(out1.data.long).toBe('Fo');
      expect(out1.truncated).toBe(true);
      // maxItems 截断 + counts 报命中总数（截断≠全量）+ 属性缺失 = null
      const s2 = toolsFor();
      track(s2.service);
      const ctx2 = makeCtx({ events: [], writes: [] });
      await s2.tools.get('browser_navigate')!.handler({ url: `${baseUrl}extract` }, ctx2);
      const out2 = await s2.tools.get('browser_extract')!.handler(
        {
          fields: {
            items: { selector: 'li.item', multiple: true, maxItems: 1 },
            noattr: { selector: 'h1.title', attribute: 'data-x' },
          },
        },
        ctx2,
      );
      expect(out2.data.items).toEqual(['a']);
      expect(out2.truncated).toBe(true);
      expect(out2.counts).toEqual({ items: 2 });
      expect(out2.data.noattr).toBeNull(); // 属性缺失 = null（F13）
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'explicit confirm:standard keeps page-script writes ungated (no cache poisoning)',
    async () => {
      postCount = 0;
      const gate = vi.fn(async () => ({ decision: 'deny' as const }));
      const { service, tools } = toolsFor({ confirm: 'standard' });
      track(service);
      const ctx = makeCtx({ events: [], writes: [] }, { confirmEffect: gate as never });
      await tools.get('browser_navigate')!.handler({ url: `${baseUrl}xhr` }, ctx);
      await new Promise((r) => setTimeout(r, 600));
      expect(postCount).toBe(2); // 显式关闸：放行且不询问
      expect(gate).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('confirmGateEnabled maps the three tiers (single source of truth)', () => {
    // 缺省 standard：文档级过闸、页内 XHR 不闸
    expect(confirmGateEnabled(undefined, 'formSubmit')).toBe(true);
    expect(confirmGateEnabled(undefined, 'passwordField')).toBe(true);
    expect(confirmGateEnabled(undefined, 'fileUpload')).toBe(true);
    expect(confirmGateEnabled(undefined, 'xhr')).toBe(false);
    // strict：所有非 GET 过闸
    expect(confirmGateEnabled('strict', 'xhr')).toBe(true);
    expect(confirmGateEnabled('strict', 'formSubmit')).toBe(true);
    // standard：显式与缺省同义
    expect(confirmGateEnabled('standard', 'xhr')).toBe(false);
    expect(confirmGateEnabled('standard', 'formSubmit')).toBe(true);
    // off：全放开
    expect(confirmGateEnabled('off', 'formSubmit')).toBe(false);
    expect(confirmGateEnabled('off', 'passwordField')).toBe(false);
    expect(confirmGateEnabled('off', 'fileUpload')).toBe(false);
    expect(confirmGateEnabled('off', 'xhr')).toBe(false);
  });

  it.skipIf(!engineAvailable)(
    'page-script writes are ungated at the default standard tier (2026-11-20)',
    async () => {
      postCount = 0;
      const gate = vi.fn(async () => ({ decision: 'deny' as const }));
      const { service, tools } = toolsFor({});
      track(service);
      const ctx = makeCtx({ events: [], writes: [] }, { confirmEffect: gate as never });
      await tools.get('browser_navigate')!.handler({ url: `${baseUrl}xhr` }, ctx);
      await new Promise((r) => setTimeout(r, 600));
      expect(postCount).toBe(2); // 缺省不问询直接放行（页内 beacon 不打扰）
      expect(gate).not.toHaveBeenCalled();
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'request-layer gate sees RunScope via re-entry; approved writes land (评审 N1)',
    async () => {
      postCount = 0;
      const seenScopes: Array<string | undefined> = [];
      const gate = vi.fn(async () => {
        // 生产 confirmEffect 按 getRunScope() 定界——CDP 回调里必须拿得到 scope
        seenScopes.push(getRunScope()?.sessionId);
        return { decision: 'approve' as const };
      });
      const { service, tools } = toolsFor({ confirm: 'strict' });
      track(service);
      const ctx = makeCtx({ events: [], writes: [] }, { confirmEffect: gate as never });
      const scope = { sessionId: ctx.sessionId, agentId: 'agent-1' } as RunScope;
      await runInScope(scope, async () => {
        await tools.get('browser_navigate')!.handler({ url: `${baseUrl}xhr` }, ctx);
      });
      await new Promise((r) => setTimeout(r, 600));
      expect(postCount).toBe(2); // 正向路径：批准后写真落库
      expect(gate).toHaveBeenCalled();
      expect(seenScopes.length).toBeGreaterThan(0);
      expect(seenScopes.every((s) => s === ctx.sessionId)).toBe(true);
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    'approval cache is keyed by full origin incl. port (评审 F4)',
    async () => {
      // 第二个服务：同主机（127.0.0.1）不同端口 = 不同 origin
      let peerPosts = 0;
      const peer = createServer((req, res) => {
        if (req.method === 'POST') peerPosts += 1;
        res.end('ok');
      });
      await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
      const peerPort = (peer.address() as AddressInfo).port;
      try {
        postCount = 0;
        const gate = vi.fn(async () => ({ decision: 'approve' as const }));
        const { service, tools } = toolsFor({ confirm: 'strict' });
        track(service);
        const ctx = makeCtx({ events: [], writes: [] }, { confirmEffect: gate as never });
        await tools.get('browser_navigate')!.handler(
          { url: `${baseUrl}xhr-two?peer=${peerPort}` },
          ctx,
        );
        await new Promise((r) => setTimeout(r, 600));
        expect(postCount).toBe(1);
        expect(peerPosts).toBe(1);
        // 两个 origin 各确认一次（hostname 键只会问一次，正是 F4 缺陷的判别点）
        expect(gate).toHaveBeenCalledTimes(2);
      } finally {
        await new Promise<void>((r) => peer.close(() => r()));
      }
    },
    30_000,
  );

  it('close-failure evict does not drop a relaunched session on the same key (评审 N3)', async () => {
    // 假 port：可控的 launch/close 行为（并发交错是纯 service 语义，不需要真浏览器）
    let seq = 0;
    let releaseClose!: () => void;
    let firstCloseStarted!: () => void;
    const started = new Promise<void>((r) => (firstCloseStarted = r));
    const port = {
      async launch(options: { ownerKey?: string }) {
        seq += 1;
        const id = `bs_fake_${seq}` as never;
        return {
          id,
          engine: 'playwright',
          identity: { kind: 'incognito' },
          ownerKey: options.ownerKey ?? '',
          url: 'about:blank',
          goto: async () => ({ url: 'about:blank', title: '' }),
          snapshot: async () => ({ url: 'about:blank', title: '', items: [] }),
          inspectAction: async () => ({ action: { kind: 'wait', ms: 0 }, sensitive: false }),
          act: async () => ({ ok: true, url: 'about:blank', title: '' }),
          screenshot: async () => ({ mimeType: 'image/png', data: new Uint8Array() }),
          detectChallenge: async () => undefined,
          extract: async () => ({ data: {}, truncated: false }),
          close:
            seq === 1
              ? () =>
                  new Promise<void>((_, rej) => {
                    firstCloseStarted();
                    releaseClose = () => rej(new Error('close boom'));
                  })
              : async () => {},
        } as never;
      },
      async attach() {
        throw new Error('n/a');
      },
      async list() {
        return [];
      },
    };
    const service = new DefaultBrowserService(port as never, {});
    const p1 = await service.acquire('k');
    const closeP = service.close('k'); // S1 关闭挂起中
    await started;
    const p2 = await service.acquire('k'); // closing 命中 → 重新 launch（S2）
    expect(p2.id).not.toBe(p1.id);
    releaseClose(); // S1 close 失败
    await expect(closeP).rejects.toThrow('close boom');
    // 失败路径的 evict 不得误删同 key 的 S2（身份判定）
    expect((await service.get('k'))?.id).toBe(p2.id);
    await service.dispose();
  });
});

describe('assembly (config → tool registration)', () => {
  const baseCtx = {
    providers: new Map(),
    octopiHome: asmHome,
    askUser: async () => 'skip',
  } as never;

  it('enabled:false registers no browser tools', async () => {
    const tools = await assembleGlobalTools({
      ...(baseCtx as object),
      browser: { enabled: false },
    } as never);
    expect(tools.some((t) => t.definition.name === 'browser_navigate')).toBe(false);
    expect(tools.some((t) => t.definition.name === 'browser_close')).toBe(false);
  });

  it('unimplemented engines fail loud at assembly (no silent degrade)', async () => {
    await expect(
      assembleGlobalTools({
        ...(baseCtx as object),
        browser: { engine: 'cloud' },
      } as never),
    ).rejects.toThrow(/not_implemented/);
    await expect(
      assembleGlobalTools({
        ...(baseCtx as object),
        browser: { engine: 'no-such-engine' },
      } as never),
    ).rejects.toThrow(/not_implemented/);
  });

  it('P3 stealth engines assemble; missing deps fail loud at launch', async () => {
    for (const engine of ['rebrowser', 'camoufox', 'stealth'] as const) {
      const tools = await assembleGlobalTools({
        ...(baseCtx as object),
        browser: { engine },
      } as never);
      expect(
        tools.some((t) => t.definition.name === 'browser_navigate'),
        `engine=${engine} should register tools`,
      ).toBe(true);
    }
  });

  it('default config registers all six browser_* tools', async () => {
    const tools = await assembleGlobalTools({
      ...(baseCtx as object),
      browser: {},
    } as never);
    const names = tools.map((t) => t.definition.name);
    for (const n of [
      'browser_navigate',
      'browser_snapshot',
      'browser_act',
      'browser_screenshot',
      'browser_close',
    ]) {
      expect(names).toContain(n);
    }
  });
});

// ── P3：stealth 双后端 / route-walk 策略 / fallback 链 / humanize ──

describe('P3: route-walk 请求策略（Firefox 后端语义；Chromium 上验证实现）', () => {
  it.skipIf(!engineAvailable)(
    'completes a 307 method-preserving walk with the write gate on hop 1',
    async () => {
      postCount = 0;
      const gate = vi.fn(async () => ({ decision: 'approve' as const }));
      const service = track(new DefaultBrowserService(new PlaywrightBrowserPort({ policyMode: 'route-walk' }) as never, {}));
      const tools = createBrowserTools(service, {
        allowPrivateNetwork: true,
        confirm: 'strict',
        engine: 'playwright',
      });
      const byName = new Map(tools.map((t) => [t.definition.name, loosen(t)]));
      const ctx = makeCtx({ events: [], writes: [] }, { confirmEffect: gate as never });
      await byName.get('browser_navigate')!.handler({ url: `${baseUrl}xhr307` }, ctx);
      await new Promise((r) => setTimeout(r, 800));
      expect(gate.mock.calls.length).toBeGreaterThanOrEqual(1); // hop1 过写闸
      expect(postCount).toBe(1); // 307 保留 POST、walk 把最终响应送达
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    're-checks redirect hops: a denied hop target blocks the preserved write',
    async () => {
      postCount = 0;
      const gate = vi.fn(async () => ({ decision: 'approve' as const }));
      const service = track(new DefaultBrowserService(new PlaywrightBrowserPort({ policyMode: 'route-walk' }) as never, {}));
      const tools = createBrowserTools(service, {
        allowPrivateNetwork: true,
        confirm: 'strict',
        engine: 'playwright',
        urlPolicy: { deny: ['localhost'] },
      });
      const byName = new Map(tools.map((t) => [t.definition.name, loosen(t)]));
      const ctx = makeCtx({ events: [], writes: [] }, { confirmEffect: gate as never });
      // /xhr307ext → fetch POST /redir307ext（127.0.0.1，过闸批准）→ 307 → localhost/submit（denied）
      await byName.get('browser_navigate')!.handler({ url: `${baseUrl}xhr307ext` }, ctx);
      await new Promise((r) => setTimeout(r, 800));
      expect(postCount).toBe(0); // 跳转目标被逐跳复验拦下（无 walk 时网络栈会偷送成功）
    },
    30_000,
  );

  it.skipIf(!engineAvailable)(
    're-checks GET redirect targets too (the B2 scenario on route-walk)',
    async () => {
      finalCount = 0;
      const service = track(new DefaultBrowserService(new PlaywrightBrowserPort({ policyMode: 'route-walk' }) as never, {}));
      const tools = createBrowserTools(service, {
        allowPrivateNetwork: true,
        engine: 'playwright',
        urlPolicy: { deny: ['localhost'] },
      });
      const byName = new Map(tools.map((t) => [t.definition.name, loosen(t)]));
      const ctx = makeCtx({ events: [], writes: [] });
      // /redir 302 → localhost/final（denied 主机）：跳转目标必须复验
      await byName
        .get('browser_navigate')!
        .handler({ url: `${baseUrl}redir` }, ctx)
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      expect(finalCount).toBe(0);
    },
    30_000,
  );
});

describe('P3: stealth fallback 链', () => {
  function stubService(name: string) {
    const acquired: string[] = [];
    const closed: string[] = [];
    const sessions = new Map<string, { id: string; ownerKey: string }>();
    const service = {
      async acquire(key: string) {
        acquired.push(key);
        const s = { id: `bs-${name}-${key}`, ownerKey: key };
        sessions.set(key, s);
        return s;
      },
      async get(key: string) {
        return sessions.get(key);
      },
      async byId(id: string) {
        for (const s of sessions.values()) if (s.id === id) return s;
        return undefined;
      },
      async close(key: string) {
        closed.push(key);
        return sessions.delete(key);
      },
      async list() {
        return [];
      },
      async dispose() {
        sessions.clear();
      },
    } as unknown as BrowserService;
    return { service, acquired, closed };
  }

  it('rotates per key, stops at chain end, and lands new acquires on the next backend', async () => {
    const a = stubService('a');
    const b = stubService('b');
    const svc = new StealthFallbackService([a.service, b.service]);
    expect(await svc.rotateAfterChallenge('k1')).toBe(true);
    expect(a.closed).toContain('k1');
    expect(await svc.rotateAfterChallenge('k1')).toBe(false); // 链穷尽 → HITL
    // per-key：k2 不受 k1 影响，从链头开始
    expect(await svc.rotateAfterChallenge('k2')).toBe(true);
    await svc.acquire('k3');
    expect(a.acquired).toContain('k3');
    await svc.rotateAfterChallenge('k3');
    await svc.acquire('k3');
    expect(b.acquired).toContain('k3'); // 轮换后落下一后端
  });

  it('parseFallbackChain: 默认链 / 保序去重 / 白名单 fail-loud', () => {
    expect(parseFallbackChain()).toEqual(['rebrowser', 'camoufox']);
    expect(parseFallbackChain('camoufox->rebrowser->camoufox')).toEqual(['camoufox', 'rebrowser']);
    expect(() => parseFallbackChain('cloud')).toThrow(/invalid_config/);
    expect(() => parseFallbackChain('->')).toThrow(/empty/);
  });
});

describe('P3: 挑战轮换编排（工具层）', () => {
  function stubChallengeService(opts: { rotateResult: () => boolean; onGoto?: () => void }) {
    const counters = { gotos: 0, rotates: 0 };
    const session = {
      id: 'bs-stub' as const,
      engine: 'rebrowser',
      ownerKey: 'sess-1',
      url: 'https://example.com/',
      async goto() {
        counters.gotos += 1;
        opts.onGoto?.();
        return { url: 'https://example.com/', title: 'Just a moment...' };
      },
      async snapshot() {
        return { url: 'https://example.com/', title: 'Just a moment...', items: [], truncated: false };
      },
      async detectChallenge() {
        return { kind: 'interstitial', marker: 'just a moment' };
      },
    };
    const service = {
      async acquire() {
        return session;
      },
      async get() {
        return session;
      },
      async byId() {
        return session;
      },
      async close() {
        return true;
      },
      async list() {
        return [];
      },
      async dispose() {},
      async rotateAfterChallenge() {
        counters.rotates += 1;
        return opts.rotateResult();
      },
    } as unknown as BrowserService;
    return { service, counters };
  }

  it('retries once on the next backend, then surfaces the challenge (HITL)', async () => {
    const { service, counters } = stubChallengeService({ rotateResult: () => true });
    const tools = createBrowserTools(service, { allowPrivateNetwork: true, engine: 'playwright' });
    const byName = new Map(tools.map((t) => [t.definition.name, loosen(t)]));
    const out = await byName
      .get('browser_navigate')!
      .handler({ url: 'https://example.com/' }, makeCtx({ events: [], writes: [] }));
    expect(counters.rotates).toBe(1); // 只轮换一次（有界）
    expect(counters.gotos).toBe(2); // 原跑 + 轮换后重试
    expect(out.challenge).toBeTruthy(); // 仍命中 → HITL 出口
    expect(out.hint).toMatch(/ask the user/);
  });

  it('no rotation primitive = straight to HITL (single-engine services)', async () => {
    const { service, counters } = stubChallengeService({ rotateResult: () => true });
    delete (service as unknown as Record<string, unknown>).rotateAfterChallenge;
    const tools = createBrowserTools(service, { allowPrivateNetwork: true, engine: 'playwright' });
    const byName = new Map(tools.map((t) => [t.definition.name, loosen(t)]));
    const out = await byName
      .get('browser_navigate')!
      .handler({ url: 'https://example.com/' }, makeCtx({ events: [], writes: [] }));
    expect(counters.gotos).toBe(1);
    expect(out.challenge).toBeTruthy();
  });
});

describe('P3: humanize 拟人化节流', () => {
  it('effectiveHumanize: 显式优先 / stealth 系缺省启用 / 其余关闭', () => {
    expect(effectiveHumanize({})).toBeUndefined();
    expect(effectiveHumanize({ engine: 'playwright' })).toBeUndefined();
    expect(effectiveHumanize({ engine: 'stealth' })?.typingDelayMs).toEqual([20, 80]);
    expect(effectiveHumanize({ engine: 'rebrowser' })?.maxRetries).toBe(2);
    expect(effectiveHumanize({ engine: 'camoufox' })?.actionJitterMs).toEqual([100, 600]);
    // 显式覆盖（含置零关闭）
    expect(
      effectiveHumanize({ engine: 'stealth', stealth: { humanize: { maxRetries: 0, typingDelayMs: [0, 0] } } }),
    ).toMatchObject({ maxRetries: 0, typingDelayMs: [0, 0] });
  });

  it.skipIf(!engineAvailable)(
    'types per key with typingDelayMs (real stack)',
    async () => {
      const { service, tools } = toolsFor({
        stealth: { humanize: { typingDelayMs: [50, 50], actionJitterMs: [0, 0] } },
      });
      track(service);
      const ctx = makeCtx({ events: [], writes: [] });
      const nav = await tools.get('browser_navigate')!.handler({ url: `${baseUrl}postform` }, ctx);
      const input = (nav.snapshot.items as Array<{ ref?: string; name: string }>).find(
        (i) => i.name === 'query',
      )!;
      const started = Date.now();
      await tools.get('browser_act')!.handler({ action: 'fill', ref: input.ref, value: 'abcd' }, ctx);
      const elapsed = Date.now() - started;
      // 4 键 × 50ms/键，阈值打八折容 timer 粗化抖动；无逐键路径时实测 <150ms
      expect(elapsed).toBeGreaterThanOrEqual(4 * 40);
    },
    30_000,
  );

  it('retries transient act failures up to maxRetries; never retries stale_ref', async () => {
    const makeSession = (fail: (n: number) => Error | undefined) => {
      const counters = { attempts: 0 };
      const session = {
        id: 'bs-s',
        engine: 'playwright',
        ownerKey: 'sess-1',
        url: 'https://example.com/',
        async inspectAction() {
          return { sensitive: false as const, target: 'x' };
        },
        async act() {
          counters.attempts += 1;
          const err = fail(counters.attempts);
          if (err) throw err;
          return { ok: true };
        },
      };
      const service = {
        async acquire() {
          return session;
        },
        async get() {
          return session;
        },
        async byId() {
          return session;
        },
        async close() {
          return true;
        },
        async list() {
          return [];
        },
        async dispose() {},
      } as unknown as BrowserService;
      return { service, counters };
    };

    // 瞬态失败：第 1/2 次抛、第 3 次成功（maxRetries=2 用满）
    const flaky = makeSession((n) => (n < 3 ? new Error('transient boom') : undefined));
    const tools1 = createBrowserTools(flaky.service, {
      allowPrivateNetwork: true,
      engine: 'stealth',
      stealth: { humanize: { actionJitterMs: [0, 0], maxRetries: 2 } },
    });
    const byName1 = new Map(tools1.map((t) => [t.definition.name, loosen(t)]));
    const out = await byName1
      .get('browser_act')!
      .handler({ action: 'click', ref: 'r1-e1' }, makeCtx({ events: [], writes: [] }));
    expect(flaky.counters.attempts).toBe(3);
    expect(out).toEqual({ ok: true });

    // stale_ref 是契约错误非瞬态：一次即抛
    const stale = makeSession(() => new Error('stale_ref: r1-e1 (epoch 1)'));
    const tools2 = createBrowserTools(stale.service, {
      allowPrivateNetwork: true,
      engine: 'stealth',
      stealth: { humanize: { actionJitterMs: [0, 0], maxRetries: 2 } },
    });
    const byName2 = new Map(tools2.map((t) => [t.definition.name, loosen(t)]));
    await expect(
      byName2.get('browser_act')!.handler({ action: 'click', ref: 'r1-e1' }, makeCtx({ events: [], writes: [] })),
    ).rejects.toThrow(/stale_ref/);
    expect(stale.counters.attempts).toBe(1);
  });
});
