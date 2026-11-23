// @vitest-environment jsdom
/**
 * 空态（无选中会话）发送 = 自动新建会话 的行为回归。
 *
 * 只替换 gateway 的 store / client 两个出口（组件自己 new 出来，无法注入），
 * 其余（i18n、命令补全、发送编排）走真实实现。
 *
 * 契约与真实 store 对齐，避免替身放水：
 * - `createSession` 成功后才把 `chat.sessionId` 置位；
 * - `sendMessage` 在 `chat.sessionId` 为空时抛「No active session」。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ChatWorkspace from './ChatWorkspace';
import { readComposerDraft } from '../composer-draft';
import { readPendingAttachments, writePendingAttachments } from '../pending-attachments';

const h = vi.hoisted(() => ({
  /** 调用顺序账本：断言「先建会话、后发送」 */
  calls: [] as Array<{ kind: string; sessionId?: string }>,
  /** createSession 是否抛错（复现前置条件不满足 / 网络失败） */
  failCreate: false,
  /** sessions 事件投影：默认空；草稿测试用它构造两个可切换会话 */
  sessions: [] as Array<{ id: string; agentId: string; title: string; lastInteractionAt: number }>,
  /** connection 事件里的 agent 列表：默认单 agent，agent 切换用例追加第二个 */
  agents: [{ id: 'default', model: { model: 'stub-model' }, effectMode: 'workspace', effectModeSource: 'default' }] as Array<Record<string, unknown>>,
  /** 服务端会话附件登记投影（待发附件核对用） */
  attachments: [] as Array<{ id: string }>,
  /** 发送挂起闸门：模拟慢网络下「发送在途时用户切走会话」 */
  sendBarrier: null as Promise<void> | null,
  /** refreshSessions 对哪个 agent 抛错（模拟切 agent 失败） */
  failRefreshFor: null as string | null,
  /** 已创建的 store 实例（断言 store.chat 是否被回滚） */
  stores: [] as Array<{ chat: { sessionId: string | null; agentId: string } }>,
}));

