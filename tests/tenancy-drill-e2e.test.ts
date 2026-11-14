/**
 * T5 多租户全流程演练（arch/multi-tenancy.md T5）——多租户 MVP 收官验收：
 * 双租户全流程走一遍：注册 → 建 agent → 家当物化 → 挂知识 → 渠道锚定+binding →
 * 委派闸+归属继承位 → 隔离矩阵总断言（agents/sessions/knowledge/audit 四面 A/B 互不可见）。
 *
 * 演练纪律（站站相扣的 scenario walk，文件内顺序执行、共享一份现场）：
 * - 真组件：HTTP registry 闸面（register / 可见性矩阵——隔离的真实执法点）、
 *   真 Gateway + JsonlSessionStore、真 RegistryService + registry-bridge（家当
 *   物化）、真委派栈（DelegateService/DelegationStore/InProcessTransport/
 *   createChildRunExecutor/RunnerChildRunPort）、真 AuditWriter。
 * - 仅两个假件：外部 LLM 服务（回显 system marker 断「谁真正跑了」）与委派站
 *   run 边界的脚本化 runner（真实 run 执行已有 delegation 系锚；本站钉租户闸
 *   与归属继承位，trade-off 留档：不重复跑真 LLM run）。
 * - 创建走 registry 服务面（与 HTTP 处理器同源的生产代码）；可见性断言走
 *   HTTP 闸面。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';

import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { defaultHitlCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type {
  ChannelAdapter,
  ChannelReply,
  ChannelMessage,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';
import type {
  AgentRecord,
  TenantId,
  UserId,
} from '@octopi-agent/engine/harness/governance/registry/types.js';
import {
  DelegateService,
  DefaultAgentRegistry,
  DelegationStore,
  InProcessTransport,
  createChildRunExecutor,
} from '@octopi-agent/engine/harness/collaboration/delegation/index.js';
import {
  RunnerChildRunPort,
  type ChildRunInput,
  type ChildRunOutput,
  type ChildRunPort,
} from '@octopi-agent/engine/harness/collaboration/delegation/child-run.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import { AuditWriter } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/audit/writer.js';
import type { SubsystemRun } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import { agentWorkspaceDir } from '@octopi-agent/engine/paths.js';
import { createRegistryAgentBridge } from '../src/registry-bridge.js';

// ── 假 LLM 外部服务（只 mock 外部服务）：回显 system prompt marker，断「谁真正跑了」 ──

let llmServer: Server;
let llmUrl: string;

beforeAll(async () => {
  llmServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      let reply = 'NO_SYSTEM';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
        const sys = parsed.messages?.find((m) => m.role === 'system')?.content;
        if (typeof sys === 'string') {
          reply = ['AGENT_A_SYS', 'AGENT_A2_SYS', 'AGENT_B_SYS', 'HOST_SYS'].find((m) => sys.includes(m)) ?? 'NO_SYSTEM';
        }
      } catch {
        // 请求体不可解析：按无 system 处理（假服务不添乱）
      }
      if (body.includes('"stream":true') || body.includes('"stream": true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c', object: 'chat.completion', created: 0, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
  const addr = llmServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('fake llm bind failed');
  llmUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => llmServer?.close(() => resolve()));
});

function rawConfig(): Record<string, unknown> {
  return {
    models: {
      providers: {
        mock: {
          baseUrl: llmUrl,
          apiKey: 'test-key',
          api: 'openai-completions',
          models: [{ id: 'm', name: 'm', contextWindow: 32000, maxTokens: 4096 }],
        },
      },
    },
  };
}

function definitionEntry(systemMarker: string): string {
  return JSON.stringify({
    model: 'mock/m',
    persona: { name: systemMarker, description: '', systemPrompt: systemMarker },
    tools: { allow: [] },
  });
}

class TestChannel implements ChannelAdapter {
  readonly sent: ChannelReply[] = [];
  constructor(readonly name: string) {}
  async start(): Promise<void> {}
  async send(reply: ChannelReply): Promise<void> {
    this.sent.push(reply);
  }
  async stop(): Promise<void> {}
}

function msg(channel: string, senderId: string, content: string, id: string, conversationId = 'c1'): ChannelMessage {
  return { id, channel, senderId, content, conversationId, timestamp: Date.now() };
}

// ── HTTP 闸面驱动（call 形态沿用 tests/tenancy-session-gate.test.ts） ──

interface CallResult {
  status: number;
  body: { ok: boolean; error?: string; data?: unknown } | null;
}

async function call(
  router: WebApiRouter,
  opts: { method: string; url: string; body?: unknown; token?: string },
): Promise<CallResult> {
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const headers: Record<string, string> = { host: 'localhost' };
  if (opts.token) headers['x-registry-token'] = opts.token;
  if (payload) headers['content-type'] = 'application/json';

  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as IncomingMessage;
  Object.assign(req, { method: opts.method, url: opts.url, headers });

  const chunks: Buffer[] = [];
  let status = 0;
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as unknown as ServerResponse;
  Object.assign(res, {
    writeHead(code: number) {
      status = code;
      return res;
    },
    setHeader() {},
    end(chunkOrCb?: unknown, encOrCb?: unknown, maybeCb?: unknown) {
      if (typeof chunkOrCb === 'string' || Buffer.isBuffer(chunkOrCb)) {
        chunks.push(Buffer.from(chunkOrCb as string));
      }
      const done =
        typeof chunkOrCb === 'function'
          ? chunkOrCb
          : typeof encOrCb === 'function'
            ? encOrCb
            : typeof maybeCb === 'function'
              ? maybeCb
              : undefined;
      (done as (() => void) | undefined)?.();
    },
  });

  await router.handle(req, res);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return { status, body: raw ? (JSON.parse(raw) as CallResult['body']) : null };
}

function names(res: CallResult): string[] {
  const data = res.body?.data as Array<{ name: string }>;
  return data.map((s) => s.name).sort();
}

// ── 委派站 run 边界替身（脚本化 runner；沿用 tests/harness/delegation-tools.test.ts 形态） ──

function makeFakeRunner(script: AgentEvent[]) {
  return {
    async *handle(
      _sessionId: string,
      _input: unknown,
      _runConfig: unknown,
      _signal?: AbortSignal,
    ): AsyncGenerator<AgentEvent> {
      for (const e of script) yield e;
    },
  };
}

const turnEnd = (content: string): AgentEvent =>
  ({ type: 'step.end', timestamp: Date.now(), agentId: 'a2', sessionId: 'cs', data: { content } }) as never;

// ── 现场（站站相扣：一站建的东西下一站用） ──

let root: string;
let homeDir: string;
let previousHome: string | undefined;
let gateway: Gateway;
let router: WebApiRouter;
let store: JsonlSessionStore;
let chanA: TestChannel;
let chanB: TestChannel;

let rootToken: string; // 首注册 = 平台 admin（Q13）
let aliceToken: string;
let bobToken: string;
let userAId: UserId;
let userBId: UserId;
let tA: TenantId;
let tB: TenantId;
let agentA: AgentRecord;
let agentA2: AgentRecord;
let agentB: AgentRecord;
let sessionKeyA: string;
let sessionKeyB: string;

describe('T5 双租户全流程演练（arch/multi-tenancy.md T5，站站相扣）', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'tenancy-drill-'));
    homeDir = join(root, 'home');
    mkdirSync(join(homeDir, 'sessions'), { recursive: true });
    previousHome = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = homeDir;
    defaultHitlCache.clear();

    store = new JsonlSessionStore({ sessionsDir: join(homeDir, 'sessions') });
    chanA = new TestChannel('chan-a');
    chanB = new TestChannel('chan-b');
    gateway = new Gateway(
      {
        agents: [
          {
            id: 'host-agent',
            home: join(root, 'host-agent'),
            workspace: join(root, 'host-ws'),
            persona: { name: 'host-agent', description: '', systemPrompt: 'HOST_SYS' },
            model: { provider: 'mock', model: 'm' },
            tools: { allow: [] },
          },
        ],
        knowledge: { service: { manageLocal: false } },
        modelProviders: {
          mock: {
            api: 'openai-completions',
            baseUrl: llmUrl,
            apiKey: 'test',
            models: [{ id: 'm', name: 'm', contextWindow: 32000, maxTokens: 4096 }],
          },
        },
      },
      store,
    );
    gateway.setRegistryAgentBridge(createRegistryAgentBridge({ getRawConfig: rawConfig, homeDir }));
    gateway.registerChannel(chanA);
    gateway.registerChannel(chanB);
    await gateway.start();
    router = new WebApiRouter({ gateway });
  });

  afterAll(async () => {
    await gateway.stop();
    if (previousHome === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('站1 注册域：root=平台 admin；alice/bob 各成一租户（HTTP register 面）', async () => {
    const regRoot = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'root' } });
    expect(regRoot.status).toBe(201);
    rootToken = (regRoot.body?.data as { token: string }).token;

    const regA = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    const regB = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'bob' } });
    const dA = regA.body?.data as { token: string; tenant: { tenantId: string }; user: { userId: string } };
    const dB = regB.body?.data as { token: string; tenant: { tenantId: string }; user: { userId: string } };
    aliceToken = dA.token;
    bobToken = dB.token;
    userAId = dA.user.userId as UserId;
    userBId = dB.user.userId as UserId;
    tA = dA.tenant.tenantId as TenantId;
    tB = dB.tenant.tenantId as TenantId;

    // 一用户一租户：两租户各自成域
    expect(tA).not.toBe(tB);
    // Q13：首注册 = 平台 admin，后续注册者不是
    const meRoot = await call(router, { method: 'GET', url: '/api/v1/registry/me', token: rootToken });
    expect((meRoot.body?.data as { user: { isPlatformAdmin?: boolean } }).user.isPlatformAdmin).toBe(true);
    const meA = await call(router, { method: 'GET', url: '/api/v1/registry/me', token: aliceToken });
    expect((meA.body?.data as { user: { isPlatformAdmin?: boolean } }).user.isPlatformAdmin).toBe(false);
  });

  it('站2 建 agent + 家当物化：workspace/<tenant>/<agent> 分域（bridge 宿主派生）', async () => {
    const registry = gateway.getRegistry()!;
    agentA = registry.createAgent({
      tenantId: tA,
      ownerUserId: userAId,
      name: 'agent-a',
      definition: definitionEntry('AGENT_A_SYS'),
    });
    agentA2 = registry.createAgent({
      tenantId: tA,
      ownerUserId: userAId,
      name: 'agent-a2',
      definition: definitionEntry('AGENT_A2_SYS'),
    });
    agentB = registry.createAgent({
      tenantId: tB,
      ownerUserId: userBId,
      name: 'agent-b',
      definition: definitionEntry('AGENT_B_SYS'),
    });

    expect(await gateway.attachRegistryAgent(agentA)).toBe(true);
    expect(await gateway.attachRegistryAgent(agentA2)).toBe(true);
    expect(await gateway.attachRegistryAgent(agentB)).toBe(true);

    // 家当物化分域（T2 口径）：workspace/<tenantId>/<agentId>，A/B 不同租户段
    const wsA = agentWorkspaceDir(homeDir, tA, agentA.agentId);
    const wsA2 = agentWorkspaceDir(homeDir, tA, agentA2.agentId);
    const wsB = agentWorkspaceDir(homeDir, tB, agentB.agentId);
    expect(existsSync(wsA)).toBe(true);
    expect(existsSync(wsA2)).toBe(true);
    expect(existsSync(wsB)).toBe(true);
    expect(wsA).toContain(join('workspace', tA));
    expect(wsB).toContain(join('workspace', tB));
    expect(wsA).not.toBe(wsB);
  });

  it('站3 挂知识：tenant 源 A/B + platform 公共，挂载解析按域收口', async () => {
    const registry = gateway.getRegistry()!;
    const srcA = registry.createKnowledgeSource({ scope: 'tenant', tenantId: tA, name: 'a-src' });
    const srcB = registry.createKnowledgeSource({ scope: 'tenant', tenantId: tB, name: 'b-src' });
    const srcP = registry.createKnowledgeSource({ scope: 'platform', name: 'pub' });
    registry.createMount({
      tenantId: tA,
      consumerType: 'agent',
      consumerId: agentA.agentId,
      sourceType: 'knowledge',
      sourceId: srcA.sourceId,
    });
    registry.createMount({
      tenantId: tA,
      consumerType: 'agent',
      consumerId: agentA.agentId,
      sourceType: 'knowledge',
      sourceId: srcP.sourceId,
    });
    registry.createMount({
      tenantId: tB,
      consumerType: 'agent',
      consumerId: agentB.agentId,
      sourceType: 'knowledge',
      sourceId: srcB.sourceId,
    });
    registry.createMount({
      tenantId: tB,
      consumerType: 'agent',
      consumerId: agentB.agentId,
      sourceType: 'knowledge',
      sourceId: srcP.sourceId,
    });

    // 挂载解析按域收口：A 只见 A 的挂载行，B 只见 B 的
    const mountsA = registry.listMounts({ tenantId: tA, consumerType: 'agent' });
    const mountsB = registry.listMounts({ tenantId: tB, consumerType: 'agent' });
    expect(mountsA).toHaveLength(2);
    expect(mountsA.every((m) => m.consumerId === agentA.agentId)).toBe(true);
    expect(mountsB).toHaveLength(2);
    expect(mountsB.every((m) => m.consumerId === agentB.agentId)).toBe(true);
  });

  it('站4 渠道锚定 + binding：两租户 bot 各路由到自己的 agent（真跑回显 marker）', async () => {
    const registry = gateway.getRegistry()!;
    // bot 凭证归属锚（Q11）：start 后补锚真实租户 id
    gateway.setChannelTenant('chan-a', tA);
    gateway.setChannelTenant('chan-b', tB);
    registry.createBinding({ tenantId: tA, platform: 'chan-a', identity: 'u1', agentId: agentA.agentId });
    registry.createBinding({ tenantId: tB, platform: 'chan-b', identity: 'u1', agentId: agentB.agentId });

    await gateway.send(msg('chan-a', 'u1', 'hi', 'm1'));
    await gateway.send(msg('chan-b', 'u1', 'hi', 'm2'));
    expect(chanA.sent.map((r) => r.content)).toEqual(['AGENT_A_SYS']);
    expect(chanB.sent.map((r) => r.content)).toEqual(['AGENT_B_SYS']);

    // 会话归属（§9.1-6）：渠道新建会话的 tenantId = bot 归属锚
    sessionKeyA = `${agentA.agentId}:chan-a:u1`;
    sessionKeyB = `${agentB.agentId}:chan-b:u1`;
    expect((await store.load(sessionKeyA))?.meta.tenantId).toBe(tA);
    expect((await store.load(sessionKeyB))?.meta.tenantId).toBe(tB);
  });

  it('站5 委派闸 + 归属继承位：A 内跑通且继承位随父租户落库；A↔B cross-tenant fail-loud', async () => {
    const delegRegistry = new DefaultAgentRegistry();
    for (const a of [
      { id: agentA.agentId, tenantId: tA },
      { id: agentA2.agentId, tenantId: tA },
      { id: agentB.agentId, tenantId: tB },
    ]) {
      delegRegistry.register({
        id: a.id,
        name: a.id,
        traits: [],
        status: 'idle',
        tenantId: a.tenantId,
        delegation: { callable: true, canDelegate: true, maxDepth: 1 },
      });
    }
    const delegStore = new DelegationStore(new DefaultEventBus());

    // run 边界脚本化（见文件头 trade-off）；子会话落真 JsonlSessionStore——
    // §8 归属继承位一路验到持久层
    const captured: { input?: ChildRunInput; output?: ChildRunOutput } = {};
    const innerPort = new RunnerChildRunPort({
      resolve: () => ({ runner: makeFakeRunner([turnEnd('a2-reply')]), store }),
    });
    const port: ChildRunPort = {
      async run(input, signal) {
        captured.input = input;
        captured.output = await innerPort.run(input, signal);
        return captured.output;
      },
    };
    const service = new DelegateService(
      delegStore,
      delegRegistry,
      new InProcessTransport(createChildRunExecutor(port, { persona: 'drill' })),
      {},
    );

    // A→A2：同租户跑通
    const result = await service.dispatch({
      parent: { agentId: agentA.agentId, sessionId: 's-a', runId: 'r-a', tenantId: tA },
      target: { agentId: agentA2.agentId },
      task: 'subtask',
      input: 'go',
    });
    expect(result.resolvedAgentId).toBe(agentA2.agentId);

    // dispatch 可能先返回 queued/running：轮询委派单终态，不赌执行时序
    const deadline = Date.now() + 2000;
    for (;;) {
      const [rec] = delegStore.list();
      if (rec && rec.status !== 'queued' && rec.status !== 'running') {
        expect(rec.status, `delegation record: ${JSON.stringify(rec)} | port: ${JSON.stringify({ input: captured.input, output: captured.output })}`).toBe('completed');
        break;
      }
      if (Date.now() > deadline) throw new Error('delegation did not settle');
      await new Promise((r) => setTimeout(r, 10));
    }

    // 继承位（§8）：子 run 归属 = 父 run 归属——执行位与持久层双证
    expect(captured.input?.tenantId).toBe(tA);
    const child = await store.load(captured.input!.childSessionId);
    expect(child?.meta.tenantId).toBe(tA);
    expect(child?.spawnBy?.parentAgentId).toBe(agentA.agentId);
    // 跑通：脚本产出经真执行器回流
    expect(captured.output?.output).toBe('a2-reply');

    // A→B / B→A：跨租户一律 delegate_cross_tenant fail-loud（对称）
    await expect(
      service.dispatch({
        parent: { agentId: agentA.agentId, sessionId: 's-a', runId: 'r-a2', tenantId: tA },
        target: { agentId: agentB.agentId },
        task: 'cross',
        input: 'go',
      }),
    ).rejects.toThrow(/cross-tenant/);
    await expect(
      service.dispatch({
        parent: { agentId: agentB.agentId, sessionId: 's-b', runId: 'r-b', tenantId: tB },
        target: { agentId: agentA.agentId },
        task: 'cross',
        input: 'go',
      }),
    ).rejects.toThrow(/cross-tenant/);
  });

  it('终站 隔离矩阵：agents/sessions/knowledge/audit 四面 A/B 互不可见', async () => {
    // ── agents 面（HTTP 闸）：各域只见本域 agent ──
    const agA = await call(router, { method: 'GET', url: '/api/v1/registry/agents', token: aliceToken });
    const agB = await call(router, { method: 'GET', url: '/api/v1/registry/agents', token: bobToken });
    expect(names(agA)).toEqual(['agent-a', 'agent-a2']);
    expect(names(agB)).toEqual(['agent-b']);

    // ── sessions 面（HTTP 闸）：越域 404 不泄露存在性 ──
    const sAA = await call(router, { method: 'GET', url: `/api/v1/sessions/${sessionKeyA}`, token: aliceToken });
    const sAB = await call(router, { method: 'GET', url: `/api/v1/sessions/${sessionKeyB}`, token: aliceToken });
    const sBB = await call(router, { method: 'GET', url: `/api/v1/sessions/${sessionKeyB}`, token: bobToken });
    const sBA = await call(router, { method: 'GET', url: `/api/v1/sessions/${sessionKeyA}`, token: bobToken });
    expect(sAA.status).toBe(200);
    expect(sAB.status).toBe(404);
    expect(sBB.status).toBe(200);
    expect(sBA.status).toBe(404);

    // ── knowledge 面（HTTP 闸）：platform 公共 ∪ 本域，跨域零可见 ──
    const kA = await call(router, { method: 'GET', url: '/api/v1/registry/knowledge-sources', token: aliceToken });
    const kB = await call(router, { method: 'GET', url: '/api/v1/registry/knowledge-sources', token: bobToken });
    const kR = await call(router, { method: 'GET', url: '/api/v1/registry/knowledge-sources', token: rootToken });
    expect(names(kA)).toEqual(['a-src', 'pub']);
    expect(names(kB)).toEqual(['b-src', 'pub']);
    expect(names(kR)).toEqual(['a-src', 'b-src', 'pub']); // admin 全量

    // ── audit 面（文件树）：两个台账各守各的契约，A/B 互不掺 ──
    // (a) SubsystemRun 审计：{auditDir}/{tenant}/[{agent}/]{subsystem}/{date}.jsonl，
    //     分区与记录同租户；
    // (b) ops 审计账本（ops.<agentId>.jsonl，hash 链，ops P2）：host-plane 治理台账，
    //     根级 per-agent 分文件、不落任何租户子树（两租户皆不可见即隔离）。
    //     已登记缺口（arch/multi-tenancy.md §9.1-13）：账本无租户键——P2-5 audit
    //     聚合 / ops P5 外送时补，聚合取证当前须经 agentId→租户反查。
    const auditDir = join(homeDir, 'audit');
    const ts = Date.now();
    const date = new Date(ts).toISOString().slice(0, 10);
    const runA: SubsystemRun = {
      id: 'drill-a',
      subsystemId: 'drill-sub',
      trigger: { source: 'drill', timestamp: ts },
      input: {},
      signals: [],
      acts: [],
      durationMs: 1,
      status: 'success',
      timestamp: ts,
      sessionKey: 'sk-a',
    };
    new AuditWriter({ auditDir, agentId: agentA.agentId, tenantId: tA }).write(runA);
    new AuditWriter({ auditDir, agentId: agentB.agentId, tenantId: tB }).write({ ...runA, id: 'drill-b', sessionKey: 'sk-b' });

    const fileA = join(auditDir, tA, agentA.agentId, 'drill-sub', `${date}.jsonl`);
    const fileB = join(auditDir, tB, agentB.agentId, 'drill-sub', `${date}.jsonl`);
    expect(existsSync(fileA)).toBe(true);
    expect(existsSync(fileB)).toBe(true);
    const rootEntries = readdirSync(auditDir).sort();
    // 租户段分区 = 两个租户；ops 台账在根（host-plane），不混入租户子树
    expect(rootEntries.filter((f) => !f.startsWith('ops.'))).toEqual([tA, tB].sort());
    expect(rootEntries.filter((f) => f.startsWith('ops.')).sort()).toEqual(
      [`ops.${agentA.agentId}.jsonl`, `ops.${agentB.agentId}.jsonl`].sort(),
    );
    // 记录代打租户与分区一致（MIN-3：分区≠记录会让按租户取证失去完整性）
    expect((JSON.parse(readFileSync(fileA, 'utf-8').trim()) as SubsystemRun).tenantId).toBe(tA);
    expect((JSON.parse(readFileSync(fileB, 'utf-8').trim()) as SubsystemRun).tenantId).toBe(tB);
    // 互不可见：A 域文件树零 B 痕迹，反之亦然
    expect(readFileSync(fileA, 'utf-8').includes(tB)).toBe(false);
    expect(readFileSync(fileB, 'utf-8').includes(tA)).toBe(false);
  });
});
