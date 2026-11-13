/**
 * T3a 收尾护栏（arch/multi-tenancy.md §6）：broker token 域下的写归属。
 *
 * gateway 的 Knowledge Service token 域 = platform（受信 broker）。读口需要
 * platform 的全量视图，但**写绝不能把用户资产落进 platform 共享面**——上一批
 * 遗漏的分叉点：upsertPrincipal/createProject 直接用 identity.tenantId，无 claim
 * 时会把 principal/project 写进 platform 域，与存量 default 域数据分叉。
 *
 * 收口在鉴权边界 http-app#authenticate：platform 域 + 无显式 claim → 写域降级
 * DEFAULT；显式 claim 则按 claim 写（platform 公共库仍可显式建立）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerResponse } from 'node:http';
import { PLATFORM_TENANT_ID, DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { LocalKnowledgeWriteService } from '@octopi-agent/engine/harness/knowledge/writer-service.js';
import { LocalKnowledgeQueryService } from '@octopi-agent/engine/harness/knowledge/query-service.js';
import { createKnowledgeHttpApp } from '@octopi-agent/engine/harness/knowledge/http-app.js';

const BROKER_TOKEN = 'broker-token';
const TENANT_TOKEN = 'tenant-a-token';

describe('knowledge 写归属护栏（broker token）', () => {
  let dir: string;
  let db: KnowledgeDatabase;
  let app: ReturnType<typeof createKnowledgeHttpApp>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kn-write-domain-'));
    db = await KnowledgeDatabase.create({ dbPath: join(dir, 'knowledge.db') });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const retriever = new KnowledgeRetriever({ sourceStore: sources, indexStore: index });
    const write = new LocalKnowledgeWriteService({ db });
    const query = new LocalKnowledgeQueryService({ db, sources, index, retriever, embeddingEnabled: false });
    app = createKnowledgeHttpApp({
      write,
      query,
      tokens: [
        { token: BROKER_TOKEN, tenantId: PLATFORM_TENANT_ID, gatewayId: 'gw' },
        { token: TENANT_TOKEN, tenantId: 't-a', gatewayId: 'gw' },
      ],
      autoRegisterPrincipals: true,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 发请求；body 是写进 res 的，故读收集到的状态码 */
  async function call(
    method: string,
    path: string,
    token: string,
    opts: { body?: unknown; claim?: string } = {},
  ): Promise<{ status: number }> {
    const chunks: string[] = [];
    let status = 0;
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(this: unknown) {
        return res;
      },
      writeHead: (_code: number) => {
        status = _code;
        return res;
      },
      end: (buf?: unknown) => {
        if (buf) chunks.push(String(buf));
        if (!status) status = res.statusCode;
        return res;
      },
    } as unknown as ServerResponse;

    const req = {
      method,
      url: path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.claim ? { 'x-octopi-tenant': opts.claim } : {}),
      },
      async *[Symbol.asyncIterator]() {
        if (opts.body !== undefined) yield Buffer.from(JSON.stringify(opts.body));
      },
    } as unknown as Parameters<typeof app.handle>[0];

    await app.handle(req, res);
    return { status };
  }

  /** 直读执法列（域归属的唯一真相） */
  function rowTenant(table: string, key: string, value: string): string {
    const row = db.raw
      .prepare(`SELECT tenant_id FROM ${table} WHERE ${key} = ?`)
      .get(value) as { tenant_id?: string } | undefined;
    return row?.tenant_id ?? '<absent>';
  }

  it('broker token 无 claim：principal 写进 DEFAULT 域（不进 platform 共享面）', async () => {
    const r = await call('PUT', '/v1/principals/agent-x', BROKER_TOKEN);
    expect(r.status).toBe(200);
    expect(rowTenant('knowledge_principals', 'local_agent_id', 'agent-x')).toBe(DEFAULT_TENANT_ID);
  });

  it('broker token + 显式 claim：principal 写进 claim 域', async () => {
    const r = await call('PUT', '/v1/principals/agent-y', BROKER_TOKEN, { claim: 't-a' });
    expect(r.status).toBe(200);
    expect(rowTenant('knowledge_principals', 'local_agent_id', 'agent-y')).toBe('t-a');
  });

  it('broker token + 显式 claim platform：公共库仍可显式建立', async () => {
    const r = await call('POST', '/v1/projects', BROKER_TOKEN, {
      claim: PLATFORM_TENANT_ID,
      body: { projectKey: 'public-lib', displayName: '公共库' },
    });
    expect(r.status).toBe(201);
    expect(rowTenant('knowledge_projects', 'project_key', 'public-lib')).toBe(PLATFORM_TENANT_ID);
  });

  it('broker token 无 claim 建 project：落 DEFAULT 域（不分叉）', async () => {
    const r = await call('POST', '/v1/projects', BROKER_TOKEN, { body: { projectKey: 'p-local' } });
    expect(r.status).toBe(201);
    expect(rowTenant('knowledge_projects', 'project_key', 'p-local')).toBe(DEFAULT_TENANT_ID);
  });

  it('租户 token：写进本域（存量语义不变）', async () => {
    const r = await call('PUT', '/v1/principals/agent-z', TENANT_TOKEN);
    expect(r.status).toBe(200);
    expect(rowTenant('knowledge_principals', 'local_agent_id', 'agent-z')).toBe('t-a');
  });

  it('租户 token 越域断言：按未认证拒（不写入任何域）', async () => {
    const r = await call('PUT', '/v1/principals/agent-w', TENANT_TOKEN, { claim: 't-b' });
    expect(r.status).toBe(401);
    expect(rowTenant('knowledge_principals', 'local_agent_id', 'agent-w')).toBe('<absent>');
  });
});
