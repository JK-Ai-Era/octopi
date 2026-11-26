// @vitest-environment jsdom
/**
 * AgentSettingsPanel —「工作目录」编辑回归锚。
 *
 * 语义背景：agent 级 effectPolicy 是**对象级覆盖**全局（`agentDef.effectPolicy`
 * 整段优先，缺省才回落 `config.effectPolicy`），工作目录写在
 * `effectPolicy.transactionRoots`。因此：
 * 1. 未改动保存不得携带 effectPolicy（防把全局策略固化到 agent，#6 回归锚）。
 * 2. 已有 agent 级策略：加/减根只发 `transactionRoots`（二级合并保留 mode 等旋钮）。
 * 3. 尚无 agent 级策略：建段时必须带当前生效安全组——否则运行模式会从「继承全局」
 *    静默漂到引擎缺省 workspace。
 * 4. 「继承全局」（删整段）与 agent 级工作目录互斥——删键会连根一起删。
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

let agentsView: { agents: AgentRecord[]; hash: string };
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

  it('已有 agent 级策略：加/减根只发 transactionRoots（不带 mode）', async () => {
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

  it('尚无 agent 级策略：建段写入工作目录时固化当前生效安全组（防模式漂移）', async () => {
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
    expect(puts[0]!.agent.effectPolicy).toEqual({ mode: 'host', transactionRoots: ['/proj/x'] });
    // F3 锚：静默固化必须经显式确认（告知脱离全局安全组跟随）
    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(1);
  });

  it('「继承全局」与 agent 级工作目录互斥：保存被挡且不发请求', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    fireEvent.click(screen.getByText('继承全局'));
    fireEvent.click(screen.getByText('保存配置'));
    expect(screen.getByText(/不能与 agent 级工作目录共存/)).toBeTruthy();
    expect(puts.length).toBe(0);
  });

  it('清空全部根显式发空数组（与「未改动不发」必须区分）', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    const row = screen.getByText('/proj/a').closest('div')!;
    fireEvent.click(within(row).getByText('移除'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]!.agent.effectPolicy).toEqual({ transactionRoots: [] });
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

  it('「继承全局」+ 空根 → effectPolicy: null（删整段），并弹确认', async () => {
    render(<AgentSettingsPanel />);
    await selectAgent('a1');

    const row = screen.getByText('/proj/a').closest('div')!;
    fireEvent.click(within(row).getByText('移除'));
    fireEvent.click(screen.getByText('继承全局'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]!.agent.effectPolicy).toBeNull();
    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(1);
  });
});
