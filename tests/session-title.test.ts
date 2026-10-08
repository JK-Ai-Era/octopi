import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import {
  buildSnippetTitle,
  buildTitlePrompt,
  isTitleSignalReady,
  normalizeGeneratedTitle,
  shouldUpdateTitle,
  TITLE_MIN_FIRST_USER_CHARS,
  TITLE_MIN_TOTAL_USER_CHARS,
  TITLE_SNIPPET_MAX_CHARS,
} from '@octopi-agent/engine/harness/session/title.js';
import {
  applyUserTitle,
  maybeUpdateSessionTitle,
} from '@octopi-agent/gateway/gateway/session-title.js';

function msg(role: Message['role'], content: string, metadata?: Record<string, unknown>): Message {
  return { role, content, timestamp: Date.now(), metadata };
}

function sessionWith(messages: Message[], meta: Partial<SessionData['meta']> = {}): SessionData {
  return {
    id: 's1',
    agentId: 'default',
    meta: {
      id: 's1',
      agentId: 'default',
      channelId: 'web',
      peerId: 'web-ui',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
      ...meta,
    },
    messages,
    turns: [],
    metadata: {},
    tasks: [],
  };
}

describe('session title signal', () => {
  it('greeting-only first message is not signal-ready', () => {
    const s = sessionWith([
      msg('user', '你好'),
      msg('assistant', '你好！有什么可以帮你？'),
    ]);
    expect(isTitleSignalReady(s)).toBe(false);
  });

  it('long first user message is signal-ready', () => {
    const long = '帮我分析一下这个项目的依赖冲突应该怎么处理';
    expect(long.length).toBeGreaterThanOrEqual(TITLE_MIN_FIRST_USER_CHARS);
    const s = sessionWith([msg('user', long)]);
    expect(isTitleSignalReady(s)).toBe(true);
  });

  it('long latest user message after greeting is signal-ready', () => {
    const s = sessionWith([
      msg('user', '你好'),
      msg('assistant', '你好！'),
      msg('user', '帮我核对二阶段场景上线收尾情况以及一阶段是否如期交付'),
    ]);
    expect(isTitleSignalReady(s)).toBe(true);
  });

  it('accumulated short turns become signal-ready', () => {
    const s = sessionWith([
      msg('user', '你好'),
      msg('assistant', '你好'),
      msg('user', '我想把会话历史的标题改得更可读一些，现在侧栏里全是 default-web 时间戳认不出来'),
      msg('assistant', '可以给 SessionMeta 加 title 字段…'),
    ]);
    const total = s.messages
      .filter((m) => m.role === 'user')
      .reduce((n, m) => n + (m.content as string).length, 0);
    expect(total).toBeGreaterThanOrEqual(TITLE_MIN_TOTAL_USER_CHARS);
    expect(isTitleSignalReady(s)).toBe(true);
  });

  it('ignores command discourse when collecting user texts', () => {
    const s = sessionWith([
      msg('user', '/model gpt-4o', { kind: 'command' }),
      msg('assistant', 'ok', { kind: 'command_result' }),
    ]);
    expect(isTitleSignalReady(s)).toBe(false);
    expect(buildSnippetTitle(s.messages)).toBeNull();
  });
});

describe('snippet title', () => {
  it('truncates long first user message', () => {
    const text = '这是一个很长的用户问题，需要被截断成临时标题以便在侧栏一眼认出来';
    const title = buildSnippetTitle([msg('user', text)]);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(TITLE_SNIPPET_MAX_CHARS);
    expect(title!.endsWith('…')).toBe(true);
  });

  it('returns short message as-is', () => {
    expect(buildSnippetTitle([msg('user', '修复登录 bug')])).toBe('修复登录 bug');
  });

  it('prefers substantial later message over greeting', () => {
    const title = buildSnippetTitle([
      msg('user', '你好'),
      msg('assistant', '你好！'),
      msg('user', '帮我核对二阶段场景上线收尾和一阶段十个场景是否如期交付'),
    ]);
    expect(title).not.toBe('你好');
    expect(title).toContain('二阶段');
  });
});

