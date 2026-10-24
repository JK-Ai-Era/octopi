import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { readTitleState } from '@octopi-agent/core/types/session.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import {
  buildSnippetTitle,
  buildTitlePrompt,
  collectTitleUserTexts,
  compactTitleText,
  isTitleSignalReady,
  isWeakTitle,
  looksLikeCodeOrMarkup,
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
import {
  formatTurnContextXml,
  formatTurnStartContent,
} from '@octopi-agent/engine/harness/context/turn-envelope.js';

function msg(role: Message['role'], content: string, metadata?: Record<string, unknown>): Message {
  return { role, content, timestamp: Date.now(), metadata };
}

let turnSeq = 0;
/** 真实形态用户消息：`<turn_start>` 信封（含 turn_context 记忆快照槽位，信封噪声远大于原文） */
function envelopeMsg(text: string, metadata?: Record<string, unknown>): Message {
  turnSeq += 1;
  const turnId = `t${turnSeq}`;
  return {
    role: 'user',
    content: formatTurnStartContent({
      turnId,
      at: new Date().toISOString(),
      turnContextXml: formatTurnContextXml({
        turnId,
        slotsXml: '<runtime_snapshot>\n[记忆] 与本问相关的记忆（5 条）：旧结论若干……\n</runtime_snapshot>',
      }),
      userText: text,
    }),
    timestamp: Date.now(),
    metadata,
  };
}

