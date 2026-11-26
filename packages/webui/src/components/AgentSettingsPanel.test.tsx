// @vitest-environment jsdom
/**
 * AgentSettingsPanel —「工作目录」编辑回归锚。
 *
 * 语义背景（逐键兜底，2026-11-26 拍板）：agent 级 effectPolicy 与全局逐键合并——
 * agent 写了的键赢、没写的键跟全局缺省；`transactionRoots` 两层并集（追加授权）。
 * 「继承全局」= 仅删 `mode` 子键（子键 null = 删键），不再互斥/不再整段删。因此：
 * 1. 未改动保存不得携带 effectPolicy（#6 回归锚）。
 * 2. 加/减根只发 `transactionRoots`（二级合并保留 mode 等旋钮，安全组不动）。
 * 3. 尚无 agent 级策略加根：只发 `transactionRoots`，**不固化 mode**（逐键兜底
 *    天然防 F2/F3 漂移，也不触发确认弹窗）。
 * 4. 「继承全局」与 agent 级工作目录可共存：发 `{ mode: null, transactionRoots }`
 *    （此前整段覆盖语义下不可表达的组合）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { AgentSettingsPanel } from './AgentSettingsPanel';
import { setLang } from '../i18n/core';

interface AgentRecord {
  id: string;
  persona?: { name?: string; description?: string };
  model?: unknown;
  effectMode?: string;
  effectModeSource?: string;
  tools?: { allow?: string[]; deny?: string[] };
  traits?: string[];
  workspace?: string;
  transactionRoots?: string[];
  hasOwnEffectPolicy?: boolean;
}

let agentsView: {
  agents: AgentRecord[];
  globalTransactionRoots: string[];
  globalEffectMode: string;
  hash: string;
};
/** PUT /config/agents/:id 的请求体（断言「写入了什么」） */
let puts: Array<{ id: string; agent: Record<string, unknown> }> = [];

/** 桩掉 fetch：/config/agents 视图来自 agentsView，PUT 记录请求体 */
function stubFetch(): void {
  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const pathname = new URL(u).pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      const respond = (data: unknown): unknown => ({
        ok: true,
        json: async () => ({ ok: true, data }),
      }) as unknown as Response;
      if (method === 'PUT' && /\/config\/agents\/[^/]+$/.test(pathname)) {
        const id = decodeURIComponent(pathname.split('/').pop()!);
        const body = init?.body ? (JSON.parse(init.body) as { agent: Record<string, unknown> }) : { agent: {} };
        puts.push({ id, agent: body.agent });
        return respond({ hash: 'h2', applied: 'next-run', affectedAgents: [id], backupPath: '/backup' });
      }
      if (pathname.endsWith('/config/presets/agent-roles')) return respond([]);
      if (pathname.endsWith('/persona/files')) return respond([]);
      if (pathname.endsWith('/persona')) return respond({ content: '# persona', hash: 'ph' });
      if (pathname.endsWith('/config/agents')) return respond(agentsView);
      return { ok: false, json: async () => ({ ok: false, error: `unstubbed ${method} ${u}` }) } as unknown as Response;
    }),
  );
}

/** 选中左侧 agent，等编辑表单载入（工作目录区出现） */
async function selectAgent(id: string): Promise<void> {
  await waitFor(() => expect(screen.getByText(id)).toBeTruthy());
  fireEvent.click(screen.getByText(id));
  await waitFor(() => expect(screen.getByText('工作目录')).toBeTruthy());
}

