/**
 * LLM describe 端口（B 方案，2026-11-02）— gateway 代生成
 *
 * 防回归背景：gateway 侧的 LLM describe 链（buildKnowledgeDescribePort）曾因
 * Gateway→Service 拆分变成死链被删（v0.98.11）；B 方案把它接回真路径——
 * Service settle 发 describe-pending → gateway 取素材（密钥扫描后）→ models.level
 * 选型生成 → 写入口回写（归因 llm）。本文件锁端口/选型/升级流/事件接线/boot hop。
 */
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { buildKnowledgeDescribePort } from '@octopi-agent/gateway/gateway/knowledge-describe.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';

type FakeClient = {
  getDescribeSample: ReturnType<typeof vi.fn>;
  describeSource: ReturnType<typeof vi.fn>;
  listDescribePending: ReturnType<typeof vi.fn>;
};

function fakeClient(): FakeClient {
  return {
    getDescribeSample: vi.fn(async () => ({
      blocked: false as const,
      meta: { displayName: 'corpus', kind: 'directory' as const, location: '/tmp/c' },
      sample: 'paths:\nops/deploy.md',
    })),
    describeSource: vi.fn(async () => ({ generatedDescription: 'LLM line', source: 'llm' })),
    listDescribePending: vi.fn(async () => [] as string[]),
  };
}

function fakeProvider(content = 'LLM line') {
  return { chat: vi.fn(async (_req: unknown) => ({ content, model: 'm' })) };
}

function gatewayWith(
  client: FakeClient,
  opts?: {
    levels?: Record<string, { primary: string; fallback?: string[] }>;
    autoDescribe?: boolean;
    subscribe?: (cb: (evt: { type: string; data: unknown }) => void) => void;
  },
): { gw: Gateway; provider: ReturnType<typeof fakeProvider> } {
  const gw = new Gateway({
    agents: [],
    knowledge: {
      service: { manageLocal: true },
      ...(opts?.autoDescribe != null ? { catalog: { autoDescribe: opts.autoDescribe } } : {}),
    },
    ...(opts?.levels ? { levels: opts.levels } : {}),
  } as unknown as GatewayConfig);
  const provider = fakeProvider();
  (gw as never as { providers: Map<string, unknown> }).providers.set('p', provider);
  const fakeRt = {
    state: 'ready',
    knowledgeClient: client,
    subscribeProgress: vi.fn(async (cb: (evt: { type: string; data: unknown }) => void) => {
      opts?.subscribe?.(cb);
      return () => undefined;
    }),
  };
  (gw as never as { getKnowledgeRuntime(): Promise<unknown> }).getKnowledgeRuntime =
    async () => fakeRt;
  return { gw, provider };
}

describe('buildKnowledgeDescribePort', () => {
  it('构造 prompt（元数据+样本）、限 maxTokens、透传模型名；LLM 文本原样返回', async () => {
    const provider = fakeProvider('  one line purpose  ');
    const port = buildKnowledgeDescribePort(
      provider as never,
      'mini-model',
    );
    const out = await port({
      displayName: 'corpus',
      kind: 'directory',
      location: '/tmp/c',
      sample: 'paths:\nops/deploy.md',
    });
    expect(out).toBe('  one line purpose  ');
    const call = provider.chat.mock.calls[0]![0] as unknown as {
      model: string;
      maxTokens: number;
      messages: Array<{ content: string }>;
    };
    expect(call.model).toBe('mini-model');
    expect(call.maxTokens).toBeLessThanOrEqual(300);
    expect(call.messages[0]!.content).toContain('corpus');
    expect(call.messages[0]!.content).toContain('ops/deploy.md');
  });

  it('LLM 抛错向上抛（由 funnel 回退启发式）', async () => {
    const provider = { chat: vi.fn(async () => { throw new Error('boom'); }) };
    const port = buildKnowledgeDescribePort(provider as never);
    await expect(
      port({ displayName: 'x', kind: 'directory', location: '/l', sample: 's' }),
    ).rejects.toThrow('boom');
  });
});