vi.mock('@octopi-agent/gateway/web/runtime/store', () => {
  /** 未显式实现的 store 方法一律返回 undefined（多数只在特定事件里被调用） */
  function stubbed(target: Record<string, unknown>, prop: string): () => undefined {
    if (!Object.prototype.hasOwnProperty.call(target, prop)) target[prop] = () => undefined;
    return target[prop] as () => undefined;
  }

  class FakeStore {
    chat: {
      sessionId: string | null;
      agentId: string;
      viewMode: string;
      conversation: unknown[];
      streamingContent: string;
      runStatus: string;
    } = {
      sessionId: null,
      agentId: 'default',
      viewMode: 'history',
      conversation: [],
      streamingContent: '',
      runStatus: 'idle',
    };
    private handlers = new Map<string, Array<(e: CustomEvent) => void>>();

    constructor(_client: unknown) {
      h.stores.push(this);
      const target = this as unknown as Record<string, unknown>;
      return new Proxy(this, {
        get: (t, p, r) => {
          if (p in t) return Reflect.get(t, p, r);
          if (typeof p !== 'string') return undefined;
          return stubbed(target, p);
        },
      });
    }

    addEventListener(type: string, fn: (e: CustomEvent) => void): void {
      const list = this.handlers.get(type) ?? [];
      list.push(fn);
      this.handlers.set(type, list);
    }

    private emit(type: string, detail: unknown): void {
      for (const fn of this.handlers.get(type) ?? []) fn({ detail } as CustomEvent);
    }

    getState(): { chat: FakeStore['chat'] } {
      return { chat: this.chat };
    }

    connect(): void {
      this.emit('connection', {
        state: 'connected',
        // 侧栏渲染要读 a.model.model / a.effectMode，缺了会在 render 期抛
        agents: h.agents,
      });
      // 右栏 rail 行按 `xxx.filter(...)` 渲染，这些 state 初值是 undefined、只能靠事件灌
      this.emit('tasks', { tasks: [] });
      this.emit('schedules', { schedules: [] });
      this.emit('questions', { questions: [] });
      this.emit('approvals', { approvals: [] });
      this.emit('clientToolCalls', { calls: [] });
      // 真实 store：connect 后即拉到会话投影；驱动侧栏与“刷新自动打开最近会话”
      this.emit('sessions', { sessions: h.sessions });
    }

    disconnect(): void {
      /* noop */
    }

    /** 真实 store：按 agent 过滤（无参 = 全部）并返回列表 */
    async refreshSessions(agentId?: string): Promise<typeof h.sessions> {
      if (agentId && h.failRefreshFor === agentId) throw new Error('refresh failed');
      const list = agentId ? h.sessions.filter((s) => s.agentId === agentId) : h.sessions;
      this.emit('sessions', { sessions: list });
      return list;
    }

    /** 切换会话：组件随后从 getState() 读回这些字段；agent 跟着会话走（与真实 store 一致） */
    async openSession(sessionId: string): Promise<void> {
      this.chat.sessionId = sessionId;
      const owner = h.sessions.find((s) => s.id === sessionId)?.agentId;
      if (owner) this.chat.agentId = owner;
      this.chat.conversation = [];
      this.chat.streamingContent = '';
      this.chat.runStatus = 'idle';
    }

    /** 关闭活动会话（切到无会话的 agent 时调用） */
    closeCurrentSession(): void {
      this.chat.sessionId = null;
      this.chat.conversation = [];
      this.chat.streamingContent = '';
      this.chat.runStatus = 'idle';
    }

    async refreshSessionModel(): Promise<void> {
      /* 模型投影与本组用例无关 */
    }

    getSessionModel(): null {
      return null;
    }

    // openSession 同步灌状态用的是同步访问器（setApprovals(store.getApprovals())），必须返回数组
    getApprovals(): [] {
      return [];
    }

    getTasks(): [] {
      return [];
    }

    getQuestions(): [] {
      return [];
    }

    getSchedules(): [] {
      return [];
    }

    getClientToolCalls(): [] {
      return [];
    }

    // 心跳 effect 里是 `void store.heartbeatClientTools(...).catch(...)`，必须是 Promise
    async heartbeatClientTools(): Promise<void> {
      /* noop */
    }

    async createSession(agentId: string): Promise<Record<string, unknown>> {
      h.calls.push({ kind: 'createSession' });
      if (h.failCreate) throw new Error('create failed');
      const session = { id: 'sess-new', agentId, title: null, lastInteractionAt: Date.now() };
      // 真实 store：先置活动会话再广播，否则 sessions 监听会抢开旧会话
      this.chat.sessionId = session.id;
      this.emit('sessions', { sessions: [session] });
      this.emit('session', { session });
      return session;
    }

    async sendMessage(text: string): Promise<{ ok: boolean }> {
      h.calls.push({ kind: 'sendMessage', sessionId: this.chat.sessionId ?? undefined });
      if (!this.chat.sessionId) throw new Error('No active session');
      void text;
      if (h.sendBarrier) await h.sendBarrier;
      return { ok: true };
    }
  }

  return { OctopiRuntimeStore: FakeStore };
});

vi.mock('@octopi-agent/gateway/web/sdk/client', () => {
  class FakeClient {
    constructor(_opts: unknown) {
      const target = this as unknown as Record<string, unknown>;
      return new Proxy(this, {
        get: (t, p, r) => {
          if (p in t) return Reflect.get(t, p, r);
          if (typeof p !== 'string') return undefined;
          if (!Object.prototype.hasOwnProperty.call(target, p)) target[p] = () => Promise.resolve(undefined);
          return target[p];
        },
      });
    }

    async getCommands(): Promise<[]> {
      return [];
    }

    async listIssues(): Promise<[]> {
      return [];
    }

    // 子会话列表会直接 setChildSessions(list)，undefined 会让右栏徽标 .length 抛
    async listChildSessions(): Promise<[]> {
      return [];
    }

    /** 待发附件恢复时的服务端核对 */
    async listSessionAttachments(): Promise<Array<{ id: string }>> {
      return h.attachments;
    }
  }

  return { OctopiClient: FakeClient };
});

beforeAll(() => {
  // jsdom 缺的浏览器 API：组件挂载期就会碰
  class ObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', ObserverStub);
  vi.stubGlobal('ResizeObserver', ObserverStub);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  );
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('scrollTo', () => {});
});

afterEach(() => {
  cleanup();
  h.calls.length = 0;
  h.failCreate = false;
  h.sessions.length = 0;
  h.attachments.length = 0;
  h.sendBarrier = null;
  h.failRefreshFor = null;
  h.stores.length = 0;
  h.agents.splice(1); // 只留默认 agent，避免用例间串台
  localStorage.clear();
  sessionStorage.clear();
});

