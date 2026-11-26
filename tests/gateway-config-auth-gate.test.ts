/**
 * console 无认证部署下的提权闸（A2，大哥 2026-10-31 拍板）：
 *
 * console API 无法区分调用者是人还是 agent。无 apiKey 部署下，非 host agent（project
 * network=open）可匿名调 `/config/agents` 把自己升到 host 提权。**只拦真正提权**：
 * 无 console key 时，写入 mode=host（全权）或自扩文件系统作用域
 * （effectPolicy.transactionRoots / workspace —— 允许根即读写面）才 503；
 * workspace/project/untrusted 互改（不含根变化）、默认值、tools 编辑放行
 * （否则无 key 部署连默认 workspace 新建都被拦）。配 apiKey 后全放行。
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';

interface CallResult {
  handled: boolean;
  status: number;
  body: { ok: boolean; error?: string } | null;
}

async function call(
  router: WebApiRouter,
  method: 'POST' | 'PUT',
  url: string,
  body: unknown,
): Promise<CallResult> {
  const req = Object.assign(Readable.from([JSON.stringify(body)]), {
    url,
    method,
    headers: { host: 'localhost' },
  }) as unknown as IncomingMessage;
  let status = 0;
  let payload: CallResult['body'] = null;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    setHeader() {
      return this;
    },
    end(text?: string) {
      payload = text ? JSON.parse(text) : null;
      return this;
    },
  } as unknown as ServerResponse;
  const handled = await router.handle(req, res);
  return { handled, status, body: payload };
}

function makeRouter(opts: { approverIdentity?: string; globalMode?: string }) {
  const gatewayStub = {
    getEffectPolicyStatus: () => ({ configuredMode: opts.globalMode }),
  };
  const applyStub = {
    createAgent: vi.fn(async () => ({ hash: 'h', applied: 'next-run', affectedAgents: [] })),
    updateAgent: vi.fn(async () => ({ hash: 'h', applied: 'next-run', affectedAgents: [] })),
  };
  const router = new WebApiRouter({
    gateway: gatewayStub as unknown as Gateway,
    configApply: applyStub as never,
    approverIdentity: opts.approverIdentity,
  });
  return { router, applyStub };
}

describe('console 无认证部署提权闸（判据 = 写入后生效模式）', () => {
  it('无认证 + POST 升到 mode=host → 503，createAgent 不被调', async () => {
    const { router, applyStub } = makeRouter({});
    const r = await call(router, 'POST', '/api/v1/config/agents', {
      agent: { id: 'x', model: 'standard', effectPolicy: { mode: 'host' } },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(r.body?.error).toMatch(/security_config_unauthenticated/);
    expect(applyStub.createAgent).not.toHaveBeenCalled();
  });

  it('无认证 + PUT 升到 mode=host → 503，updateAgent 不被调', async () => {
    const { router, applyStub } = makeRouter({});
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', effectPolicy: { mode: 'host' } },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(applyStub.updateAgent).not.toHaveBeenCalled();
  });

  it('无认证 + 默认 workspace → 放行（WebUI 新建总带 effectPolicy，不得拦默认值）', async () => {
    const { router, applyStub } = makeRouter({});
    const r = await call(router, 'POST', '/api/v1/config/agents', {
      agent: { id: 'x', model: 'standard', effectPolicy: { mode: 'workspace' } },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.createAgent).toHaveBeenCalledTimes(1);
  });

  it('无认证 + project（非全权）→ 放行', async () => {
    const { router, applyStub } = makeRouter({});
    const r = await call(router, 'POST', '/api/v1/config/agents', {
      agent: { id: 'x', model: 'standard', effectPolicy: { mode: 'project' } },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.createAgent).toHaveBeenCalledTimes(1);
  });

  it('无认证 + tools 编辑 → 放行（tools 非全权面，A2）', async () => {
    const { router, applyStub } = makeRouter({});
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', tools: { allow: ['shell'] } },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.updateAgent).toHaveBeenCalledTimes(1);
  });

  it('认证部署（approverIdentity）+ mode=host → 放行（署名通道 = 宿主管理身份）', async () => {
    const { router, applyStub } = makeRouter({ approverIdentity: 'owner' });
    const r = await call(router, 'POST', '/api/v1/config/agents', {
      agent: { id: 'x', model: 'standard', effectPolicy: { mode: 'host' } },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.createAgent).toHaveBeenCalledTimes(1);
  });

  it('无认证 + 自扩作用域（effectPolicy.transactionRoots）→ 503（允许根 = 读写面）', async () => {
    const { router, applyStub } = makeRouter({});
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', effectPolicy: { transactionRoots: ['~/.octopi'] } },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(r.body?.error).toMatch(/security_config_unauthenticated/);
    expect(applyStub.updateAgent).not.toHaveBeenCalled();
  });

  it('无认证 + 自扩作用域（workspace）→ 503', async () => {
    const { router, applyStub } = makeRouter({});
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', workspace: '~/.octopi' },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(applyStub.updateAgent).not.toHaveBeenCalled();
  });

  it('认证部署 + transactionRoots → 放行（署名通道可改作用域）', async () => {
    const { router, applyStub } = makeRouter({ approverIdentity: 'owner' });
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', effectPolicy: { transactionRoots: ['/proj/a'] } },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.updateAgent).toHaveBeenCalledTimes(1);
  });

  it('无认证 + 删 mode 键（mode:null）且全局缺省 host → 503（回落全权同罪）', async () => {
    const { router, applyStub } = makeRouter({ globalMode: 'host' });
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', effectPolicy: { mode: null } },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(r.body?.error).toMatch(/security_config_unauthenticated/);
    expect(applyStub.updateAgent).not.toHaveBeenCalled();
  });

  it('无认证 + effectPolicy:null 且全局缺省 host → 503（删整段回落全权同罪）', async () => {
    const { router, applyStub } = makeRouter({ globalMode: 'host' });
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', effectPolicy: null },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(applyStub.updateAgent).not.toHaveBeenCalled();
  });

  it('无认证 + 删 mode 键但全局缺省非 host → 放行（回落 workspace 不是提权）', async () => {
    const { router, applyStub } = makeRouter({ globalMode: 'workspace' });
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', effectPolicy: { mode: null } },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.updateAgent).toHaveBeenCalledTimes(1);
  });

  it('F-2 主锚：create 不带 effectPolicy + 全局 host → 503（缺省即造出 host agent）', async () => {
    const { router, applyStub } = makeRouter({ globalMode: 'host' });
    const r = await call(router, 'POST', '/api/v1/config/agents', {
      agent: { id: 'evil', model: 'standard' },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(r.body?.error).toMatch(/security_config_unauthenticated/);
    expect(r.body?.error).toMatch(/global host default/);
    expect(applyStub.createAgent).not.toHaveBeenCalled();
  });

  it('F-2：create 只写子键不写 mode + 全局 host → 503（同一缺口的另一拼法）', async () => {
    const { router, applyStub } = makeRouter({ globalMode: 'host' });
    const r = await call(router, 'POST', '/api/v1/config/agents', {
      agent: { id: 'evil', model: 'standard', effectPolicy: { shellEscape: 'allow' } },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(applyStub.createAgent).not.toHaveBeenCalled();
  });

  it('F-2：create 带 mode:workspace + 全局 host → 放行（显式沙箱 = 降权）', async () => {
    const { router, applyStub } = makeRouter({ globalMode: 'host' });
    const r = await call(router, 'POST', '/api/v1/config/agents', {
      agent: { id: 'x', model: 'standard', effectPolicy: { mode: 'workspace' } },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.createAgent).toHaveBeenCalledTimes(1);
  });

  it('F-2：create 不带 effectPolicy + 全局 workspace → 放行（缺省不是提权）', async () => {
    const { router, applyStub } = makeRouter({ globalMode: 'workspace' });
    const r = await call(router, 'POST', '/api/v1/config/agents', {
      agent: { id: 'x', model: 'standard' },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.createAgent).toHaveBeenCalledTimes(1);
  });

  it('F-3：update 删 pathDenylist（null）→ 503（拒绝清单是读写面补集）', async () => {
    const { router, applyStub } = makeRouter({});
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', effectPolicy: { pathDenylist: null } },
      hash: 'h',
    });
    expect(r.status).toBe(503);
    expect(r.body?.error).toMatch(/security_config_unauthenticated/);
    expect(applyStub.updateAgent).not.toHaveBeenCalled();
  });

  it('F-3：update 写 pathDenylist / refuseFinalSymlink → 503（方向不可静态判定）', async () => {
    for (const patch of [{ pathDenylist: ['**/.env'] }, { refuseFinalSymlink: false }, { refuseFinalSymlink: null }]) {
      const { router, applyStub } = makeRouter({});
      const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
        agent: { id: 'x', effectPolicy: patch },
        hash: 'h',
      });
      expect(r.status).toBe(503);
      expect(applyStub.updateAgent).not.toHaveBeenCalled();
    }
  });

  it('F-3：认证部署 + pathDenylist 变更 → 放行（署名通道可改读写面）', async () => {
    const { router, applyStub } = makeRouter({ approverIdentity: 'owner' });
    const r = await call(router, 'PUT', '/api/v1/config/agents/x', {
      agent: { id: 'x', effectPolicy: { pathDenylist: ['**/.env'] } },
      hash: 'h',
    });
    expect(r.status).toBe(200);
    expect(applyStub.updateAgent).toHaveBeenCalledTimes(1);
  });
});
