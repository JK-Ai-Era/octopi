/**
 * P5c — Plugin Channel: WeChat ClawBot (iLink Bot API) real plugin.
 *
 * The committed suite drives the real plugin code over an injected fetch
 * transport — no network, no WeChat account. The live pairing/traffic test is
 * exercised separately against a real WeChat account.
 *
 * Semantics under test (pairing redesign): start() is dormant when unpaired —
 * pairing is an on-demand interaction via the `weixin_pair` tool, never a
 * startup blocker or a request storm.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager.js';
import {
  createWeixinChannelAdapter,
  encodeClientVersion,
  isTrustedHost,
  makeWechatUin,
  migrateLegacyState,
  parseOptions,
  toChannelMessage,
} from '../examples/plugins/weixin-clawbot/index.mjs';

const EXAMPLE_PLUGINS_DIR = fileURLToPath(new URL('../examples/plugins', import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-weixin-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Fake transport: records calls; responses come from a scripted handler. */
function fakeTransport() {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> }> = [];
  let handler: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => Record<string, unknown> | Promise<Record<string, unknown>> =
    () => ({ ret: 0 });
  const fetchImpl = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    });
    const out = await handler(url, init);
    return { ok: true, json: async () => out };
  };
  return {
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    calls,
    on(h: typeof handler) { handler = h; },
  };
}

const silentLogger = { log() {}, error() {} };
const fastDeps = (t: ReturnType<typeof fakeTransport>) => ({
  fetch: t.fetch,
  logger: silentLogger,
  sleep: () => new Promise<void>((r) => setImmediate(r)),
  randomId: () => 'rid-1',
});
const ctxFor = (statePath: string, options: Record<string, unknown> = {}) => ({
  channelName: 'weixin',
  apiKey: '',
  options: { statePath, ...options },
});
const BASEURL = 'https://im-bot.weixin.qq.com';

function inboundMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    message_id: 1001,
    from_user_id: 'user@im.wechat',
    to_user_id: 'bot@im.bot',
    client_id: 'c-1',
    create_time_ms: 1700000000000,
    session_id: 'sess-1',
    message_type: 1,
    message_state: 0,
    context_token: 'ctx-secret-1',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    ...over,
  };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 1));
}

// ─────────────────────────────────────────────────────────────
// 1. helpers / options
// ─────────────────────────────────────────────────────────────