beforeEach(() => {
  setLang('zh');
  // 保存路径含确认弹窗（静默固化 / 删整段策略）——默认放行，专项用例再断言弹窗
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  agentsView = {
    hash: 'h1',
    globalEffectMode: 'workspace',
    globalTransactionRoots: [],
    agents: [
      {
        id: 'a1',
        persona: { name: 'A1', description: '' },
        model: { provider: 'openai', model: 'gpt' },
        effectMode: 'project',
        effectModeSource: 'agent',
        tools: { allow: [], deny: [] },
        traits: [],
        workspace: '/octopi/workspace/a1',
        transactionRoots: ['/proj/a'],
        hasOwnEffectPolicy: true,
      },
    ],
  };
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AgentSettingsPanel — 工作目录', () => {
  it('渲染基目录与已配置根；未改动保存不携带 effectPolicy（防全局固化）', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');
    expect(screen.getByText(/基目录：\/octopi\/workspace\/a1/)).toBeTruthy();
    expect(screen.getByText('/proj/a')).toBeTruthy();

    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));
    expect('effectPolicy' in puts[0]!.agent).toBe(false);
  });

  it('加/减根只发 transactionRoots（安全组不动）', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    // 追加一个根
    fireEvent.change(screen.getByPlaceholderText('/absolute/path（~/path = 授予整个 home）'), {
      target: { value: '/proj/b' },
    });
    fireEvent.click(screen.getByText('添加'));
    expect(screen.getByText('/proj/b')).toBeTruthy();

    // 移除旧根（行内按钮）
    const row = screen.getByText('/proj/a').closest('div')!;
    fireEvent.click(within(row).getByText('移除'));

    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]!.agent.effectPolicy).toEqual({ transactionRoots: ['/proj/b'] });
  });

  it('尚无 agent 级策略加根：只发 transactionRoots，不固化 mode、不弹确认（逐键兜底防 F2/F3）', async () => {
    agentsView.agents[0]!.effectMode = 'host';
    agentsView.agents[0]!.effectModeSource = 'global';
    agentsView.agents[0]!.transactionRoots = [];
    agentsView.agents[0]!.hasOwnEffectPolicy = false;
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    fireEvent.change(screen.getByPlaceholderText('/absolute/path（~/path = 授予整个 home）'), {
      target: { value: '/proj/x' },
    });
    fireEvent.click(screen.getByText('添加'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));
    // 逐键兜底：mode 不写即跟随全局——既不漂移也不触发安全写闸
    expect(puts[0]!.agent.effectPolicy).toEqual({ transactionRoots: ['/proj/x'] });
    expect(vi.mocked(window.confirm)).not.toHaveBeenCalled();
  });

  it('「继承全局」与 agent 级工作目录可共存：发 mode:null + transactionRoots（F-d 锚）', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    fireEvent.click(screen.getByText('继承全局'));
    fireEvent.change(screen.getByPlaceholderText('/absolute/path（~/path = 授予整个 home）'), {
      target: { value: '/proj/b' },
    });
    fireEvent.click(screen.getByText('添加'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));
    // 子键 null = 删 mode 键（跟随全局）；工作目录保留
    expect(puts[0]!.agent.effectPolicy).toEqual({
      mode: null,
      transactionRoots: ['/proj/a', '/proj/b'],
    });
    expect(vi.mocked(window.confirm)).not.toHaveBeenCalled();
  });

  it('清空全部根改发 null 删键（与「未改动不发」必须区分；F-5：不留空壳）', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    const row = screen.getByText('/proj/a').closest('div')!;
    fireEvent.click(within(row).getByText('移除'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]!.agent.effectPolicy).toEqual({ transactionRoots: null });
  });

  it('保存后快照刷新：删根保存→加回同根→保存，第二次仍发 effectPolicy（F4 回归锚）', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    // 删根 → 保存（服务端清空）
    const row = screen.getByText('/proj/a').closest('div')!;
    fireEvent.click(within(row).getByText('移除'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));

    // 加回同根 → 再保存：旧快照曾把这里判成「未改动」而静默丢弃
    fireEvent.change(screen.getByPlaceholderText('/absolute/path（~/path = 授予整个 home）'), {
      target: { value: '/proj/a' },
    });
    fireEvent.click(screen.getByText('添加'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(2));
    expect(puts[1]!.agent.effectPolicy).toEqual({ transactionRoots: ['/proj/a'] });
  });

  it('「继承全局」空根：只发 mode:null（F7 锚——不动其余键，不再整段删）', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    const row = screen.getByText('/proj/a').closest('div')!;
    fireEvent.click(within(row).getByText('移除'));
    fireEvent.click(screen.getByText('继承全局'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]!.agent.effectPolicy).toEqual({ mode: null, transactionRoots: null });
    expect(vi.mocked(window.confirm)).not.toHaveBeenCalled();
  });
});
