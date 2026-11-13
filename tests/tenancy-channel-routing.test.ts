/**
 * T4a 渠道锚定判据（arch/multi-tenancy.md §9 / §10）：
 * 两租户各自 bot 各路由到自己的 agent。
 *
 * 全链：bot 凭证归属锚（channels[].tenantId → registerChannel）→
 * bindings 表路由（§2.3 ②，路由真相源）→ sessionPolicy 会话键（③）→
 * 未绑定兜底策略（fallback / reject）。
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { defaultHitlCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type { ChannelAdapter, ChannelReply, ChannelMessage } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';
import type { AgentRecord, TenantId, UserId } from '@octopi-agent/engine/harness/governance/registry/types.js';
import { createRegistryAgentBridge } from '../src/registry-bridge.js';

// 假 LLM 外部服务（只 mock 外部服务）：回复回显 system prompt 标记——
// 断言「哪个 agent 真正跑了」
let llmServer: Server;
let llmUrl: string;

beforeAll(async () => {
  llmServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      // 从 system prompt 提取归属 marker：断言「哪个 agent 真正跑了」。
      // system prompt 是组装产物，只能 contains 匹配，不能整段相等
      let reply = 'NO_SYSTEM';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
        const sys = parsed.messages?.find((m) => m.role === 'system')?.content;
        if (typeof sys === 'string') {
          reply = ['AGENT_A_SYS', 'AGENT_B_SYS', 'HOST_SYS', 'ORPHAN_SYS'].find((m) => sys.includes(m)) ?? 'NO_SYSTEM';
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

interface Harness {
  gateway: Gateway;
  store: JsonlSessionStore;
  chanA: TestChannel;
  chanB: TestChannel;
  tA: TenantId;
  tB: TenantId;
  agentA: AgentRecord;
  agentB: AgentRecord;
}

describe('T4a 判据：两租户各自 bot 各路由到自己的 agent', () => {
  let root: string;
  let previousHome: string | undefined;
  const gateways: Gateway[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tenancy-channel-routing-'));
    previousHome = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = join(root, 'home');
    defaultHitlCache.clear();
  });

  afterEach(async () => {
    for (const gateway of gateways.splice(0)) await gateway.stop();
    if (previousHome === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  async function makeHarness(opts?: { unboundPolicy?: 'fallback' | 'reject'; noHostAgent?: boolean }): Promise<Harness> {
    mkdirSync(join(root, 'home', 'sessions'), { recursive: true });
    const store = new JsonlSessionStore({ sessionsDir: join(root, 'home', 'sessions') });
    const chanA = new TestChannel('chan-a');
    const chanB = new TestChannel('chan-b');
    const gateway = new Gateway(
      {
        agents: opts?.noHostAgent
          ? []
          : [
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
        ...(opts?.unboundPolicy ? { tenancy: { unboundChannelPolicy: opts.unboundPolicy } } : {}),
      },
      store,
    );
    gateways.push(gateway);
    gateway.setRegistryAgentBridge(createRegistryAgentBridge({ getRawConfig: rawConfig, homeDir: join(root, 'home') }));
    // bot 凭证归属锚（Q11=a）：真实租户 id 在 start() 后的 registry 里——
    // 先按缺省注册，start() 后 setChannelTenant 补锚
    gateway.registerChannel(chanA);
    gateway.registerChannel(chanB);
    await gateway.start();

    const registry = gateway.getRegistry()!;
    const uA = registry.registerUser({ name: 'alice' });
    const uB = registry.registerUser({ name: 'bob' });
    const tA = uA.tenant.tenantId;
    const tB = uB.tenant.tenantId;
    const agentA = registry.createAgent({
      tenantId: tA,
      ownerUserId: uA.user.userId as UserId,
      name: 'agent-a',
      definition: definitionEntry('AGENT_A_SYS'),
    });
    const agentB = registry.createAgent({
      tenantId: tB,
      ownerUserId: uB.user.userId as UserId,
      name: 'agent-b',
      definition: definitionEntry('AGENT_B_SYS'),
    });
    expect(await gateway.attachRegistryAgent(agentA)).toBe(true);
    expect(await gateway.attachRegistryAgent(agentB)).toBe(true);
    // start 后补锚（registerChannel 缺省=DEFAULT；锚定租户真实 id 后重设）
    gateway.setChannelTenant('chan-a', tA);
    gateway.setChannelTenant('chan-b', tB);
    return { gateway, store, chanA, chanB, tA, tB, agentA, agentB };
  }

  function msg(channel: string, senderId: string, content: string, id: string, conversationId = 'c1'): ChannelMessage {
    return { id, channel, senderId, content, conversationId, timestamp: Date.now() };
  }

  it('binding 命中：各租户 bot 各路由到自己的 agent（判据主锚）', async () => {
    const h = await makeHarness();
    const registry = h.gateway.getRegistry()!;
    registry.createBinding({ tenantId: h.tA, platform: 'chan-a', identity: 'u1', agentId: h.agentA.agentId });
    registry.createBinding({ tenantId: h.tB, platform: 'chan-b', identity: 'u1', agentId: h.agentB.agentId });

    await h.gateway.send(msg('chan-a', 'u1', 'hi', 'm1'));
    await h.gateway.send(msg('chan-b', 'u1', 'hi', 'm2'));

    expect(h.chanA.sent.map((r) => r.content)).toEqual(['AGENT_A_SYS']);
    expect(h.chanB.sent.map((r) => r.content)).toEqual(['AGENT_B_SYS']);
    // 会话键 = agentId:channel:sender（per-user 常驻；agentId=registry UUID）
    expect(await h.store.load(`${h.agentA.agentId}:chan-a:u1`)).not.toBeNull();
    expect(await h.store.load(`${h.agentB.agentId}:chan-b:u1`)).not.toBeNull();
  });

  it('bot 归属锚定租户：同一发送者在不同 bot 上解析到各自租户的绑定（不串域）', async () => {
    const h = await makeHarness();
    const registry = h.gateway.getRegistry()!;
    // u1 在两个租户各有一条同名绑定——路由由 bot 归属定域，各查各的（不串域）
    registry.createBinding({ tenantId: h.tA, platform: 'chan-a', identity: 'u1', agentId: h.agentA.agentId });
    registry.createBinding({ tenantId: h.tB, platform: 'chan-a', identity: 'u1', agentId: h.agentB.agentId });

    await h.gateway.send(msg('chan-a', 'u1', 'hi', 'm1'));
    expect(h.chanA.sent.map((r) => r.content)).toEqual(['AGENT_A_SYS']);
  });

  it('sessionPolicy=per-chat：会话按 conversation 聚合；per-message：每消息新会话', async () => {
    const h = await makeHarness();
    const registry = h.gateway.getRegistry()!;
    registry.createBinding({
      tenantId: h.tB,
      platform: 'chan-b',
      identity: 'chatter',
      agentId: h.agentB.agentId,
      sessionPolicy: 'per-chat',
    });
    registry.createBinding({
      tenantId: h.tA,
      platform: 'chan-a',
      identity: 'oneshot',
      agentId: h.agentA.agentId,
      sessionPolicy: 'per-message',
    });

    await h.gateway.send(msg('chan-b', 'chatter', 'a', 'm1', 'room-1'));
    await h.gateway.send(msg('chan-b', 'chatter', 'b', 'm2', 'room-1'));
    expect(await h.store.load(`${h.agentB.agentId}:chan-b:room-1`)).not.toBeNull();

    await h.gateway.send(msg('chan-a', 'oneshot', 'a', 'm3'));
    await h.gateway.send(msg('chan-a', 'oneshot', 'b', 'm4'));
    expect(await h.store.load(`${h.agentA.agentId}:chan-a:oneshot:m3`)).not.toBeNull();
    expect(await h.store.load(`${h.agentA.agentId}:chan-a:oneshot:m4`)).not.toBeNull();
  });

  it('未绑定流量 fallback（缺省）：落 DEFAULT 域宿主 agent 兜底，不落他租户 agent（MAJ-3）', async () => {
    const h = await makeHarness();
    await h.gateway.send(msg('chan-a', 'stranger', 'hi', 'm1'));
    // 兜底候选限 DEFAULT 域：命中 host-agent（config 宿主资产），绝不落 agentA/agentB
    expect(h.chanA.sent.map((r) => r.content)).toEqual(['HOST_SYS']);
    const keys = await h.store.list();
    expect(keys.every((k) => !k.id.includes(h.agentA.agentId) && !k.id.includes(h.agentB.agentId))).toBe(true);
  });

  it('无宿主 agent 时未绑定流量不落他租户 agent：明示弃收（MAJ-3 嵌入形态）', async () => {
    const h = await makeHarness({ noHostAgent: true });
    await h.gateway.send(msg('chan-a', 'stranger', 'hi', 'm1'));
    expect(h.chanA.sent).toEqual([]);
    expect(await h.store.list()).toEqual([]);
  });

  it('未绑定流量 reject（可配）：拒收不进任何 agent、不建会话', async () => {
    const h = await makeHarness({ unboundPolicy: 'reject' });
    const registry = h.gateway.getRegistry()!;
    registry.createBinding({ tenantId: h.tA, platform: 'chan-a', identity: 'u1', agentId: h.agentA.agentId });

    await h.gateway.send(msg('chan-a', 'u1', 'hi', 'm1'));
    await h.gateway.send(msg('chan-a', 'stranger', 'hi', 'm2'));

    expect(h.chanA.sent.map((r) => r.content)).toEqual(['AGENT_A_SYS']);
    expect(await h.store.load(`${h.agentA.agentId}:chan-a:u1`)).not.toBeNull();
    // stranger 被拒：没有会话、没有回复（日志明示，不静默）
    const keys = await h.store.list();
    expect(keys.map((k) => k.id)).toEqual([`${h.agentA.agentId}:chan-a:u1`]);
  });

  it('显式寻址跨租户：锚定 bot 上指向他租户 agent 一律拒（§7 参与边界）', async () => {
    const h = await makeHarness({ unboundPolicy: 'reject' });
    await h.gateway.send({
      ...msg('chan-a', 'u1', 'hi', 'm1'),
      metadata: { agentId: h.agentB.agentId },
    });
    expect(h.chanA.sent).toEqual([]);
    expect(await h.store.list()).toEqual([]);

    // 同租户显式寻址照常放行（WebUI 侧栏语义）；无 binding 命中 → dmScope main 键
    await h.gateway.send({
      ...msg('chan-a', 'u1', 'hi', 'm2'),
      metadata: { agentId: h.agentA.agentId },
    });
    expect(h.chanA.sent.map((r) => r.content)).toEqual(['AGENT_A_SYS']);
    expect(await h.store.load(`${h.agentA.agentId}:main`)).not.toBeNull();
  });

  it('显式 id 未命中 fall-through 到绑定：会话键以解析结果为准（不嵌陈旧 id）', async () => {
    const h = await makeHarness();
    const registry = h.gateway.getRegistry()!;
    registry.createBinding({ tenantId: h.tA, platform: 'chan-a', identity: 'u1', agentId: h.agentA.agentId });

    await h.gateway.send({
      ...msg('chan-a', 'u1', 'hi', 'm1'),
      metadata: { agentId: 'dead-agent-id' },
    });
    expect(h.chanA.sent.map((r) => r.content)).toEqual(['AGENT_A_SYS']);
    expect(await h.store.load(`${h.agentA.agentId}:chan-a:u1`)).not.toBeNull();
  });

  it('绑定指向未挂载 agent：配置漂移即弃收，不落兜底（MIN-1，与 unboundPolicy 无关）', async () => {
    const h = await makeHarness(); // 缺省 fallback 策略——照样弃收
    const registry = h.gateway.getRegistry()!;
    const orphan = registry.createAgent({
      tenantId: h.tA,
      ownerUserId: h.agentA.ownerUserId,
      name: 'agent-orphan',
      definition: definitionEntry('ORPHAN_SYS'),
    });
    // 绑定合法（registry 里有定义），但运行时未挂载（attach 未做）——不得降级未绑定落兜底
    registry.createBinding({ tenantId: h.tA, platform: 'chan-a', identity: 'u9', agentId: orphan.agentId });

    await h.gateway.send(msg('chan-a', 'u9', 'hi', 'm1'));
    expect(h.chanA.sent).toEqual([]);
    expect(await h.store.list()).toEqual([]);
  });

  it('binding 策略优先于客户端 sessionId：客户端自报 id 不架空键控契约（MAJ-2-A）', async () => {
    const h = await makeHarness();
    const registry = h.gateway.getRegistry()!;
    registry.createBinding({
      tenantId: h.tA,
      platform: 'chan-a',
      identity: 'oneshot',
      agentId: h.agentA.agentId,
      sessionPolicy: 'per-message',
    });

    await h.gateway.send({ ...msg('chan-a', 'oneshot', 'a', 'm3'), metadata: { sessionId: 'client-pick' } });
    await h.gateway.send({ ...msg('chan-a', 'oneshot', 'b', 'm4'), metadata: { sessionId: 'client-pick' } });
    // 策略键生效（per-message 各自新会话），客户端键没有被创建
    expect(await h.store.load(`${h.agentA.agentId}:chan-a:oneshot:m3`)).not.toBeNull();
    expect(await h.store.load(`${h.agentA.agentId}:chan-a:oneshot:m4`)).not.toBeNull();
    expect(await h.store.load('client-pick')).toBeNull();
  });

  it('客户端 sessionId 归属闸：指向他会话一律拒（MAJ-2-B，跨 agent=跨租户）', async () => {
    const h = await makeHarness();
    const registry = h.gateway.getRegistry()!;
    registry.createBinding({ tenantId: h.tA, platform: 'chan-a', identity: 'u1', agentId: h.agentA.agentId });

    // 先给 agentB 建一个会话（B 租户资产），再让 A 的流量自报该会话 id
    const victim = 'victim-session';
    await h.gateway.createSession({
      agentId: h.agentB.agentId,
      sessionId: victim,
      tenantId: h.tB,
    });
    await h.gateway.send({
      ...msg('chan-a', 'u1', 'hi', 'm1'),
      metadata: { agentId: h.agentA.agentId, sessionId: victim },
    });
    expect(h.chanA.sent).toEqual([]);
    // 受害会话未被写入
    const data = await h.store.load(victim);
    expect(data?.messages ?? []).toEqual([]);

    // 同 agent 的自报会话照常续接（WebUI 语义）
    await h.gateway.createSession({ agentId: h.agentA.agentId, sessionId: 'own-session', tenantId: h.tA });
    await h.gateway.send({
      ...msg('chan-a', 'u1', 'hi', 'm2'),
      metadata: { agentId: h.agentA.agentId, sessionId: 'own-session' },
    });
    expect(h.chanA.sent.map((r) => r.content)).toEqual(['AGENT_A_SYS']);
    expect((await h.store.load('own-session'))?.messages?.length ?? 0).toBeGreaterThan(0);
  });
});
