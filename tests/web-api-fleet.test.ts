/**
 * /api/v1/fleet/* 运维端点（MAJ-4：ops 原语的产品面入口）。
 * 薄壳验证：路由/校验/透传——ops 行为语义在 supervise-probe/drills 面。
 */

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { WebApiRouter } from '../packages/gateway/src/web/api/router.js';

function makeReq(method: string, path: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = { host: 'localhost' };
  return req;
}

function makeRes(): { res: ServerResponse; done: Promise<{ code: number; body: Record<string, unknown> }> } {
  let resolve: (v: { code: number; body: Record<string, unknown> }) => void = () => undefined;
  const done = new Promise<{ code: number; body: Record<string, unknown> }>((r) => {
    resolve = r;
  });
  const chunks: string[] = [];
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    writeHead: (status: number) => {
      (res as { statusCode: number }).statusCode = status;
      return res;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
      resolve({ code: (res as { statusCode: number }).statusCode, body: JSON.parse(chunks.join('')) as Record<string, unknown> });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function makeGateway() {
  return {
    fleetStatus: vi.fn(() => ({
      instances: [{ instanceId: 'run-0', version: 'self', state: 'ready' }],
      route: { versionPointer: 'self', replicasPerVersion: 1 },
    })),
    fleetSpawn: vi.fn(async () => ({ ready: [], failed: [] })),
    fleetPromote: vi.fn(),
    fleetRollback: vi.fn(async () => ({ ready: [], failed: [] })),
    fleetDrain: vi.fn(async () => undefined),
  };
}

describe('WebApiRouter /fleet ops surface (MAJ-4)', () => {
  it('GET /fleet returns status', async () => {
    const gw = makeGateway();
    const router = new WebApiRouter({ gateway: gw as never });
    const { res, done } = makeRes();
    await router.handle(makeReq('GET', '/api/v1/fleet'), res);
    const out = await done;
    expect(out.code).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(gw.fleetStatus).toHaveBeenCalled();
  });

  it('POST /fleet/spawn validates and delegates', async () => {
    const gw = makeGateway();
    const router = new WebApiRouter({ gateway: gw as never });

    const bad = makeRes();
    await router.handle(makeReq('POST', '/api/v1/fleet/spawn', { version: 'v1' }), bad.res);
    expect((await bad.done).code).toBe(400);

    const badN = makeRes();
    await router.handle(makeReq('POST', '/api/v1/fleet/spawn', { version: 'v1', buildRef: '/r', n: 0 }), badN.res);
    expect((await badN.done).code).toBe(400);

    const ok = makeRes();
    await router.handle(makeReq('POST', '/api/v1/fleet/spawn', { version: 'v1', buildRef: '/r', n: 2 }), ok.res);
    expect((await ok.done).code).toBe(200);
    expect(gw.fleetSpawn).toHaveBeenCalledWith('v1', '/r', 2);
  });

  it('POST /fleet/promote delegates and returns status', async () => {
    const gw = makeGateway();
    const router = new WebApiRouter({ gateway: gw as never });
    const { res, done } = makeRes();
    await router.handle(makeReq('POST', '/api/v1/fleet/promote', { version: 'v2' }), res);
    const out = await done;
    expect(out.code).toBe(200);
    expect(gw.fleetPromote).toHaveBeenCalledWith('v2');
  });

  it('POST /fleet/rollback delegates; /fleet/drain delegates', async () => {
    const gw = makeGateway();
    const router = new WebApiRouter({ gateway: gw as never });

    const rb = makeRes();
    await router.handle(makeReq('POST', '/api/v1/fleet/rollback', { version: 'v1', buildRef: '/r' }), rb.res);
    expect((await rb.done).code).toBe(200);
    expect(gw.fleetRollback).toHaveBeenCalledWith('v1', '/r', undefined);

    const bad = makeRes();
    await router.handle(makeReq('POST', '/api/v1/fleet/drain', {}), bad.res);
    expect((await bad.done).code).toBe(400);

    const dr = makeRes();
    await router.handle(makeReq('POST', '/api/v1/fleet/drain', { instanceId: 'run-0' }), dr.res);
    expect((await dr.done).code).toBe(200);
    expect(gw.fleetDrain).toHaveBeenCalledWith('run-0');
  });
});