/** 两个可切换会话：s1 较早（Task A），s2 较近（Task B） */
function seedTwoSessions(): void {
  h.sessions = [
    { id: 's1', agentId: 'default', title: 'Task A', lastInteractionAt: 2_000 },
    { id: 's2', agentId: 'default', title: 'Task B', lastInteractionAt: 1_000 },
  ];
}

/** 左栏会话行标题（顶栏也会显示当前会话标题，必须限定选择器） */
function sessionRow(title: string): HTMLElement {
  return screen.getByText(title, { selector: 'span.session-card-title' });
}

/** 等左栏高亮落到指定会话（= openSession 完成） */
async function expectActiveSession(title: string): Promise<void> {
  await waitFor(() => {
    expect(sessionRow(title).closest('button')?.className).toContain('session-btn-active');
  });
}

function renderWorkspace() {
  return render(<ChatWorkspace rightPanelVisible onAgentIdChange={vi.fn()} />);
}

async function composer(): Promise<HTMLTextAreaElement> {
  return (await screen.findByRole('textbox')) as HTMLTextAreaElement;
}

describe('空态发送 = 自动新建会话', () => {
  it('无选中会话时输入后发送键可用，Enter 先建会话再投递', async () => {
    renderWorkspace();
    expect(await screen.findByText('未选择会话')).toBeTruthy();

    const box = await composer();
    const send = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true); // 空输入：本来就该禁用

    fireEvent.change(box, { target: { value: 'hello from empty state' } });
    await waitFor(() => expect(send.disabled).toBe(false)); // 关键：旧版无会话恒禁用

    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(h.calls.map((c) => c.kind)).toEqual(['createSession', 'sendMessage']));
    // 发送落在刚建出的会话上，而不是空 sessionId（真实 store 会在这里抛错）
    expect(h.calls[1].sessionId).toBe('sess-new');
    await waitFor(() => expect(box.value).toBe(''));
    // 建完就选中了，头部不再显示「未选择会话」
    await waitFor(() => expect(screen.queryByText('未选择会话')).toBeNull());
  });

  it('建会话失败：不发送、错误外显、输入保留可重试', async () => {
    h.failCreate = true;
    renderWorkspace();
    const box = await composer();

    fireEvent.change(box, { target: { value: 'will fail' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(h.calls.map((c) => c.kind)).toEqual(['createSession']));
    expect(box.value).toBe('will fail'); // 输入没被吃掉
    // actionError 在左栏与输入区各露一次（左栏在移动端是 CSS 隐藏的）
    await waitFor(() => expect(document.querySelectorAll('.status-error').length).toBeGreaterThan(0));
  });

  it('空态下 /stop 静默忽略：不建会话、不发送、不报错', async () => {
    renderWorkspace();
    const box = await composer();

    // 带空格才绕过命令补全（无空格时 Enter 被补全分支吃掉，到不了 sendMessage）
    fireEvent.change(box, { target: { value: '/stop ' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(box.value).toBe('/stop '));
    expect(h.calls).toEqual([]);
    expect(document.querySelectorAll('.status-error').length).toBe(0);
    expect(await screen.findByText('未选择会话')).toBeTruthy(); // 也没偷偷建出会话
  });
});

describe('输入框草稿按会话缓存', () => {
  it('切换会话各自保留草稿；重新挂载（刷新）后仍可取回', async () => {
    seedTwoSessions();
    renderWorkspace();
    const box = await composer();
    await expectActiveSession('Task A'); // 自动打开最近会话

    fireEvent.change(box, { target: { value: '草稿 A' } });
    // 输入即时落盘到当前会话；空态草稿不受影响
    expect(readComposerDraft({ sessionId: 's1' })).toBe('草稿 A');
    expect(readComposerDraft({ sessionId: null })).toBe('');

    fireEvent.click(sessionRow('Task B'));
    await waitFor(() => expect(box.value).toBe(''));
    await expectActiveSession('Task B');

    fireEvent.change(box, { target: { value: '草稿 B' } });
    expect(readComposerDraft({ sessionId: 's2' })).toBe('草稿 B');

    // 切回 A：B 的草稿留在 B，不会被串台覆盖
    fireEvent.click(sessionRow('Task A'));
    await waitFor(() => expect(box.value).toBe('草稿 A'));
    expect(readComposerDraft({ sessionId: 's2' })).toBe('草稿 B');

    // 刷新 = 卸载后重新挂载：草稿从 localStorage 恢复
    cleanup();
    renderWorkspace();
    const box2 = await composer();
    await waitFor(() => expect(box2.value).toBe('草稿 A')); // 自动打开最近会话 s1
    fireEvent.click(sessionRow('Task B'));
    await waitFor(() => expect(box2.value).toBe('草稿 B'));
  });

  it('空态输入建会话并发送成功后，空态与目标会话草稿都清空', async () => {
    renderWorkspace();
    const box = await composer();

    fireEvent.change(box, { target: { value: 'hello from draft' } });
    expect(readComposerDraft({ sessionId: null })).toBe('hello from draft');

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe(''));
    await waitFor(() => expect(h.calls.map((c) => c.kind)).toEqual(['createSession', 'sendMessage']));

    // 空态草稿已随新建会话迁走；发送成功后再从新会话删掉，返回空态不会“复活”
    expect(readComposerDraft({ sessionId: null })).toBe('');
    expect(readComposerDraft({ sessionId: 'sess-new' })).toBe('');
  });

  it('建会话失败：输入与草稿都保留可重试', async () => {
    h.failCreate = true;
    renderWorkspace();
    const box = await composer();

    fireEvent.change(box, { target: { value: 'retry me' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(h.calls.map((c) => c.kind)).toEqual(['createSession']));
    expect(box.value).toBe('retry me');
    expect(readComposerDraft({ sessionId: null })).toBe('retry me');
  });
});

describe('刷新回到上次打开的会话', () => {
  it('重挂载时优先恢复上次点击的会话，而不是最近交互的那个', async () => {
    // s1 最近交互（首连会打开它），但我们手动切到更早的 s2 再刷新
    seedTwoSessions();
    renderWorkspace();
    await composer();
    await expectActiveSession('Task A'); // 首连：按最近交互

    fireEvent.click(sessionRow('Task B'));
    await expectActiveSession('Task B');

    cleanup(); // 刷新
    renderWorkspace();
    await composer();
    await expectActiveSession('Task B'); // 回到离开时的 B，而不是最近的 A
  });

  it('记录的会话已不存在时退回最近交互会话', async () => {
    seedTwoSessions();
    renderWorkspace();
    await composer();
    fireEvent.click(sessionRow('Task B'));
    await expectActiveSession('Task B');
    cleanup();

    // 另一路删掉了 s2：列表里只剩 s1
    h.sessions = h.sessions.filter((s) => s.id !== 's2');
    renderWorkspace();
    await composer();
    await expectActiveSession('Task A');
  });
});

describe('待发附件按会话缓存', () => {
  function chips(): string[] {
    return Array.from(document.querySelectorAll('.attachment-chip')).map(
      (el) => el.textContent?.replace('×', '').trim() ?? '',
    );
  }

  it('切换会话/刷新后各自的待发附件仍在', async () => {
    seedTwoSessions();
    h.attachments = [{ id: 'a1' }, { id: 'a2' }];
    writePendingAttachments('s1', [{ id: 'a1', name: 'a.pdf', sizeBytes: 1, status: 'ready' }]);
    writePendingAttachments('s2', [{ id: 'a2', name: 'b.pdf', sizeBytes: 1, status: 'ready' }]);

    renderWorkspace();
    await composer();
    await expectActiveSession('Task A');
    await waitFor(() => expect(chips()).toEqual(['a.pdf']));

    fireEvent.click(sessionRow('Task B'));
    await expectActiveSession('Task B');
    await waitFor(() => expect(chips()).toEqual(['b.pdf']));

    // 刷新后自动回到 B（上次会话），附件随之回来
    cleanup();
    renderWorkspace();
    await composer();
    await expectActiveSession('Task B');
    await waitFor(() => expect(chips()).toEqual(['b.pdf']));

    fireEvent.click(sessionRow('Task A'));
    await waitFor(() => expect(chips()).toEqual(['a.pdf']));
  });

  it('服务端已删除的附件在恢复时被剔除并回写', async () => {
    seedTwoSessions();
    // 本地记录 a1（still alive）+ ghost（服务端已无）
    writePendingAttachments('s1', [
      { id: 'a1', name: 'alive.pdf', sizeBytes: 1, status: 'ready' },
      { id: 'ghost', name: 'ghost.pdf', sizeBytes: 1, status: 'ready' },
    ]);
    h.attachments = [{ id: 'a1' }];

    renderWorkspace();
    await composer();
    await expectActiveSession('Task A');
    await waitFor(() => expect(chips()).toEqual(['alive.pdf']));
    expect(readPendingAttachments('s1').map((a) => a.id)).toEqual(['a1']);
  });
});

describe('发送在途切走会话', () => {
  it('只清发起会话的草稿，当前会话的输入不受影响', async () => {
    seedTwoSessions();
    renderWorkspace();
    const box = await composer();
    await expectActiveSession('Task A');

    let release!: () => void;
    h.sendBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.change(box, { target: { value: '发送中' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(h.calls.some((c) => c.kind === 'sendMessage')).toBe(true));

    // 发送未返回就切到 B 并打字
    fireEvent.click(sessionRow('Task B'));
    await expectActiveSession('Task B');
    fireEvent.change(box, { target: { value: '草稿 B' } });

    release();
    await waitFor(() => expect(readComposerDraft({ sessionId: 's1' })).toBe(''));
    // B 的草稿与输入框不能被 A 的发送回调清掉
    expect(readComposerDraft({ sessionId: 's2' })).toBe('草稿 B');
    expect(box.value).toBe('草稿 B');
  });
});

describe('切 agent 回到该 agent 上次的会话', () => {
  /** 第二个 agent：两个 agent 各有两个会话，且「最近交互」故意与「上次打开」不一致 */
  function seedTwoAgents(): void {
    h.agents.push({
      id: 'alt',
      model: { model: 'stub-model-alt' },
      effectMode: 'workspace',
      effectModeSource: 'default',
    });
    h.sessions = [
      // default：Task A 最近交互，但用户上次打开的是 Task A2
      { id: 's-a1', agentId: 'default', title: 'Task A', lastInteractionAt: 9_000 },
      { id: 's-a2', agentId: 'default', title: 'Task A2', lastInteractionAt: 1_000 },
      // alt：Task B 最近交互，但用户上次打开的是 Task B2
      { id: 's-b1', agentId: 'alt', title: 'Task B', lastInteractionAt: 8_000 },
      { id: 's-b2', agentId: 'alt', title: 'Task B2', lastInteractionAt: 2_000 },
    ];
  }

  it('回到记录的会话，而不是该 agent 最近交互的会话', async () => {
    seedTwoAgents();
    renderWorkspace();
    await composer();
    // 首连打开最近交互的 s-a1；手动切到 s-a2 并留下记录
    await expectActiveSession('Task A');
    fireEvent.click(sessionRow('Task A2'));
    await expectActiveSession('Task A2');

    // 切到 alt：没有记录 → 最近交互 s-b1
    fireEvent.click(screen.getByText('alt', { selector: 'div' }));
    await expectActiveSession('Task B');

    // alt 手动切到 s-b2
    fireEvent.click(sessionRow('Task B2'));
    await expectActiveSession('Task B2');

    // 回 default：应回到 s-a2（记录），而不是最近交互的 s-a1
    fireEvent.click(screen.getByText('default', { selector: 'div' }));
    await expectActiveSession('Task A2');

    // 再回 alt：回到 s-b2
    fireEvent.click(screen.getByText('alt', { selector: 'div' }));
    await expectActiveSession('Task B2');
  });

  it('记录的会话已不存在时，退回该 agent 最近交互的会话', async () => {
    seedTwoAgents();
    renderWorkspace();
    await composer();
    await expectActiveSession('Task A');
    fireEvent.click(sessionRow('Task A2'));
    await expectActiveSession('Task A2');

    fireEvent.click(screen.getByText('alt', { selector: 'div' }));
    await expectActiveSession('Task B');
    fireEvent.click(screen.getByText('default', { selector: 'div' }));
    await expectActiveSession('Task A2');

    // 另一路删掉 s-a2 后再切走切回
    h.sessions = h.sessions.filter((s) => s.id !== 's-a2');
    fireEvent.click(screen.getByText('alt', { selector: 'div' }));
    await expectActiveSession('Task B');
    fireEvent.click(screen.getByText('default', { selector: 'div' }));
    await expectActiveSession('Task A'); // 记录失效 → 最近交互
  });
});