describe('resolveDescribeModel（models.level 选型）', () => {
  it('mini 优先于 standard；缺 provider 的档位跳过；未配置 level → null（LLM 描述不启用）', () => {
    const { gw } = gatewayWith(fakeClient(), {
      levels: { mini: { primary: 'p/m1' }, standard: { primary: 'p/m2' } },
    });
    const bound = (
      gw as never as { resolveDescribeModel(): { model?: string } | null }
    ).resolveDescribeModel();
    expect(bound?.model).toBe('m1');

    const { gw: gw2 } = gatewayWith(fakeClient(), { levels: { standard: { primary: 'p/m2' } } });
    expect(
      (gw2 as never as { resolveDescribeModel(): unknown }).resolveDescribeModel(),
    ).toBeTruthy();

    const { gw: gw3 } = gatewayWith(fakeClient());
    expect(
      (gw3 as never as { resolveDescribeModel(): unknown }).resolveDescribeModel(),
    ).toBeNull();
  });
});

describe('upgradeKnowledgeDescribe（heuristic → llm 升级）', () => {
  it('干净素材 + 已配 level → LLM 文本经写入口回写（归因 llm）', async () => {
    const client = fakeClient();
    const { gw } = gatewayWith(client, { levels: { mini: { primary: 'p/m1' } } });
    const ok = await (
      gw as never as { upgradeKnowledgeDescribe(id: string): Promise<boolean> }
    ).upgradeKnowledgeDescribe('s1');
    expect(ok).toBe(true);
    expect(client.describeSource).toHaveBeenCalledWith('s1', {
      description: 'LLM line',
      source: 'llm',
    });
  });

  it('素材被密钥封锁 → 不外发、不回写', async () => {
    const client = fakeClient();
    client.getDescribeSample.mockResolvedValue({
      blocked: true,
      secretHits: ['openai_style_key'],
    });
    const { gw } = gatewayWith(client, { levels: { mini: { primary: 'p/m1' } } });
    const ok = await (
      gw as never as { upgradeKnowledgeDescribe(id: string): Promise<boolean> }
    ).upgradeKnowledgeDescribe('s1');
    expect(ok).toBe(false);
    expect(client.describeSource).not.toHaveBeenCalled();
  });

  it('未配置 models.level / LLM 失败 → 不回写（启发式保底不动）', async () => {
    const c1 = fakeClient();
    const { gw: g1 } = gatewayWith(c1);
    expect(
      await (g1 as never as { upgradeKnowledgeDescribe(id: string): Promise<boolean> })
        .upgradeKnowledgeDescribe('s1'),
    ).toBe(false);
    expect(c1.describeSource).not.toHaveBeenCalled();

    const c2 = fakeClient();
    const { gw: g2 } = gatewayWith(c2, { levels: { mini: { primary: 'p/m1' } } });
    (
      g2 as never as { providers: Map<string, { chat: () => Promise<unknown> }> }
    ).providers.set('p', { chat: vi.fn(async () => { throw new Error('llm down'); }) });
    expect(
      await (g2 as never as { upgradeKnowledgeDescribe(id: string): Promise<boolean> })
        .upgradeKnowledgeDescribe('s1'),
    ).toBe(false);
    expect(c2.describeSource).not.toHaveBeenCalled();
  });
});