describe('weixin plugin — helpers and options', () => {
  it('encodeClientVersion / makeWechatUin / isTrustedHost', () => {
    expect(encodeClientVersion('2.4.6')).toBe(132102);
    expect(makeWechatUin()).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(isTrustedHost('https://im-bot.weixin.qq.com/base')).toBe(true);
    expect(isTrustedHost('https://weixin.qq.com')).toBe(true);
    expect(isTrustedHost('http://im-bot.weixin.qq.com')).toBe(false);
    expect(isTrustedHost('https://evil.example.com')).toBe(false);
    expect(isTrustedHost('https://weixin.qq.com.evil.com')).toBe(false);
  });

  it('parseOptions fails loud on unknown/malformed options', () => {
    expect(() => parseOptions({ mystery: 1 })).toThrow(/unknown option/);
    expect(() => parseOptions({ statePath: '' })).toThrow(/statePath/);
    expect(() => parseOptions({ verifyCode: 'abc' })).toThrow(/numeric/);
    expect(() => parseOptions({ loginTimeoutMs: -1 })).toThrow(/positive/);
    // allowHosts may widen trust (any host name); https is enforced at use time.
    expect(parseOptions({ allowHosts: ['extra.example.com'] }).allowHosts).toEqual(['extra.example.com']);
    expect(() => parseOptions({ allowHosts: [''] })).toThrow(/non-empty/);
  });

  it('parseOptions defaults statePath under OCTOPI_HOME and validates allowHosts', () => {
    const opts = parseOptions({});
    expect(opts.statePath.endsWith('weixin-clawbot-state.json')).toBe(true);
    expect(opts.loginTimeoutMs).toBe(300000);
    expect(parseOptions({ allowHosts: ['extra.weixin.qq.com'] }).allowHosts).toEqual(['extra.weixin.qq.com']);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. message mapping (context_token never exposed)
// ─────────────────────────────────────────────────────────────

describe('weixin plugin — message mapping', () => {
  it('maps text messages and keeps context_token inside the adapter store', () => {
    const store = new Map<string, string>();
    const mapped = toChannelMessage('weixin', inboundMessage({ item_list: [{ type: 1, text_item: { text: 'line1' } }, { type: 1, text_item: { text: 'line2' } }] }), store);
    expect(mapped).toEqual({
      id: '1001',
      channel: 'weixin',
      senderId: 'user@im.wechat',
      content: 'line1\nline2',
      conversationId: 'user@im.wechat',
      timestamp: 1700000000000,
      metadata: { sessionId: 'sess-1' },
    });
    expect(store.get('1001')).toBe('ctx-secret-1');
    expect(JSON.stringify(mapped)).not.toContain('ctx-secret-1');
  });

  it('ignores the bot own messages (loop guard) and media-only content', () => {
    const store = new Map<string, string>();
    expect(toChannelMessage('weixin', inboundMessage({ message_type: 2 }), store)).toBeNull();
    expect(toChannelMessage('weixin', inboundMessage({ item_list: [{ type: 2, image_item: { media: {} } }] }), store)).toBeNull();
    expect(toChannelMessage('weixin', inboundMessage({ item_list: [] }), store)).toBeNull();
  });

  it('skips group messages explicitly (reply target unverified, review #23)', () => {
    const store = new Map<string, string>();
    expect(toChannelMessage('weixin', inboundMessage({ group_id: 'g@im.group' }), store)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 3. dormant start + on-demand pairing (weixin_pair redesign)
// ─────────────────────────────────────────────────────────────

describe('weixin plugin — dormant start and on-demand pairing', () => {
  const statePath = () => join(root, 'state.json');

  it('start is dormant when unpaired — no network calls, send says to pair', async () => {
    const t = fakeTransport();
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    await adapter.start(async () => {});
    expect(t.calls).toHaveLength(0);
    await expect(adapter.send({ channel: 'weixin', conversationId: 'u', content: 'x' })).rejects.toThrow(/not paired/);
    await adapter.stop(); // must not crash on a null session (regression)
  });

  it('status() reports dormant when unpaired and running after pairing', async () => {
    const t = fakeTransport();
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    expect(adapter.status()).toEqual({ state: 'dormant', detail: 'not started' });
    await adapter.start(async () => {});
    expect(adapter.status()).toEqual({ state: 'dormant', detail: 'not paired — call the weixin_pair tool to pair' });
    t.on((url) => {
      if (url.includes('get_bot_qrcode')) return { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'QRDATA' };
      if (url.includes('get_qrcode_status')) return { ret: 0, status: 'confirmed', bot_token: 'tok-1', baseurl: BASEURL, ilink_bot_id: 'b1', ilink_user_id: 'u1' };
      return { ret: 0 };
    });
    await adapter.pair();
    await adapter.pairingPromise;
    expect(adapter.status().state).toBe('running');
    await adapter.stop();
    expect(adapter.status()).toEqual({ state: 'dormant', detail: 'not started' });
  });

  it('status() reports degraded with the poll error while backing off', async () => {
    const t = fakeTransport();
    let polls = 0;
    t.on((url) => {
      if (url.includes('get_bot_qrcode')) return { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'QRDATA' };
      if (url.includes('get_qrcode_status')) return { ret: 0, status: 'confirmed', bot_token: 'tok-1', baseurl: BASEURL, ilink_bot_id: 'b1', ilink_user_id: 'u1' };
      if (url.includes('getupdates')) {
        polls += 1;
        throw new Error('ECONNRESET');
      }
      return { ret: 0 };
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    await adapter.start(async () => {});
    await adapter.pair();
    await adapter.pairingPromise;
    // Let at least one failing poll tick happen, then the loop backs off.
    await new Promise((r) => setTimeout(r, 20));
    expect(polls).toBeGreaterThan(0);
    const s = adapter.status();
    expect(s.state).toBe('degraded');
    expect(s.detail).toContain('ECONNRESET');
    await adapter.stop();
  });

  it('pair() returns a QR immediately and activates polling after confirmation', async () => {
    const t = fakeTransport();
    t.on((url) => {
      if (url.includes('get_bot_qrcode')) return { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'QRDATA' };
      if (url.includes('get_qrcode_status')) return { ret: 0, status: 'confirmed', bot_token: 'tok-1', baseurl: BASEURL, ilink_bot_id: 'b1', ilink_user_id: 'u1' };
      return { ret: 0 };
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t)) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter.start(async () => {});
    const result = await adapter.pair();
    expect(result.status).toBe('awaiting_scan');
    expect(result.qrContent).toBe('QRDATA');
    await adapter.pairingPromise;
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toMatchObject({ bot_token: 'tok-1', baseurl: BASEURL });
    expect(t.calls.some((c) => c.url.includes('notifystart'))).toBe(true);
    await adapter.stop();
  });

  it('pair() guards concurrency and reports already_paired', async () => {
    const t = fakeTransport();
    let statusCalls = 0;
    t.on((url) => {
      if (url.includes('get_bot_qrcode')) return { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'QRDATA' };
      if (url.includes('get_qrcode_status')) {
        statusCalls += 1;
        return { ret: 0, status: statusCalls === 1 ? 'confirmed' : 'wait', ...(statusCalls === 1 ? { bot_token: 'tok-1', baseurl: BASEURL } : {}) };
      }
      return { ret: 0 };
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t)) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter.start(async () => {});
    const first = await adapter.pair();
    expect(first.status).toBe('awaiting_scan');
    const second = await adapter.pair();
    expect(second.status).toBe('pairing_in_progress');
    await adapter.pairingPromise;
    const third = await adapter.pair();
    expect(third.status).toBe('already_paired');
    await adapter.stop();
  });

  it('pair() claims its guard synchronously (parallel calls never double-pair)', async () => {
    const t = fakeTransport();
    t.on((url) => {
      if (url.includes('get_bot_qrcode')) return { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'QRDATA' };
      return { ret: 0, status: 'confirmed', bot_token: 'tok-1', baseurl: 'https://im-bot.weixin.qq.com' };
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t)) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter.start(async () => {});
    // Parallel invocation — the race the guard must win (review #1).
    const [a, b] = await Promise.all([adapter.pair(), adapter.pair()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['awaiting_scan', 'pairing_in_progress']);
    // Exactly one QR was fetched — no duplicate pairers/poll loops.
    expect(t.calls.filter((c) => c.url.includes('get_bot_qrcode'))).toHaveLength(1);
    await adapter.pairingPromise;
    await adapter.stop();
  });

  it('login() gives up after 5 expired QR codes and goes dormant (storm guard)', async () => {
    writeFileSync(statePath(), JSON.stringify({ bot_token: 'tok-old', baseurl: BASEURL, get_updates_buf: '' }));
    const t = fakeTransport();
    let qrCount = 0;
    let polls = 0;
    t.on((url) => {
      if (url.includes('getupdates')) { polls += 1; return { ret: 0, errcode: -14, errmsg: 'expired' }; }
      if (url.includes('get_bot_qrcode')) { qrCount += 1; return { ret: 0, qrcode: `qr-${qrCount}`, qrcode_img_content: 'QR' }; }
      if (url.includes('get_qrcode_status')) return { ret: 0, status: 'expired' };
      return { ret: 0 };
    });
    const errLog: string[] = [];
    const adapter = createWeixinChannelAdapter(ctxFor(statePath(), { loginTimeoutMs: 60_000 }), {
      ...fastDeps(t),
      logger: { log() {}, error(...a: unknown[]) { errLog.push(String(a[0])); } },
      sleep: () => new Promise<void>((r) => setImmediate(r)),
    });
    await adapter.start(async () => {});
    await flush();
    await adapter.stop();
    // login ran, hit the 5-QR cap (exactly one round of 5 QR fetches) …
    expect(errLog.some((l) => l.includes('re-pairing failed'))).toBe(true);
    expect(qrCount).toBe(5);
    // … and the channel went dormant instead of re-login churning forever
    // (PAIRING_EXHAUSTED → session cleared, state file removed, loop stopped).
    expect(errLog.some((l) => l.includes('channel dormant'))).toBe(true);
    expect(existsSync(statePath())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. receive loop / send / stop (paired state)
// ─────────────────────────────────────────────────────────────

describe('weixin plugin — adapter behavior (paired)', () => {
  const statePath = () => join(root, 'state.json');

  function pairedState() {
    return JSON.stringify({ bot_token: 'tok-1', baseurl: BASEURL, ilink_bot_id: 'b1', ilink_user_id: 'u1', get_updates_buf: 'buf-0' });
  }

  it('a response without `ret` is success (real iLink envelope) and delivers messages', async () => {
    writeFileSync(statePath(), pairedState());
    const t = fakeTransport();
    let polls = 0;
    t.on((url) => {
      if (url.includes('getupdates')) {
        polls += 1;
        // Real success responses omit ret/errcode/errmsg entirely.
        return polls === 1
          ? { msgs: [inboundMessage()], get_updates_buf: 'buf-1' }
          : { msgs: [], get_updates_buf: 'buf-1' };
      }
      return {};
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    const got: unknown[] = [];
    await adapter.start(async (msg) => { got.push(msg); });
    await flush();
    await adapter.stop();
    expect(got).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).get_updates_buf).toBe('buf-1');
  });

  it('delivers inbound text to the handler, advances + persists the cursor', async () => {
    writeFileSync(statePath(), pairedState());
    const t = fakeTransport();
    let polls = 0;
    t.on((url) => {
      if (url.includes('getupdates')) {
        polls += 1;
        return polls === 1
          ? { ret: 0, msgs: [inboundMessage()], get_updates_buf: 'buf-1', longpolling_timeout_ms: 35000 }
          : { ret: 0, msgs: [], get_updates_buf: 'buf-1', longpolling_timeout_ms: 35000 };
      }
      return { ret: 0 };
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    const got: unknown[] = [];
    await adapter.start(async (msg) => { got.push(msg); });
    await flush();
    await adapter.stop();
    expect(got).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).get_updates_buf).toBe('buf-1');
  });

  it('replies carry the inbound context_token and target the sender', async () => {
    writeFileSync(statePath(), pairedState());
    const t = fakeTransport();
    let polls = 0;
    t.on((url) => {
      if (url.includes('getupdates')) {
        polls += 1;
        return polls === 1
          ? { ret: 0, msgs: [inboundMessage()], get_updates_buf: 'buf-1' }
          : { ret: 0, msgs: [], get_updates_buf: 'buf-1' };
      }
      return { ret: 0 };
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    await adapter.start(async () => {});
    await flush();
    await adapter.send({ channel: 'weixin', conversationId: 'user@im.wechat', content: 'reply **md**', replyToId: '1001' });
    const sent = t.calls.find((c) => c.url.includes('sendmessage'));
    expect(sent?.body?.msg).toMatchObject({
      to_user_id: 'user@im.wechat',
      client_id: 'rid-1',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-secret-1',
      item_list: [{ type: 1, text_item: { text: 'reply **md**' } }],
    });
    expect(sent?.headers?.Authorization).toBe('Bearer tok-1');
    await adapter.stop();
  });

  it('sends without context_token when the reply has no replyToId (degraded path)', async () => {
    writeFileSync(statePath(), pairedState());
    const t = fakeTransport();
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), { ...fastDeps(t), randomId: () => 'rid-2' });
    await adapter.start(async () => {});
    await adapter.send({ channel: 'weixin', conversationId: 'user@im.wechat', content: 'plain' });
    const sent = t.calls.find((c) => c.url.includes('sendmessage'));
    const sentMsg = sent?.body as { msg?: Record<string, unknown> } | undefined;
    expect(sentMsg?.msg?.context_token).toBeUndefined();
    expect(sentMsg?.msg?.client_id).toBe('rid-2');
    await adapter.stop();
  });

  it('business failure (ret != 0) on send fails loud', async () => {
    writeFileSync(statePath(), pairedState());
    const t = fakeTransport();
    t.on((url) => (url.includes('sendmessage') ? { ret: -2, errcode: -2, errmsg: 'prepare failed' } : { ret: 0 }));
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    await adapter.start(async () => {});
    await expect(adapter.send({ channel: 'weixin', conversationId: 'u', content: 'x' })).rejects.toThrow(/ret=-2/);
    await adapter.stop();
  });

  it('errcode=-14 triggers re-pairing and restarts the connection', async () => {
    writeFileSync(statePath(), pairedState());
    const t = fakeTransport();
    let polls = 0;
    t.on((url) => {
      if (url.includes('getupdates')) {
        polls += 1;
        return polls === 1 ? { ret: 0, errcode: -14, errmsg: 'token expired' } : { ret: 0, msgs: [], get_updates_buf: 'buf-1' };
      }
      if (url.includes('get_bot_qrcode')) return { ret: 0, qrcode: 'qr-re', qrcode_img_content: 'QR' };
      if (url.includes('get_qrcode_status')) return { ret: 0, status: 'confirmed', bot_token: 'tok-2', baseurl: BASEURL };
      return { ret: 0 };
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    await adapter.start(async () => {});
    await flush();
    await adapter.stop();
    expect(t.calls.some((c) => c.url.includes('get_bot_qrcode'))).toBe(true);
    const notifystarts = t.calls.filter((c) => c.url.includes('notifystart'));
    expect(notifystarts.length).toBe(2);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).bot_token).toBe('tok-2');
  });

  it('handler errors never kill the poll loop (next message still delivers)', async () => {
    writeFileSync(statePath(), pairedState());
    const t = fakeTransport();
    let polls = 0;
    t.on((url) => {
      if (url.includes('getupdates')) {
        polls += 1;
        return { ret: 0, msgs: [inboundMessage({ message_id: 2000 + polls })], get_updates_buf: `buf-${polls}` };
      }
      return { ret: 0 };
    });
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    const seen: number[] = [];
    await adapter.start(async (msg) => {
      seen.push(Number((msg as { id: string }).id));
      throw new Error('boom');
    });
    await flush();
    await adapter.stop();
    // First message threw — the loop kept polling and delivered the next one.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe(2001);
    expect(seen[1]).toBe(2002);
  });

  it('stop notifies notifystop and survives its failure; send before start fails loud', async () => {
    writeFileSync(statePath(), pairedState());
    const t = fakeTransport();
    t.on((url) => (url.includes('notifystop') ? { ret: -99, errmsg: 'nope' } : { ret: 0 }));
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t));
    await expect(adapter.send({ channel: 'weixin', conversationId: 'u', content: 'x' })).rejects.toThrow(/not started/);
    await adapter.start(async () => {});
    await adapter.stop();
    await adapter.stop();
    expect(t.calls.filter((c) => c.url.includes('notifystop'))).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. loader contract (manifest tools ['weixin_pair'] ↔ registerTool)
// ─────────────────────────────────────────────────────────────

describe('weixin example plugin — loader contract', () => {
  it('registers the weixin channel contribution and the weixin_pair tool', async () => {
    const manager = new PluginManager({
      loadPaths: [EXAMPLE_PLUGINS_DIR],
      entries: { weixin: { enabled: true } },
    });
    await manager.discover();
    expect(manager.getDiagnostics().find((d) => d.id === 'weixin')?.status).toBe('registered');
    expect(manager.resolveChannelFactory('weixin')?.id).toBe('weixin');
    const tool = manager.getTools().find((t) => t.definition.name === 'weixin_pair');
    expect(tool).toBeDefined();
    expect(tool?.definition.capabilities).toEqual(['egress']);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. login QR state machine (driven via pair(); review #30 coverage)
// ─────────────────────────────────────────────────────────────

describe('weixin plugin — login QR state machine via pair()', () => {
  const statePath = () => join(root, 'state.json');

  function pairDrive(statuses: Array<Record<string, unknown>>, qr = 'qr-1') {
    const t = fakeTransport();
    let i = 0;
    t.on((url) => {
      if (url.includes('get_bot_qrcode')) return { ret: 0, qrcode: qr, qrcode_img_content: 'QRDATA' };
      if (url.includes('get_qrcode_status')) return { ret: 0, ...(statuses[Math.min(i++, statuses.length - 1)]) };
      return { ret: 0 };
    });
    return t;
  }

  it('walks wait → scaned → confirmed and persists state with chmod 600', async () => {
    const t = pairDrive([{ status: 'wait' }, { status: 'scaned' }, { status: 'confirmed', bot_token: 'tok-1', baseurl: 'https://im-bot.weixin.qq.com', ilink_bot_id: 'b1', ilink_user_id: 'u1' }]);
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t)) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter.start(async () => {});
    await adapter.pair();
    await adapter.pairingPromise;
    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(state).toMatchObject({ bot_token: 'tok-1', baseurl: 'https://im-bot.weixin.qq.com', get_updates_buf: '' });
    expect(statSync(statePath()).mode & 0o777).toBe(0o600);
    await adapter.stop();
  });

  it('expired ends the wait and tells the user to call weixin_pair again (pair path)', async () => {
    const errLog: string[] = [];
    const logger = { log() {}, error(...a: unknown[]) { errLog.push(String(a[0])); } };
    const t = pairDrive([{ status: 'expired' }]);
    const adapter = createWeixinChannelAdapter(ctxFor(statePath(), { loginTimeoutMs: 30_000 }), { ...fastDeps(t), logger }) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter.start(async () => {});
    await adapter.pair();
    await adapter.pairingPromise;
    // The pair() path does NOT auto-refetch on expiry — it reports and yields
    // back to the weixin_pair tool (the single recovery entry, review #8).
    expect(t.calls.filter((c) => c.url.includes('get_bot_qrcode'))).toHaveLength(1);
    expect(errLog.some((l) => l.includes('expired before confirmation'))).toBe(true);
    await adapter.stop();
  });

  it('need_verifycode fails loud without options.verifyCode and passes it when configured', async () => {
    const errLog: string[] = [];
    const logger = { log() {}, error(...a: unknown[]) { errLog.push(String(a[0])); } };
    const t = pairDrive([{ status: 'need_verifycode' }]);
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), { ...fastDeps(t), logger });
    await adapter.start(async () => {});
    await adapter.pair();
    await (adapter as unknown as { pairingPromise: Promise<void> }).pairingPromise;
    expect(errLog.some((l) => l.includes('verify code'))).toBe(true);

    const t2 = pairDrive([{ status: 'need_verifycode' }, { status: 'confirmed', bot_token: 'tok-3', baseurl: 'https://im-bot.weixin.qq.com' }]);
    const adapter2 = createWeixinChannelAdapter(ctxFor(statePath(), { verifyCode: '123456' }), fastDeps(t2)) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter2.start(async () => {});
    await adapter2.pair();
    await adapter2.pairingPromise;
    const statusCalls = t2.calls.filter((c) => c.url.includes('get_qrcode_status'));
    expect(statusCalls.every((c) => c.url.includes('verify_code=123456'))).toBe(true);
    await adapter2.stop();
  });

  it('refuses untrusted redirect_host and untrusted confirmed baseurl (security)', async () => {
    const errLog: string[] = [];
    const logger = { log() {}, error(...a: unknown[]) { errLog.push(String(a[0])); } };
    const t = pairDrive([{ status: 'scaned_but_redirect', redirect_host: 'https://evil.example.com' }]);
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), { ...fastDeps(t), logger });
    await adapter.start(async () => {});
    await adapter.pair();
    await (adapter as unknown as { pairingPromise: Promise<void> }).pairingPromise;
    expect(errLog.some((l) => l.includes('untrusted redirect_host'))).toBe(true);

    const t2 = pairDrive([{ status: 'confirmed', bot_token: 'tok-9', baseurl: 'https://evil.example.com' }]);
    const errLog2: string[] = [];
    const adapter2 = createWeixinChannelAdapter(ctxFor(statePath()), { ...fastDeps(t2), logger: { log() {}, error(...a: unknown[]) { errLog2.push(String(a[0])); } } }) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter2.start(async () => {});
    await adapter2.pair();
    await adapter2.pairingPromise;
    expect(errLog2.some((l) => l.includes('untrusted baseurl'))).toBe(true);
  });

  it('login requests never carry the bot token (Authorization must be absent)', async () => {
    const t = pairDrive([{ status: 'confirmed', bot_token: 'tok-1', baseurl: 'https://im-bot.weixin.qq.com' }]);
    const adapter = createWeixinChannelAdapter(ctxFor(statePath()), fastDeps(t)) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter.start(async () => {});
    await adapter.pair();
    await adapter.pairingPromise;
    await adapter.stop();
    const loginCalls = t.calls.filter((c) => c.url.includes('get_bot_qrcode') || c.url.includes('get_qrcode_status'));
    expect(loginCalls.length).toBeGreaterThan(0);
    for (const c of loginCalls) {
      expect(c.headers.Authorization).toBeUndefined();
    }
    // Business calls DO carry it.
    const notify = t.calls.find((c) => c.url.includes('notifystart'));
    expect(notify?.headers.Authorization).toBe('Bearer tok-1');
  });
});

describe('weixin state + vault (P6-4)', () => {
  const statePath = () => join(root, 'state.json');

  function pairDrive(statuses: Array<Record<string, unknown>>, qr = 'qr-1') {
    const t = fakeTransport();
    let i = 0;
    t.on((url) => {
      if (url.includes('get_bot_qrcode')) return { ret: 0, qrcode: qr, qrcode_img_content: 'QRDATA' };
      if (url.includes('get_qrcode_status')) return { ret: 0, ...(statuses[Math.min(i++, statuses.length - 1)]) };
      return { ret: 0 };
    });
    return t;
  }

  function fakeSecrets() {
    const store = new Map<string, string>();
    return {
      store,
      secrets: {
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string) { store.set(key, value); },
        async delete(key: string) { return store.delete(key); },
      },
    };
  }

  it('stores bot_token in the injected vault and runtime state in the file', async () => {
    const { store, secrets } = fakeSecrets();
    const t = pairDrive([{ status: 'confirmed', bot_token: 'tok-v', baseurl: BASEURL }]);
    const sp = statePath();
    const adapter = createWeixinChannelAdapter(ctxFor(sp), { ...fastDeps(t), secrets }) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter.start(async () => {});
    await adapter.pair();
    await adapter.pairingPromise;

    expect(store.get('bot_token')).toBe('tok-v');
    const onDisk = JSON.parse(readFileSync(sp, 'utf8')) as Record<string, unknown>;
    expect(onDisk.bot_token).toBeUndefined();
    expect(onDisk.baseurl).toBe(BASEURL);
    await adapter.stop();
  });

  it('restores the session from vault token + runtime file across restarts', async () => {
    const { store, secrets } = fakeSecrets();
    const sp = statePath();
    const t1 = pairDrive([{ status: 'confirmed', bot_token: 'tok-v', baseurl: BASEURL }]);
    const first = createWeixinChannelAdapter(ctxFor(sp), { ...fastDeps(t1), secrets }) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await first.start(async () => {});
    await first.pair();
    await first.pairingPromise;
    await first.stop();

    // Restart: the file has no token — the session must come back from the vault.
    const t2 = fakeTransport();
    const second = createWeixinChannelAdapter(ctxFor(sp), { ...fastDeps(t2), secrets });
    await second.start(async () => {});
    const notify = t2.calls.find((c) => c.url.includes('notifystart'));
    expect(notify?.headers.Authorization).toBe('Bearer tok-v');
    await second.stop();
  });

  it('moves an inline bot_token from the state file into the vault on first save', async () => {
    const { store, secrets } = fakeSecrets();
    const sp = statePath();
    writeFileSync(sp, JSON.stringify({ bot_token: 'legacy-tok', baseurl: BASEURL }));
    const t = fakeTransport();
    const adapter = createWeixinChannelAdapter(ctxFor(sp), { ...fastDeps(t), secrets });

    await adapter.start(async () => {});
    expect(store.get('bot_token')).toBe('legacy-tok');
    const onDisk = JSON.parse(readFileSync(sp, 'utf8')) as Record<string, unknown>;
    expect(onDisk.bot_token).toBeUndefined();
    await adapter.stop();
  });

  it('vault write failure keeps the token inline and logs loudly (no silent token loss)', async () => {
    const errLog: string[] = [];
    const logger = { log() {}, error(...a: unknown[]) { errLog.push(String(a[0])); } };
    const secrets = {
      async get() { return null; },
      async set() { throw new Error('credential master key not configured'); },
      async delete() { return true; },
    };
    const t = pairDrive([{ status: 'confirmed', bot_token: 'tok-keep', baseurl: BASEURL }]);
    const sp = statePath();
    const adapter = createWeixinChannelAdapter(ctxFor(sp), { ...fastDeps(t), logger, secrets }) as ReturnType<typeof createWeixinChannelAdapter> & { pairingPromise: Promise<void> | null };
    await adapter.start(async () => {});
    await adapter.pair();
    await adapter.pairingPromise;

    // The token survives on disk (inline form) and the failure is loud.
    const onDisk = JSON.parse(readFileSync(sp, 'utf8')) as Record<string, unknown>;
    expect(onDisk.bot_token).toBe('tok-keep');
    expect(errLog.some((l) => l.includes('vault write failed') && l.includes('master key'))).toBe(true);
    // Degraded mode is reported once per process, not on every state save
    // (cursor saves must not bury the log under repeated vault errors).
    expect(errLog.filter((l) => l.includes('vault write failed')).length).toBeLessThanOrEqual(1);
    await adapter.stop();
  });

  it('migrateLegacyState adopts the old credentials/ location exactly once', () => {
    const savedHome = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = root;
    try {
      const legacy = join(root, 'credentials', 'weixin-clawbot-state.json');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(legacy, JSON.stringify({ bot_token: 'old', baseurl: BASEURL }));
      const target = join(root, 'plugin-state', 'weixin', 'weixin-clawbot-state.json');

      expect(migrateLegacyState(target)).toBe(true);
      expect(existsSync(legacy)).toBe(false);
      expect(JSON.parse(readFileSync(target, 'utf8')).bot_token).toBe('old');
      // Idempotent: a present target is never overwritten.
      expect(migrateLegacyState(target)).toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env.OCTOPI_HOME;
      else process.env.OCTOPI_HOME = savedHome;
    }
  });
});
