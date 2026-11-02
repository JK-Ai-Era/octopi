// @vitest-environment jsdom
/**
 * DescriptionSourceBadge / KnowledgeServiceStatus — 信任分级徽标与生命周期标记的行为测试。
 * 只测状态语义与可见性（seed/常驻/瞬态/所有权），不做 UI 快照。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { DescriptionSourceBadge } from './DescriptionSourceBadge';
import { KnowledgeServiceStatus } from './KnowledgeServiceStatus';
import type {
  OctopiClient,
  AgentEventEnvelope,
  ConnectionState,
} from '@octopi-agent/gateway/web/sdk/client';

function makeClient(opts?: {
  knowledge?: 'starting' | 'disabled' | 'ready' | 'degraded';
  failHealth?: boolean;
}): {
  client: OctopiClient;
  fire: (event: { type: string; data?: unknown }) => void;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
  reopen: (s: ConnectionState) => void;
} {
  let onEvent: ((sid: string | undefined, e: AgentEventEnvelope) => void) | null = null;
  let onConnectionState: ((s: ConnectionState) => void) | null = null;
  const disconnect = vi.fn();
  const connect = vi.fn();
  const health = vi.fn(async () => {
    if (opts?.failHealth) throw new Error('offline');
    return { status: 'ok', agents: [], knowledge: opts?.knowledge };
  });
  const client = {
    on: vi.fn(
      (events: {
        onEvent?: (sid: string | undefined, e: AgentEventEnvelope) => void;
        onConnectionState?: (s: ConnectionState) => void;
      }) => {
        onEvent = events.onEvent ?? null;
        onConnectionState = events.onConnectionState ?? null;
      },
    ),
    connect,
    disconnect,
    health,
  } as unknown as OctopiClient;
  return {
    client,
    fire: (event) => onEvent?.(undefined, event as unknown as AgentEventEnvelope),
    connect,
    disconnect,
    health,
    reopen: (s) => onConnectionState?.(s),
  };
}

describe('DescriptionSourceBadge（human > llm > heuristic 信任分级）', () => {
  afterEach(cleanup);

  it('llm / blocked_secret / 缺省（旧库归因缺失=启发式）三档各自成标；未知值兜底启发式', () => {
    const { rerender } = render(<DescriptionSourceBadge source="llm" />);
    expect(screen.getByText('LLM 生成')).toBeTruthy();
    rerender(<DescriptionSourceBadge source="blocked_secret" />);
    expect(screen.getByText('启发式 · 密钥封锁')).toBeTruthy();
    rerender(<DescriptionSourceBadge />);
    expect(screen.getByText('启发式')).toBeTruthy();
    // 运行时脏值（历史/手改/未来枚举）不得打崩面板（评审 P2-2）
    rerender(<DescriptionSourceBadge source={'weird' as 'llm'} />);
    expect(screen.getByText('启发式')).toBeTruthy();
  });
});

describe('KnowledgeServiceStatus（知识服务状态指示器）', () => {
  afterEach(cleanup);

  it('正常态零占位；exited/restarting 常驻，recovered 瞬态后归零；connect 接线被锁', () => {
    vi.useFakeTimers();
    const mock = makeClient();
    render(<KnowledgeServiceStatus client={mock.client} />);
    // P1-3 接线锁：connect 必须被调用（否则事件链整体死亡而测试假绿）
    expect(mock.connect).toHaveBeenCalledTimes(1);
    // 正常（health 无 knowledge 异常）：零占位
    expect(screen.queryByText(/知识服务/)).toBeNull();

    act(() => mock.fire({ type: 'knowledge.service.exited', data: { code: 137, signal: null } }));
    expect(screen.getByText('知识服务进程退出 · 自愈中')).toBeTruthy();
    // P1-4：崩溃唯一诊断信息（code/signal）必须可查
    expect(screen.getByTitle(/code=137/)).toBeTruthy();

    act(() =>
      mock.fire({
        type: 'knowledge.service.restarting',
        data: { attempt: 2, backoffMs: 4000, reason: 'exited' },
      }),
    );
    expect(screen.getByText('知识服务重启中（第 2 次，退避 4s）')).toBeTruthy();
    expect(screen.getByTitle(/触发=进程退出/)).toBeTruthy();

    act(() => mock.fire({ type: 'knowledge.service.recovered', data: {} }));
    expect(screen.getByText('知识服务已恢复')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText(/知识服务/)).toBeNull();
    vi.useRealTimers();
  });

  it('seed：mount 与 WS 重连以 /health 为准（换页/网关重启的漏报与陈旧红标纠偏）', async () => {
    const mock = makeClient({ knowledge: 'degraded' });
    render(<KnowledgeServiceStatus client={mock.client} />);
    // mount seed：服务正挂时打开控制台即可见（不依赖错过事件）；seed 是异步 health 快照
    expect(await screen.findByText('知识服务不可用 · 自愈重试中')).toBeTruthy();

    // 模拟网关重启后重连：health 已 ready → 陈旧红标必须被清掉（无 recovered 事件）
    (mock.health as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'ok',
      agents: [],
      knowledge: 'ready',
    });
    await act(async () => {
      mock.reopen('connected');
    });
    expect(screen.queryByText(/知识服务/)).toBeNull();
  });

  it('restart_failed 常驻；非生命周期事件被忽略；借用的 client 不接管生命周期', () => {
    const mock = makeClient({ failHealth: true });
    const { unmount } = render(<KnowledgeServiceStatus client={mock.client} />);

    act(() => mock.fire({ type: 'knowledge.index.progress', data: { pct: 50 } }));
    expect(screen.queryByText(/知识服务/)).toBeNull();

    act(() =>
      mock.fire({
        type: 'knowledge.service.restart_failed',
        data: { attempt: 3, error: 'health down' },
      }),
    );
    expect(screen.getByText('知识服务重启失败（第 3 次）· 继续退避重试')).toBeTruthy();

    unmount();
    // P1-2：prop 传入的是借用 client——卸载不得掐断别人的 WS
    expect(mock.disconnect).not.toHaveBeenCalled();
  });
});