describe('事件接线 + 手动触发', () => {
  it('describe-pending 事件 → 入队升级（写入口回写）', async () => {
    let captured: ((evt: { type: string; data: unknown }) => void) | undefined;
    const client = fakeClient();
    const { gw } = gatewayWith(client, {
      levels: { mini: { primary: 'p/m1' } },
      subscribe: (cb) => {
        captured = cb;
      },
    });
    await gw.startKnowledgeProgressForwarding();
    captured!({
      type: 'knowledge.index.progress',
      data: { type: 'source', sourceId: 's9', status: 'describe-pending' },
    });
    await vi.waitFor(() => {
      expect(client.describeSource).toHaveBeenCalledWith('s9', expect.anything());
    });
  });

  it('catalog.autoDescribe=false → 全自动链静默（事件不入队）', async () => {
    let captured: ((evt: { type: string; data: unknown }) => void) | undefined;
    const client = fakeClient();
    const { gw } = gatewayWith(client, {
      levels: { mini: { primary: 'p/m1' } },
      autoDescribe: false,
      subscribe: (cb) => {
        captured = cb;
      },
    });
    await gw.startKnowledgeProgressForwarding();
    captured!({
      type: 'knowledge.index.progress',
      data: { type: 'source', sourceId: 's9', status: 'describe-pending' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.describeSource).not.toHaveBeenCalled();
  });

  it('手动触发：LLM 优先，未配置 level 回退 Service 启发式（不受 autoDescribe 闸门约束）', async () => {
    const client = fakeClient();
    const { gw } = gatewayWith(client, { autoDescribe: false });
    await gw.autoDescribeKnowledgeSource('s1');
    // 无 level → 升级返回 false → 回退无 body 的启发式 describeSource
    expect(client.describeSource).toHaveBeenCalledWith('s1');
    expect(client.describeSource).toHaveBeenCalledTimes(1);
  });

  it('boot sweep：启动补扫 listDescribePending 并逐个升级', async () => {
    const client = fakeClient();
    client.listDescribePending.mockResolvedValue(['a', 'b']);
    const { gw } = gatewayWith(client, { levels: { mini: { primary: 'p/m1' } } });
    await (
      gw as never as { sweepKnowledgeDescribe(): Promise<void> }
    ).sweepKnowledgeDescribe();
    await vi.waitFor(() => {
      expect(client.describeSource).toHaveBeenCalledTimes(2);
    });
    expect(client.describeSource).toHaveBeenCalledWith('a', expect.anything());
    expect(client.describeSource).toHaveBeenCalledWith('b', expect.anything());
  });
});

describe('WebApiRouter 手动 describe 路由（P1-1 真接线锁）', () => {
  interface CallResult {
    status: number;
    body: { ok: boolean; error?: string; data?: { id?: string } } | null;
  }

  async function post(router: unknown, url: string): Promise<CallResult> {
    const req = {
      url,
      method: 'POST',
      headers: { host: 'localhost', 'content-length': '0' },
    } as unknown as import('node:http').IncomingMessage;
    let status = 0;
    let body: CallResult['body'] = null;
    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      setHeader() {
        return this;
      },
      end(payload?: string) {
        body = payload ? JSON.parse(payload) : null;
        return this;
      },
    } as unknown as import('node:http').ServerResponse;
    const handled = await (
      router as { handle(req: unknown, res: unknown): Promise<boolean> }
    ).handle(req, res);
    expect(handled).toBe(true);
    return { status, body };
  }

  it('POST …/sources/:sid/describe → 调 gateway 手动入口；异常 → 400', async () => {
    const { WebApiRouter } = await import('@octopi-agent/gateway/web/api/router.js');
    const calls: string[] = [];
    const stub = {
      autoDescribeKnowledgeSource: async (id: string) => {
        calls.push(id);
        if (id === 'boom') throw new Error('knowledge_disabled');
      },
    };
    const router = new WebApiRouter({ gateway: stub as never });

    const ok = await post(router, '/api/v1/agents/default/knowledge/sources/s1/describe');
    expect(ok.status).toBe(200);
    expect(ok.body?.data?.id).toBe('s1');
    expect(calls).toEqual(['s1']);

    const bad = await post(router, '/api/v1/agents/default/knowledge/sources/boom/describe');
    expect(bad.status).toBe(400);
    expect(bad.body?.error).toContain('knowledge_disabled');
    expect(calls).toEqual(['s1', 'boom']);
  });
});

describe('boot hop：catalog.autoDescribe 真正进 manageLocal 子进程', () => {
  it('config catalog.autoDescribe=false → startKnowledgeServiceProcess 收到 autoDescribe:false（假接线回归锁）', async () => {
    vi.resetModules();
    const startMock = vi.fn(async () => ({
      port: 65501,
      child: { pid: 1, once: () => undefined },
      stop: async () => undefined,
    }));
    vi.doMock('@octopi-agent/engine/harness/knowledge/start-service-process.js', () => ({
      startKnowledgeServiceProcess: startMock,
    }));
    process.env.OCTOPI_HOME = '/tmp/octopi-describe-boot-hop';
    try {
      const { Gateway: Gw } = await import('@octopi-agent/gateway/gateway/gateway.js');
      const gw = new Gw({
        agents: [],
        knowledge: {
          service: { manageLocal: true },
          catalog: { autoDescribe: false },
        },
      } as unknown as GatewayConfig);
      await (
        gw as never as { getKnowledgeRuntime(): Promise<unknown> }
      ).getKnowledgeRuntime();
      expect(startMock).toHaveBeenCalledWith(
        expect.objectContaining({ autoDescribe: false }),
      );
    } finally {
      vi.doUnmock('@octopi-agent/engine/harness/knowledge/start-service-process.js');
      vi.resetModules();
    }
  });
});
