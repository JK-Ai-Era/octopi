/**
 * SEC-7 Gateway HITL approvals — requestApproval / resolve / cancel / timeout / scope
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';

function makeProvider(): ModelProvider {
  return {
    name: 'openai',
    defaultModel: 'gpt-5-mini',
    getModelInfo: (m: string) => ({ name: m }),
    getModelInfos: () => [{ name: 'gpt-5-mini' }],
    isAvailable: async () => true,
    chat: async () => ({ content: '', model: 'gpt-5-mini', finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  };
}

function makeAgent(id: string): AgentDefinition {
  return {
    id,
    home: '',
    workspace: '',
    persona: { name: id, description: '', systemPrompt: 'test' },
    tools: { allow: ['*'] },
    model: { provider: 'openai', model: 'gpt-5-mini' },
  };
}

function approvalRequest(toolName = 'shell') {
  return {
    kind: 'high_risk' as const,
    toolName,
    arguments: { command: 'ls' },
    riskLevel: 'high' as const,
    riskDescription: 'test risk',
    actionDescription: toolName,
  };
}

describe('Gateway HITL approvals', () => {
  let gateway: Gateway;

  beforeEach(async () => {
    gateway = new Gateway(
      {
        agents: [makeAgent('assistant')],
        knowledge: { service: { manageLocal: false } },
      },
      new InMemorySessionStore(),
    );
    gateway.registerProvider(makeProvider());
    await gateway.start();
  });

  afterEach(async () => {
    await gateway.stop();
  });

  it('requestApproval → pending → resolve once maps to approve', async () => {
    const pending = gateway.requestApproval({
      sessionId: 's1',
      agentId: 'assistant',
      request: approvalRequest(),
    });

    const list = gateway.listPendingApprovals('s1');
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('pending');
    expect(list[0]!.request.kind).toBe('high_risk');

    const resolved = gateway.resolvePendingApproval(list[0]!.id, {
      action: 'approve',
      approver: 'owner-alice',
      channel: 'webhook',
    });
    expect(resolved?.status).toBe('approved');
    expect(resolved?.decisionScope).toBe('once');
    // P5 确认人入账：决策带归因（谁批的/哪条通道），且随视图定格
    expect(resolved?.decidedBy).toBe('owner-alice');
    expect(resolved?.decisionChannel).toBe('webhook');
    await expect(pending).resolves.toMatchObject({
      decision: 'approve',
      approver: 'owner-alice',
      channel: 'webhook',
    });
  });

  it('scope session/always map to approve_session/approve_always', async () => {
    const p1 = gateway.requestApproval({
      sessionId: 's2',
      agentId: 'assistant',
      request: approvalRequest('shell'),
    });
    const id1 = gateway.listPendingApprovals('s2').find((a) => a.status === 'pending')!.id;
    gateway.resolvePendingApproval(id1, { action: 'approve', scope: 'session' });
    await expect(p1).resolves.toMatchObject({ decision: 'approve_session', channel: 'gateway' });

    const p2 = gateway.requestApproval({
      sessionId: 's2',
      agentId: 'assistant',
      request: approvalRequest('http_request'),
    });
    const id2 = gateway.listPendingApprovals('s2').find((a) => a.status === 'pending')!.id;
    gateway.resolvePendingApproval(id2, { action: 'approve', scope: 'always' });
    await expect(p2).resolves.toMatchObject({ decision: 'approve_always' });
  });

  it('reject maps to deny and ignores scope', async () => {
    const pending = gateway.requestApproval({
      sessionId: 's3',
      agentId: 'assistant',
      request: approvalRequest(),
    });
    const id = gateway.listPendingApprovals('s3')[0]!.id;
    const resolved = gateway.resolvePendingApproval(id, {
      action: 'reject',
      scope: 'always',
    });
    expect(resolved?.status).toBe('rejected');
    expect(resolved?.decisionScope).toBeUndefined();
    await expect(pending).resolves.toMatchObject({ decision: 'deny' });
  });

  it('double resolve returns null the second time', () => {
    gateway.requestApproval({
      sessionId: 's4',
      agentId: 'assistant',
      request: approvalRequest(),
    });
    const id = gateway.listPendingApprovals('s4')[0]!.id;
    expect(gateway.resolvePendingApproval(id, { action: 'approve' })).not.toBeNull();
    expect(gateway.resolvePendingApproval(id, { action: 'approve' })).toBeNull();
    expect(gateway.resolvePendingApproval('nope', { action: 'approve' })).toBeNull();
  });

  it('cancelPendingApprovals denies waiter and marks cancelled', async () => {
    const pending = gateway.requestApproval({
      sessionId: 's5',
      agentId: 'assistant',
      request: approvalRequest(),
    });
    gateway.cancelPendingApprovals('s5');
    await expect(pending).resolves.toBe('deny');
    const a = gateway.listPendingApprovals('s5')[0]!;
    expect(a.status).toBe('rejected');
    expect(a.decisionReason).toBe('cancelled');
  });

  it('timeout denies waiter (fail-closed)', async () => {
    vi.useFakeTimers();
    try {
      const pending = gateway.requestApproval({
        sessionId: 's6',
        agentId: 'assistant',
        request: approvalRequest(),
        timeoutMs: 50,
      });
      vi.advanceTimersByTime(60);
      await expect(pending).resolves.toBe('deny');
      const a = gateway.listPendingApprovals('s6')[0]!;
      expect(a.status).toBe('rejected');
      expect(a.decisionReason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('listPendingApprovals filters by sessionId', async () => {
    gateway.requestApproval({
      sessionId: 'sa',
      agentId: 'assistant',
      request: approvalRequest('a'),
    });
    gateway.requestApproval({
      sessionId: 'sb',
      agentId: 'assistant',
      request: approvalRequest('b'),
    });
    expect(gateway.listPendingApprovals('sa')).toHaveLength(1);
    expect(gateway.listPendingApprovals('sa')[0]!.request.toolName).toBe('a');
    expect(gateway.listPendingApprovals('sb')).toHaveLength(1);
    expect(gateway.listPendingApprovals()).toHaveLength(2);
  });

  it('abortSession cancels pending approvals for that session only', async () => {
    const p1 = gateway.requestApproval({
      sessionId: 'sa',
      agentId: 'assistant',
      request: approvalRequest(),
    });
    const p2 = gateway.requestApproval({
      sessionId: 'sb',
      agentId: 'assistant',
      request: approvalRequest(),
    });
    gateway.abortSession('sa');
    await expect(p1).resolves.toBe('deny');
    // sb still pending
    expect(gateway.listPendingApprovals('sb')[0]!.status).toBe('pending');
    gateway.cancelPendingApprovals('sb');
    await expect(p2).resolves.toBe('deny');
  });
});