describe('shouldUpdateTitle', () => {
  it('respects user rename', () => {
    expect(shouldUpdateTitle({ title: '自定义', titleSource: 'user' })).toBe(false);
  });

  it('does not regenerate auto title', () => {
    expect(shouldUpdateTitle({ title: '已有摘要', titleSource: 'auto' })).toBe(false);
  });

  it('allows upgrading weak auto title like greeting', () => {
    expect(shouldUpdateTitle({ title: '你好', titleSource: 'auto' })).toBe(true);
    expect(shouldUpdateTitle({ title: '你好', titleSource: 'snippet' })).toBe(true);
    expect(shouldUpdateTitle({ title: '你好', titleSource: 'user' })).toBe(false);
  });

  it('allows updating snippet or empty', () => {
    expect(shouldUpdateTitle({ title: '你好', titleSource: 'snippet' })).toBe(true);
    expect(shouldUpdateTitle({})).toBe(true);
  });
});

describe('normalizeGeneratedTitle', () => {
  it('strips quotes and keeps first line', () => {
    expect(normalizeGeneratedTitle('"会话标题策略"\n其他说明')).toBe('会话标题策略');
    expect(normalizeGeneratedTitle('「依赖治理」')).toBe('依赖治理');
  });

  it('returns null on empty', () => {
    expect(normalizeGeneratedTitle('   \n  ')).toBeNull();
  });
});

describe('buildTitlePrompt', () => {
  it('includes user/assistant lines and system instruction', () => {
    const prompt = buildTitlePrompt([
      msg('user', '如何设计会话标题？'),
      msg('assistant', '可以用小模型摘要。'),
      msg('tool', 'ignored'),
    ]);
    expect(prompt[0].role).toBe('system');
    expect(prompt[1].content).toContain('如何设计会话标题？');
    expect(prompt[1].content).toContain('可以用小模型摘要。');
    expect(prompt[1].content).not.toContain('ignored');
  });

  it('asks for topic label centered on the matter at hand', () => {
    const prompt = buildTitlePrompt([msg('user', '核对云锡二阶段交付')]);
    expect(prompt[0].content).toContain('面向的是什么事');
    expect(prompt[0].content).toContain('主题式短标题');
    expect(prompt[0].content).toContain('专名');
  });

  it('drops greeting-only turns when substance exists', () => {
    const prompt = buildTitlePrompt([
      msg('user', '你好'),
      msg('assistant', '你好！有什么可以帮你？'),
      msg('user', '帮我核对云锡二阶段交付情况'),
      msg('assistant', '按计划应收尾验收。'),
    ]);
    expect(prompt[1].content).not.toContain('你好');
    expect(prompt[1].content).toContain('云锡二阶段');
  });
});