function sessionWith(messages: Message[], meta: Partial<SessionData['meta']> = {}): SessionData {
  const session: SessionData = {
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
  // 标题权威在 metadata 三键（meta 仅是投影）：helper 同步播种权威面
  if (meta.title !== undefined) session.metadata.title = meta.title;
  if (meta.titleSource !== undefined) session.metadata.titleSource = meta.titleSource;
  if (meta.titleUpdatedAt !== undefined) session.metadata.titleUpdatedAt = meta.titleUpdatedAt;
  return session;
}

/** updateMetadata 通道假实现：原地改 session.metadata（不触碰消息列表） */
function patchInto(session: SessionData) {
  return async (_id: string, mutate: (m: Record<string, unknown>) => void): Promise<void> => {
    session.metadata = { ...session.metadata };
    mutate(session.metadata);
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

  it('ignores engine carrier slots (turn_end / runStopped) as user speech', () => {
    const s = sessionWith([
      msg('user', '<turn_end id="t1"/>', { source: 'turnEnd' }),
      msg('user', 'run stopped: budget_exceeded', { source: 'runStopped' }),
    ]);
    expect(collectTitleUserTexts(s.messages)).toEqual([]);
    expect(isTitleSignalReady(s)).toBe(false);
    expect(buildSnippetTitle(s.messages)).toBeNull();
    const dialogue = buildTitlePrompt(s.messages).find((m) => m.role === 'user')!;
    expect(dialogue.content).toBe('');
  });

  it('buildTitlePrompt keeps real user speech while dropping carriers', () => {
    const prompt = buildTitlePrompt([
      msg('user', '<turn_end id="t1"/>', { source: 'turnEnd' }),
      msg('user', '帮我分析一下这个项目的依赖冲突应该怎么处理'),
    ]);
    const dialogue = prompt.find((m) => m.role === 'user')!;
    expect(dialogue.content).toContain('依赖冲突');
    expect(dialogue.content).not.toContain('turn_end');
  });

  it('schedule notify 便签（role=user + delivery:notify）不计用户发言', () => {
    const s = sessionWith([
      msg('user', '日程提醒：该做周报了', {
        source: 'runtime',
        origin: 'session_schedule',
        delivery: 'notify',
      }),
    ]);
    expect(collectTitleUserTexts(s.messages)).toEqual([]);
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

  it('skips markup/tool payload user text when building snippet', () => {
    const title = buildSnippetTitle([
      msg('user', '<knowledge-grounding source="kb">请检索并引用相关知识后再回答</knowledge-grounding>'),
      msg('user', '帮我核对二阶段场景上线收尾情况'),
    ]);
    expect(title).toContain('二阶段');
    expect(title).not.toContain('knowledge-grounding');
  });

  it('returns null when only markup payload exists', () => {
    expect(
      buildSnippetTitle([
        msg('user', '<knowledge-grounding source="kb">请检索并引用相关知识</knowledge-grounding>'),
      ]),
    ).toBeNull();
  });

  it('compresses file:// URL to filename in snippet (not raw path)', () => {
    const text =
      '帮我评估一下， file:///C:/Users/James/Documents/xwechat_files/wxid_n38/msg/file/2026-10/%E4%B8%BD%E5%8D%87%E5%A4%A7%E6%95%B0%E6%8D%AE%E7%B2%BE%E5%87%86%E8%AF%84%E4%BC%B0%E7%B3%BB%E7%BB%9F.pdf 里面描述的这几套系统的开发难度，规模，如果要自己开发的话，报价在多少合适';
    const title = buildSnippetTitle([msg('user', text)]);
    expect(title).not.toBeNull();
    expect(title).not.toContain('file://');
    expect(title).not.toContain('C:/Users');
    expect(title).not.toContain('%E4%B8%BD');
    // 文件名解码后应进入标题信号，而不是「帮我评估一下， file:///…」
    expect(title).toMatch(/丽升|评估|报价|系统/);
  });

  it('drops pure path user text from snippet', () => {
    expect(
      buildSnippetTitle([
        msg('user', 'file:///C:/Users/James/Documents/very/deep/path/report.pdf'),
      ]),
    ).toBeNull();
  });
});

describe('compactTitleText', () => {
  it('replaces URL with decoded filename and keeps surrounding request', () => {
    const out = compactTitleText(
      '帮我评估一下， file:///C:/tmp/%E4%BD%A0%E5%A5%BD.pdf 里的内容',
    );
    expect(out).not.toContain('file://');
    expect(out).toContain('你好.pdf');
    expect(out).toContain('里的内容');
  });

  it('replaces Windows absolute path with filename', () => {
    const out = compactTitleText('看下 C:\\Users\\James\\Desktop\\方案说明.docx 这个文件');
    expect(out).not.toContain('C:\\Users');
    expect(out).toContain('方案说明.docx');
    expect(out).toContain('这个文件');
  });
});

describe('looksLikeCodeOrMarkup', () => {
  it('flags tag-like titles but keeps normal topics', () => {
    expect(looksLikeCodeOrMarkup('<knowledge-grounding source="x">…')).toBe(true);
    expect(looksLikeCodeOrMarkup('npm 依赖冲突怎么处理')).toBe(false);
    expect(looksLikeCodeOrMarkup('修复登录 bug')).toBe(false);
  });
});

describe('isWeakTitle markup', () => {
  it('treats markup auto title as weak so it can be upgraded', () => {
    expect(isWeakTitle('<knowledge-grounding source="x">foo')).toBe(true);
    expect(shouldUpdateTitle({ title: '<knowledge-grounding source="x">foo', titleSource: 'auto' })).toBe(true);
  });

  it('treats path-dominated auto title as weak', () => {
    expect(isWeakTitle('file:///C:/Users/James/Documents/report.pdf')).toBe(true);
    expect(isWeakTitle('C:\\Users\\James\\Desktop\\x.pdf')).toBe(true);
    expect(
      shouldUpdateTitle({
        title: 'file:///C:/Users/James/Documents/report.pdf',
        titleSource: 'auto',
      }),
    ).toBe(true);
  });
});

describe('normalizeGeneratedTitle rejects markup', () => {
  it('unwraps simple tags and rejects bare tag payloads', () => {
    expect(normalizeGeneratedTitle('<title>依赖治理</title>')).toBe('依赖治理');
    expect(normalizeGeneratedTitle('<knowledge-grounding source="kb">')).toBeNull();
    expect(normalizeGeneratedTitle('<knowledge-grounding source="kb">检索</knowledge-grounding>')).toBe('检索');
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

  it('compresses paths in dialogue so model sees the request not the URL', () => {
    const text =
      '帮我评估一下， file:///C:/Users/James/Documents/x/%E4%B8%BD%E5%8D%87%E6%96%B9%E6%A1%88.pdf 里面描述的这几套系统的开发难度和报价';
    const prompt = buildTitlePrompt([msg('user', text)]);
    expect(prompt[1].content).not.toContain('file://');
    expect(prompt[1].content).not.toContain('%E4%B8%BD');
    expect(prompt[1].content).toContain('开发难度');
    expect(prompt[0].content).toContain('忽略路径');
  });
});

describe('maybeUpdateSessionTitle', () => {
  it('writes snippet when signal not ready', async () => {
    const session = sessionWith([
      msg('user', '你好'),
      msg('assistant', '你好！'),
    ]);
    const patchMetadata = vi.fn(patchInto(session));
    const onTitleUpdated = vi.fn();
    const chat = vi.fn();
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      patchMetadata,
      providers: new Map([['p', { chat, getModelInfo: () => undefined } as never]]),
      resolveFallback: () => ({ provider: { chat, getModelInfo: () => undefined } as never, model: 'mini' }),
      onTitleUpdated,
    });
    expect(ok).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    expect(session.metadata.title).toBe('你好');
    expect(session.metadata.titleSource).toBe('snippet');
    expect(onTitleUpdated).toHaveBeenCalledWith('s1', '你好', 'snippet', 'default');
  });

  it('generates auto title when signal ready', async () => {
    const session = sessionWith([
      msg('user', '帮我写一个会话标题自动生成的设计方案，要求支持手动重命名'),
      msg('assistant', '可以分两步：先 snippet，再小模型摘要。'),
    ]);
    const chat = vi.fn(async () => ({ content: '"会话标题自动生成方案"', model: 'mini', finishReason: 'stop' as const }));
    const provider = { chat, getModelInfo: () => undefined } as never;
    const patchMetadata = vi.fn(patchInto(session));
    const onTitleUpdated = vi.fn();
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      patchMetadata,
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated,
    });
    expect(ok).toBe(true);
    expect(chat).toHaveBeenCalledOnce();
    expect(session.metadata.title).toBe('会话标题自动生成方案');
    expect(session.metadata.titleSource).toBe('auto');
    expect(onTitleUpdated).toHaveBeenCalledWith('s1', '会话标题自动生成方案', 'auto', 'default');
  });

  it('skips when user renamed', async () => {
    const session = sessionWith(
      [msg('user', '帮我写一个会话标题自动生成的设计方案，要求支持手动重命名')],
      { title: '我的标题', titleSource: 'user' },
    );
    const patchMetadata = vi.fn(patchInto(session));
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      patchMetadata,
      providers: new Map(),
      resolveFallback: () => null,
      onTitleUpdated: vi.fn(),
    });
    expect(ok).toBe(false);
    expect(patchMetadata).not.toHaveBeenCalled();
    expect(session.metadata.title).toBe('我的标题');
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
      patchMetadata: patchInto(session),
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated: vi.fn(),
    });
    expect(ok).toBe(true);
    expect(session.metadata.titleSource).toBe('snippet');
    // 开场「帮我」被剥掉，snippet 落在事项上
    expect(String(session.metadata.title)).toContain('写一个会话标题');
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
      patchMetadata: async (_id: string, mutate: (m: Record<string, unknown>) => void) => {
        const metadata = { ...store.current.metadata };
        mutate(metadata);
        store.current = { ...store.current, metadata };
      },
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated,
    };

    // turn 1：仅打招呼 → snippet
    await maybeUpdateSessionTitle('s1', deps);
    expect(store.current.metadata.title).toBe('你好');
    expect(store.current.metadata.titleSource).toBe('snippet');
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
    expect(store.current.metadata.title).toBe('二阶段交付核对');
    expect(store.current.metadata.titleSource).toBe('auto');
  });

  it('upgrades greeting snippet even when model fails', async () => {
    const session = sessionWith([
      msg('user', '你好'),
      msg('assistant', '你好！'),
      msg('user', '帮我核对二阶段场景上线收尾情况以及一阶段是否如期交付'),
      msg('assistant', '本地资料八月后断更…'),
    ]);
    session.metadata.title = '你好';
    session.metadata.titleSource = 'snippet';
    session.metadata.titleUpdatedAt = Date.now();
    const chat = vi.fn(async () => {
      throw new Error('model down');
    });
    const provider = { chat, getModelInfo: () => undefined } as never;
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      patchMetadata: patchInto(session),
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated: vi.fn(),
    });
    expect(ok).toBe(true);
    expect(session.metadata.title).not.toBe('你好');
    expect(session.metadata.titleSource).toBe('snippet');
  });
});

