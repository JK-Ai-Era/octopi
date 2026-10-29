/**
 * TUI 会话续接（/sessions /resume）——纯逻辑与 REST 客户端行为。
 *
 * 钉住：历史消息 → ChatLog 条目的映射语义（工具结果/媒体占位）、
 * 会话列表展示与选择解析、REST 信封与鉴义头。
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types/messages.js';
import {
  toChatEntries,
  contentToText,
  formatRelativeTime,
  formatSessionList,
  pickSession,
  type ChatEntry,
} from '../src/integration/tui/history.js';
import { TuiGatewayApi, type TuiSessionItem } from '../src/integration/tui/gateway-api.js';

const msg = (partial: Partial<Message> & Pick<Message, 'role'>): Message & { index: number } => ({
  content: '',
  timestamp: 0,
  ...partial,
  index: 0,
});

describe('toChatEntries（历史消息 → 渲染条目）', () => {
  it('user/assistant 正文各成一条', () => {
    const entries = toChatEntries([
      msg({ role: 'user', content: 'hi' }),
      msg({ role: 'assistant', content: 'hello' }),
    ]);
    expect(entries).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'hello' },
    ]);
  });

  it('assistant 的 toolCalls 逐个渲染为 tool 条目', () => {
    const entries = toChatEntries([
      msg({
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'c1', name: 'file_read', arguments: { path: '/a' } }],
      }),
    ]);
    expect(entries).toEqual([
      { kind: 'assistant', text: 'let me check' },
      { kind: 'tool', name: 'file_read', args: '{"path":"/a"}', result: '', isError: false },
    ]);
  });

  it('role=tool 取 toolResults 渲染，error 标记为失败', () => {
    const entries = toChatEntries([
      msg({
        role: 'tool',
        toolResults: [
          { toolCallId: 'c1', name: 'file_read', result: 'file body' },
          { toolCallId: 'c2', name: 'shell', result: { stdout: '' }, error: 'boom' },
        ],
      }),
    ]);
    expect(entries).toEqual([
      { kind: 'tool', name: 'file_read', args: '', result: 'file body', isError: false },
      { kind: 'tool', name: 'shell', args: '', result: '{"stdout":""}', isError: true },
    ]);
  });

  it('system 正文降级为 system 条目；空正文跳过', () => {
    const entries = toChatEntries([
      msg({ role: 'system', content: 'note' }),
      msg({ role: 'system', content: '' }),
    ]);
    expect(entries).toEqual([{ kind: 'system', text: 'note' }]);
  });
});

describe('contentToText（多模态降级）', () => {
  it('文本块拼接，媒体块降级为占位标注', () => {
    expect(
      contentToText([
        { type: 'text', text: 'look: ' },
        { type: 'image', alt: 'cat' },
        { type: 'file', name: 'a.txt' },
      ]),
    ).toBe('look: \n[image: cat]\n[file: a.txt]');
  });

  it('字符串内容原样返回', () => {
    expect(contentToText('plain')).toBe('plain');
  });
});

describe('会话列表展示与选择', () => {
  const now = 1_000_000_000_000;
  const sessions: TuiSessionItem[] = [
    {
      id: 's-old',
      agentId: 'a1',
      channelId: 'cli',
      peerId: 'cli',
      status: 'idle',
      createdAt: now - 3 * 86_400_000,
      sessionStartedAt: now - 3 * 86_400_000,
      lastInteractionAt: now - 3 * 86_400_000,
      updatedAt: now - 3 * 86_400_000,
      running: false,
    },
    {
      id: 's-cur',
      agentId: 'a1',
      channelId: 'cli',
      peerId: 'cli',
      status: 'processing',
      createdAt: now - 90_000,
      sessionStartedAt: now - 90_000,
      lastInteractionAt: now - 90_000,
      updatedAt: now - 90_000,
      running: true,
      title: '排查 auth 问题',
    },
  ];

  it('formatRelativeTime：分钟/小时/天三段', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('0m');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m');
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h');
    expect(formatRelativeTime(now - 5 * 86_400_000, now)).toBe('5d');
  });

  it('formatSessionList：当前会话 → 标记、运行中 🏃、无标题回退 id', () => {
    const lines = formatSessionList(sessions, { currentId: 's-cur', now });
    expect(lines[0]).toContain('s-old');
    expect(lines[0]).not.toContain('→');
    expect(lines[1]).toContain('→');
    expect(lines[1]).toContain('🏃');
    expect(lines[1]).toContain('排查 auth 问题');
  });

  it('pickSession：序号（1 起）与 id 均可命中，未命中返回 undefined', () => {
    expect(pickSession(sessions, '2')?.id).toBe('s-cur');
    expect(pickSession(sessions, '1')?.id).toBe('s-old');
    expect(pickSession(sessions, 's-cur')?.id).toBe('s-cur');
    expect(pickSession(sessions, '9')).toBeUndefined();
    expect(pickSession(sessions, 'nope')).toBeUndefined();
    expect(pickSession(sessions, '')).toBeUndefined();
  });
});

describe('TuiGatewayApi（REST 信封与鉴权头）', () => {
  const item = { id: 's-1' } as TuiSessionItem;

  function stubFetch(
    handler: (url: string, init?: RequestInit) => unknown,
  ): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      return new Response(JSON.stringify(handler(u, init)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  it('listSessions：带 agentId 过滤参数，apiKey 存在时带 Bearer 头', async () => {
    const { impl, calls } = stubFetch(() => ({ ok: true, data: [item] }));
    const api = new TuiGatewayApi({
      baseUrl: 'http://gw:18180/',
      apiKey: 'k-1',
      fetchImpl: impl,
    });
    const sessions = await api.listSessions('agent-x');
    expect(sessions).toEqual([item]);
    expect(calls[0].url).toBe('http://gw:18180/api/v1/sessions?agentId=agent-x');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer k-1');
  });

  it('无 apiKey 时不带 Authorization 头', async () => {
    const { impl, calls } = stubFetch(() => ({ ok: true, data: [] }));
    const api = new TuiGatewayApi({ baseUrl: 'http://gw:18180', fetchImpl: impl });
    await api.listSessions();
    expect(calls[0].url).toBe('http://gw:18180/api/v1/sessions');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('getSessionMessages：分页参数进 query', async () => {
    const { impl, calls } = stubFetch(() => ({
      ok: true,
      data: { messages: [], total: 0, hasMore: false },
    }));
    const api = new TuiGatewayApi({ baseUrl: 'http://gw:18180', fetchImpl: impl });
    await api.getSessionMessages('s-9', { limit: 200, direction: 'backward', cursor: 'Mg==' });
    expect(calls[0].url).toBe(
      'http://gw:18180/api/v1/sessions/s-9/messages?limit=200&cursor=Mg%3D%3D&direction=backward',
    );
  });

  it('信封 ok:false 抛出服务端错误文案', async () => {
    const { impl } = stubFetch(() => ({ ok: false, error: 'Session "x" not found' }));
    const api = new TuiGatewayApi({ baseUrl: 'http://gw:18180', fetchImpl: impl });
    await expect(api.getSessionMessages('x')).rejects.toThrow('Session "x" not found');
  });
});

describe('ChatEntry 类型收窄（编译期锚）', () => {
  it('entry kind 可判别', () => {
    const entries: ChatEntry[] = [{ kind: 'user', text: 'x' }];
    expect(entries[0].kind).toBe('user');
  });
});
