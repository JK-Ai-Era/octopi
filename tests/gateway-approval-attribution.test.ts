/**
 * B-1 — 审批归因诚实化：无认证部署固定记 `unauthenticated`，不再收客户端自报
 * （可仿冒的署名 = 审计撒谎；认证部署归因 = 持钥方，不受 body 影响）。
 */
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';

interface Captured {
  approver?: unknown;
}

function makeRouter(opts: { approverIdentity?: string; captured: Captured }) {
  const gatewayStub = {
    resolvePendingApproval: vi.fn((id: string, input: Record<string, unknown>) => {
      opts.captured.approver = input.approver;
      return { ok: true, approval: { id, status: 'approved' } };
    }),
    listPendingApprovals: vi.fn(() => []),
  };
  return new WebApiRouter({
    gateway: gatewayStub as unknown as Gateway,
    configApply: {} as never,
    approverIdentity: opts.approverIdentity,
  });
}

async function post(router: WebApiRouter, url: string, body: unknown): Promise<void> {
  const req = Object.assign(Readable.from([JSON.stringify(body)]), {
    url,
    method: 'POST',
    headers: { host: 'localhost' },
  }) as unknown as IncomingMessage;
  const res = {
    writeHead() {
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  await router.handle(req, res);
}

describe('审批归因（B-1c）', () => {
  it('无 approverIdentity：body 自报 alice 不被采信，固定记 unauthenticated', async () => {
    const captured: Captured = {};
    await post(makeRouter({ captured }), '/api/v1/approvals/a1', {
      action: 'approve',
      approver: 'alice',
    });
    expect(captured.approver).toBe('unauthenticated');
  });

  it('apiKey 部署：归因 = 持钥方 owner（不受 body 影响）', async () => {
    const captured: Captured = {};
    await post(makeRouter({ captured, approverIdentity: 'owner' }), '/api/v1/approvals/a1', {
      action: 'approve',
      approver: 'alice',
    });
    expect(captured.approver).toBe('owner');
  });
});
