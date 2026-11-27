// @vitest-environment jsdom
/**
 * KnowledgeAdminPanel 项目挂载列表 —— 「挂载给 Agent」勾选的目标记账行为。
 *
 * 回归锁：勾选第 N 行 agent 必须落到该 agent 头上。
 * 曾经整列都落到面板 props.agentId（App 当前 agent，兜底 'default'），
 * 表现为「无论勾哪个都只有第一个 agent 被选中」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { KnowledgeAdminPanel } from './KnowledgeAdminPanel';
import { setLang } from '../i18n/core';

const h = vi.hoisted(() => ({
  /** setKnowledgeVisibility 调用账本：[targetAgent, body] */
  calls: [] as Array<[string, unknown]>,
  agents: [] as Array<{ id: string }>,
  projects: [] as Array<{
    projectKey: string;
    displayName?: string;
    sourceCount: number;
    assignedAgentIds: string[];
  }>,
}));

vi.mock('@octopi-agent/gateway/web/sdk/client', () => ({
  OctopiClient: class {
    async listKnowledgeSources(): Promise<unknown[]> {
      return [];
    }
    async listKnowledgeProjects() {
      return h.projects;
    }
    async getAgents() {
      return h.agents;
    }
    async getKnowledgeStats(): Promise<Record<string, number>> {
      return {};
    }
    async setKnowledgeVisibility(
      agentId: string,
      body: { op: string; projectKey?: string },
    ): Promise<void> {
      h.calls.push([agentId, body]);
      // 模拟服务端记账：挂载状态落到 fixture，供 refresh 后回显断言
      const proj = h.projects.find((p) => p.projectKey === body.projectKey);
      if (proj) {
        const others = proj.assignedAgentIds.filter((x) => x !== agentId);
        proj.assignedAgentIds = body.op === 'assignProject' ? [...others, agentId] : others;
      }
    }
    on(): void {}
    connect(): void {}
    disconnect(): void {}
  },
}));

describe('KnowledgeAdminPanel 挂载列表（挂载给 Agent 的记账目标）', () => {
  beforeEach(() => {
    setLang('zh'); // 文案锚点依赖 zh，显式钉住（勿受宿主默认语言影响）
    h.calls = [];
    h.agents = [{ id: 'agent-a' }, { id: 'agent-b' }];
    h.projects = [
      {
        projectKey: 'pk-1',
        displayName: 'Demo',
        sourceCount: 0,
        assignedAgentIds: ['agent-a'],
      },
    ];
  });
  afterEach(cleanup);

  async function openMountList(panelAgentId: string): Promise<void> {
    render(<KnowledgeAdminPanel agentId={panelAgentId} />);
    fireEvent.click(screen.getByRole('button', { name: '项目' }));
    fireEvent.click(await screen.findByRole('button', { name: /Demo/ }));
    await screen.findByText('挂载给 Agent');
  }

  it('勾选未挂载的 agent：assignProject 记到该行 agent，而不是面板当前 agent', async () => {
    // 面板 agentId=agent-a（=列表第一个）；勾的是 agent-b
    await openMountList('agent-a');
    fireEvent.click(screen.getByRole('checkbox', { name: /agent-b/ }));

    await waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0]).toEqual(['agent-b', { op: 'assignProject', projectKey: 'pk-1' }]);
    // refresh 后回显：该行翻为已挂载
    await waitFor(() =>
      expect((screen.getByRole('checkbox', { name: /agent-b/ }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
  });

  it('取消已挂载 agent 的勾选：unassignProject 同样按行记账', async () => {
    // 面板 agentId=agent-b；取消的是 agent-a（已挂载）
    await openMountList('agent-b');
    fireEvent.click(screen.getByRole('checkbox', { name: /agent-a/ }));

    await waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0]).toEqual(['agent-a', { op: 'unassignProject', projectKey: 'pk-1' }]);
    // refresh 后回显：该行翻为未挂载
    await waitFor(() =>
      expect((screen.getByRole('checkbox', { name: /agent-a/ }) as HTMLInputElement).checked).toBe(
        false,
      ),
    );
  });
});