describe('信封形态（f126dc9 真实数据）下的标题文本提取', () => {
  it('snippet 从 turn_start 信封解包用户原文（不受 turn_context 噪声与信封形状误判）', () => {
    // 开场客套「帮我」按 LEAD_IN 既有设计剥掉，snippet 落在事项上
    const title = buildSnippetTitle([envelopeMsg('帮我核对二阶段场景上线收尾情况')]);
    expect(title).toBe('核对二阶段场景上线收尾情况');
  });

  it('buildTitlePrompt 取 <user_message> 原文，不带信封/turn_context/记忆快照', () => {
    const prompt = buildTitlePrompt([envelopeMsg('核对云锡二阶段交付')]);
    const dialogue = prompt.find((m) => m.role === 'user')!;
    expect(dialogue.content).toContain('核对云锡二阶段交付');
    expect(dialogue.content).not.toContain('turn_start');
    expect(dialogue.content).not.toContain('turn_context');
    expect(dialogue.content).not.toContain('runtime_snapshot');
  });

  it('isTitleSignalReady 按用户原文长度而非信封长度（信封 boilerplate 不得放行寒暄）', () => {
    expect(isTitleSignalReady(sessionWith([envelopeMsg('你好')]))).toBe(false);
    expect(
      isTitleSignalReady(sessionWith([envelopeMsg('帮我分析一下这个项目的依赖冲突应该怎么处理')])),
    ).toBe(true);
  });

  it('信封形态端到端：snippet 兜底产出可读标题', async () => {
    const session = sessionWith([envelopeMsg('帮我写一个会话标题自动生成的设计方案，要求支持手动重命名')]);
    const chat = vi.fn(async () => {
      throw new Error('model down');
    });
    const provider = { chat, getModelInfo: () => undefined } as never;
    const ok = await maybeUpdateSessionTitle('s1', {
      load: async () => session,
      patchMetadata: patchInto(session),
      providers: new Map([['p', provider]]),
      resolveFallback: () => ({ provider, model: 'mini' }),
      onTitleUpdated: vi.fn(),
    });
    expect(ok).toBe(true);
    expect(session.metadata.titleSource).toBe('snippet');
    expect(String(session.metadata.title)).toContain('写一个会话标题');
    expect(String(session.metadata.title)).not.toContain('turn_start');
  });
});

describe('applyUserTitle', () => {
  it('marks title as user-owned (authority in metadata, meta is projection)', () => {
    const session = sessionWith([], { title: '旧', titleSource: 'auto' });
    const t = applyUserTitle(session, '  需求澄清  ');
    expect(t).toBe('需求澄清');
    expect(session.metadata.title).toBe('需求澄清');
    expect(session.metadata.titleSource).toBe('user');
    expect(session.meta.title).toBe('需求澄清');
    expect(session.meta.titleSource).toBe('user');
    expect(shouldUpdateTitle(session.meta)).toBe(false);
    expect(shouldUpdateTitle(readTitleState(session.metadata))).toBe(false);
  });

  it('rejects empty title', () => {
    const session = sessionWith([]);
    expect(applyUserTitle(session, '   ')).toBeNull();
  });
});
