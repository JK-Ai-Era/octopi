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

const h = vi.hoisted(() => ({
  /** 调用顺序账本：断言「先建会话、后发送」 */
  calls: [] as Array<{ kind: string; sessionId?: string }>,
  /** createSession 是否抛错（复现前置条件不满足 / 网络失败） */
  failCreate: false,
}));

vi.mock('@octopi-agent/gateway/web/runtime/store', () => {
  /** 未显式实现的 store 方法一律返回 undefined（多数只在特定事件里被调用） */
  function stubbed(target: Record<string, unknown>, prop: string): () => undefined {
    if (!Object.prototype.hasOwnProperty.call(target, prop)) target[prop] = () => undefined;
    return target[prop] as () => undefined;
  }

  class FakeStore {
    chat = { sessionId: null as string | null, agentId: 'default', viewMode: 'history' };
    private handlers = new Map<string, Array<(e: CustomEvent) => void>>();

    constructor(_client: unknown) {
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
        agents: [{ id: 'default', model: { model: 'stub-model' }, effectMode: 'workspace', effectModeSource: 'default' }],
      });
      // 右栏 rail 行按 `xxx.filter(...)` 渲染，这些 state 初值是 undefined、只能靠事件灌
      this.emit('tasks', { tasks: [] });
      this.emit('schedules', { schedules: [] });
      this.emit('questions', { questions: [] });
      this.emit('approvals', { approvals: [] });
      this.emit('clientToolCalls', { calls: [] });
    }

    disconnect(): void {
      /* noop */
    }

    async refreshSessions(): Promise<void> {
      this.emit('sessions', { sessions: [] });
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
  localStorage.clear();
  sessionStorage.clear();
});

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
