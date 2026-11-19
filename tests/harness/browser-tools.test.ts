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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AddressInfo } from 'node:net';

import { createBrowserService } from '../../packages/engine/src/integration/browser/index.js';
import {
  createBrowserTools,
  domainMatches,
  assertBrowserUrlAllowed,
} from '../../packages/engine/src/harness/extension/plugin-ecosystem/tools/browser.js';
import type { BrowserService } from '../../packages/engine/src/harness/extension/plugin-ecosystem/tools/browser-types.js';
import { assembleGlobalTools } from '../../packages/engine/src/integration/tools/assemble.js';
import type {
  RegisteredTool,
  ToolExecutionContext,
} from '@octopi-agent/core/types.js';

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
    if (url.startsWith('/redir')) {
      // 302 → 另一主机名（localhost vs 127.0.0.1）：路由级策略必须复验目标
      res.statusCode = 302;
      res.setHeader('location', `http://localhost:${(server.address() as AddressInfo).port}/final`);
      res.end();
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

function toolsFor(options: Parameters<typeof createBrowserTools>[1] = {}) {
  const service = createBrowserService({ engine: 'playwright' }) as BrowserService & {
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
    'gate can be disabled via confirm.passwordField=false',
    async () => {
      const rec: Recorder = { events: [], writes: [] };
      const confirmEffect = vi.fn(async () => 'deny');
      const { service, tools } = toolsFor({ confirm: { passwordField: false } });
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
        browser: { engine: 'camoufox' },
      } as never),
    ).rejects.toThrow(/not_implemented/);
    await expect(
      assembleGlobalTools({
        ...(baseCtx as object),
        browser: { engine: 'cloud' },
      } as never),
    ).rejects.toThrow(/not_implemented/);
  });

  it('default config registers the five browser_* tools', async () => {
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