describe('maybeUpdateSessionTitle', () => {
  it('writes snippet when signal not ready', async () => {
    const session = sessionWith([
      msg('user', '你好'),
      msg('assistant', '你好！'),
    ]);
    const save = vi.fn(async () => {});
    const onTitleUpdated = vi.fn();
    const chat = vi.fn();
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      save,
      providers: new Map([['p', { chat, getModelInfo: () => undefined } as never]]),
      resolveFallback: () => ({ provider: { chat, getModelInfo: () => undefined } as never, model: 'mini' }),
      onTitleUpdated,
    });
    expect(ok).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    expect(session.meta.title).toBe('你好');
    expect(session.meta.titleSource).toBe('snippet');
    expect(onTitleUpdated).toHaveBeenCalledWith('s1', '你好', 'snippet');
  });

  it('generates auto title when signal ready', async () => {
    const session = sessionWith([
      msg('user', '帮我写一个会话标题自动生成的设计方案，要求支持手动重命名'),
      msg('assistant', '可以分两步：先 snippet，再小模型摘要。'),
    ]);
    const chat = vi.fn(async () => ({ content: '"会话标题自动生成方案"', model: 'mini', finishReason: 'stop' as const }));
    const provider = { chat, getModelInfo: () => undefined } as never;
    const save = vi.fn(async () => {});
    const onTitleUpdated = vi.fn();
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      save,
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated,
    });
    expect(ok).toBe(true);
    expect(chat).toHaveBeenCalledOnce();
    expect(session.meta.title).toBe('会话标题自动生成方案');
    expect(session.meta.titleSource).toBe('auto');
    expect(onTitleUpdated).toHaveBeenCalledWith('s1', '会话标题自动生成方案', 'auto');
  });

  it('skips when user renamed', async () => {
    const session = sessionWith(
      [msg('user', '帮我写一个会话标题自动生成的设计方案，要求支持手动重命名')],
      { title: '我的标题', titleSource: 'user' },
    );
    const save = vi.fn(async () => {});
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      save,
      providers: new Map(),
      resolveFallback: () => null,
      onTitleUpdated: vi.fn(),
    });
    expect(ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(session.meta.title).toBe('我的标题');
  });

  it('falls back to snippet when model fails', async () => {
    const session = sessionWith([
      msg('user', '帮我写一个会话标题自动生成的设计方案，要求支持手动重命名'),
    ]);
    const chat = vi.fn(async () => {
      throw new Error('model down');
    });
    const provider = { chat, getModelInfo: () => undefined } as never;
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      save: async () => {},
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated: vi.fn(),
    });
    expect(ok).toBe(true);
    expect(session.meta.titleSource).toBe('snippet');
    expect(session.meta.title).toContain('帮我写一个会话标题');
  });

  it('upgrades greeting snippet to auto after later substantial turn', async () => {
    // 回归：首轮「你好」→ snippet；第二轮复杂问题后必须升到小模型标题
    const session = sessionWith([
      msg('user', '你好'),
      msg('assistant', '你好！有什么可以帮你？'),
    ]);
    const store = { current: session };
    const chat = vi.fn(async () => ({
      content: '二阶段交付核对',
      model: 'mini',
      finishReason: 'stop' as const,
    }));
    const provider = { chat, getModelInfo: () => undefined } as never;
    const onTitleUpdated = vi.fn();
    const deps = {
      load: async () => store.current,
      save: async (_id: string, data: SessionData) => {
        store.current = data;
      },
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated,
    };

    // turn 1：仅打招呼 → snippet
    await maybeUpdateSessionTitle('s1', deps);
    expect(store.current.meta.title).toBe('你好');
    expect(store.current.meta.titleSource).toBe('snippet');
    expect(chat).not.toHaveBeenCalled();

    // turn 2：复杂提问 + 回复落盘
    store.current = {
      ...store.current,
      messages: [
        ...store.current.messages,
        msg('user', '帮我核对二阶段场景上线收尾情况，以及一阶段十个场景是否如期交付、有无延期风险'),
        msg('assistant', '按计划应处于二阶段收尾，但本地资料八月后断更…'),
      ],
    };

    await maybeUpdateSessionTitle('s1', deps);
    expect(chat).toHaveBeenCalled();
    expect(store.current.meta.title).toBe('二阶段交付核对');
    expect(store.current.meta.titleSource).toBe('auto');
  });

  it('upgrades greeting snippet even when model fails', async () => {
    const session = sessionWith([
      msg('user', '你好'),
      msg('assistant', '你好！'),
      msg('user', '帮我核对二阶段场景上线收尾情况以及一阶段是否如期交付'),
      msg('assistant', '本地资料八月后断更…'),
    ]);
    session.meta.title = '你好';
    session.meta.titleSource = 'snippet';
    const chat = vi.fn(async () => {
      throw new Error('model down');
    });
    const provider = { chat, getModelInfo: () => undefined } as never;
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      save: async () => {},
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated: vi.fn(),
    });
    expect(ok).toBe(true);
    expect(session.meta.title).not.toBe('你好');
    expect(session.meta.titleSource).toBe('snippet');
  });
});

describe('applyUserTitle', () => {
  it('marks title as user-owned', () => {
    const session = sessionWith([], { title: '旧', titleSource: 'auto' });
    const t = applyUserTitle(session, '  需求澄清  ');
    expect(t).toBe('需求澄清');
    expect(session.meta.titleSource).toBe('user');
    expect(shouldUpdateTitle(session.meta)).toBe(false);
  });

  it('rejects empty title', () => {
    const session = sessionWith([]);
    expect(applyUserTitle(session, '   ')).toBeNull();
  });
});
