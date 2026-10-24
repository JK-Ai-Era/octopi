/**
 * ConfigApplyService 集成测试：写盘 → gateway 热应用联动 / fail-safe / 引用完整性 / 发现
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConfigService } from '../src/config-service.js';
import { ConfigApplyService } from '../packages/gateway/src/gateway/config-apply.js';
import { ConfigConflictError } from '../packages/engine/src/config-admin/port.js';
import type { Gateway } from '../packages/gateway/src/gateway/gateway.js';

function minimalConfig(): Record<string, unknown> {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '${TEST_OPENAI_KEY}',
          api: 'openai-completions',
          models: [{ id: 'gpt-5.5' }],
        },
      },
      level: { standard: { primary: 'openai/gpt-5.5' } },
    },
    agents: [
      { id: 'assistant', model: 'standard' },
      { id: 'solo', model: 'anthropic/claude-sonnet-4-6' },
    ],
    channels: [{ type: 'http', port: 18180 }],
  };
}

interface GatewayStub {
  replaceProvider: ReturnType<typeof vi.fn>;
  removeProvider: ReturnType<typeof vi.fn>;
  registerAgent: ReturnType<typeof vi.fn>;
  removeAgent: ReturnType<typeof vi.fn>;
  invalidateAgentBuild: ReturnType<typeof vi.fn>;
  invalidateAllAgentBuilds: ReturnType<typeof vi.fn>;
  setModelLevels: ReturnType<typeof vi.fn>;
  getRegisteredAgents: ReturnType<typeof vi.fn>;
  getAgentDefinition: ReturnType<typeof vi.fn>;
}

function makeGatewayStub(): GatewayStub {
  return {
    replaceProvider: vi.fn(),
    removeProvider: vi.fn(),
    registerAgent: vi.fn(),
    removeAgent: vi.fn(),
    invalidateAgentBuild: vi.fn(),
    invalidateAllAgentBuilds: vi.fn(),
    setModelLevels: vi.fn(),
    getRegisteredAgents: vi.fn(() => []),
    getAgentDefinition: vi.fn((id: string) => ({
      id,
      home: undefined,
      persona: { name: id, description: '', systemPrompt: '' },
    })),
  };
}

interface AgentFilesStub {
  files: Map<string, string>;
  pathsOf: ReturnType<typeof vi.fn>;
  scaffold: ReturnType<typeof vi.fn>;
  readPersona: ReturnType<typeof vi.fn>;
  writePersona: ReturnType<typeof vi.fn>;
}

function makeAgentFilesStub(): AgentFilesStub {
  const files = new Map<string, string>();
  return {
    files,
    pathsOf: vi.fn((id: string) => ({
      home: `/octopi/agents/${id}`,
      workspace: `/octopi/workspace/${id}`,
      skillDirectory: `/octopi/agents/${id}/skills`,
    })),
    scaffold: vi.fn(async (id: string, opts: { agentsMd?: string }) => {
      if (opts.agentsMd !== undefined && !files.has(id)) files.set(id, opts.agentsMd);
    }),
    readPersona: vi.fn((id: string) => files.get(id) ?? null),
    writePersona: vi.fn((id: string, content: string) => {
      files.set(id, content);
    }),
  };
}

describe('ConfigApplyService', () => {
  let dir: string;
  let service: FileConfigService;
  let gateway: GatewayStub;
  let agentFiles: AgentFilesStub;
  let apply: ConfigApplyService;
  let providerFactory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.TEST_OPENAI_KEY = 'sk-test-env';
    dir = mkdtempSync(join(tmpdir(), 'octopi-config-apply-'));
    const configPath = join(dir, 'octopi.json');
    writeFileSync(configPath, `${JSON.stringify(minimalConfig(), null, 2)}\n`, 'utf-8');
    service = new FileConfigService({ configPath });
    gateway = makeGatewayStub();
    agentFiles = makeAgentFilesStub();
    providerFactory = vi.fn(async (name: string) => ({ name }));
    apply = new ConfigApplyService({
      gateway: gateway as unknown as Gateway,
      configAdmin: service,
      providerFactory: providerFactory as never,
      agentFiles: agentFiles as never,
      agentDefFactory: (rawEntry) => ({ id: String(rawEntry.id) }) as never,
    });
  });

  afterEach(() => {
    delete process.env.TEST_OPENAI_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('getModelsView：apiKey 脱敏 + hash', () => {
    const view = apply.getModelsView();
    expect(view.providers).toHaveLength(1);
    expect(view.providers[0]!.apiKey).toEqual({ configured: true, ref: 'TEST_OPENAI_KEY' });
    expect(JSON.stringify(view)).not.toContain('sk-test-env');
    expect(view.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('upsertProvider：写盘 + 热替换 + 失效引用 agent（level 递归命中 assistant）', async () => {
    const before = service.read();
    const result = await apply.upsertProvider(
      'openai',
      {
        baseUrl: 'https://proxy.example.com/v1',
        apiKey: '${TEST_OPENAI_KEY}',
        api: 'openai-completions',
        models: [{ id: 'gpt-5.5' }],
      },
      before.hash,
    );

    // 写盘生效
    const text = readFileSync(join(dir, 'octopi.json'), 'utf-8');
    expect(text).toContain('https://proxy.example.com/v1');
    // 热应用：replaceProvider 被调，引用 agent 失效
    expect(gateway.replaceProvider).toHaveBeenCalledTimes(1);
    const [, , affected] = gateway.replaceProvider.mock.calls[0]!;
    expect(affected).toContain('assistant');
    expect(affected).not.toContain('solo');
    expect(result.applied).toBe('next-run');
    expect(result.hash).toBe(service.read().hash);
  });

  it('upsertProvider：apiKey 未提供 = 保留现有值（UI「留空保留」语义）', async () => {
    const before = service.read();
    await apply.upsertProvider(
      'openai',
      {
        baseUrl: 'https://proxy2.example.com/v1',
        api: 'openai-completions',
        models: [{ id: 'gpt-5.5' }],
      },
      before.hash,
    );
    // 盘上 apiKey 保留原 ${VAR} 形态
    const raw = service.read().raw;
    const pc = (raw.models as { providers: Record<string, { apiKey: string }> }).providers.openai!;
    expect(pc.apiKey).toBe('${TEST_OPENAI_KEY}');
    // 热替换用的 config 也带继承的 key（不给 provider 实例丢凭据）
    const [, appliedConfig] = gateway.replaceProvider.mock.calls[0]! as unknown as [
      unknown,
      Record<string, unknown>,
      string[],
    ];
    expect(appliedConfig.apiKey).toBe('${TEST_OPENAI_KEY}');
  });

  it('fail-safe：写失败（冲突）不动运行时', async () => {
    const stale = service.read();
    // 外部手改制造冲突（内容必须真实变化）
    const cfg = minimalConfig();
    (
      cfg.models as { providers: Record<string, { baseUrl: string }> }
    ).providers.openai!.baseUrl = 'https://external.example.com/v1';
    writeFileSync(join(dir, 'octopi.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');

    await expect(
      apply.upsertProvider('openai', { baseUrl: 'x', apiKey: '${TEST_OPENAI_KEY}', api: 'openai-completions', models: [{ id: 'm' }] }, stale.hash),
    ).rejects.toBeInstanceOf(ConfigConflictError);
    expect(gateway.replaceProvider).not.toHaveBeenCalled();
  });

  it('deleteProvider：有 agent 引用拒绝（fail-loud，不写盘）', async () => {
    const before = service.read();
    await expect(apply.deleteProvider('openai', before.hash)).rejects.toThrow(/still referenced/);
    expect(gateway.removeProvider).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'octopi.json'), 'utf-8')).toContain('openai');
  });

  it('deleteProvider：无引用成功摘除', async () => {
    // 先加一个无引用 provider 再删
    const before = service.read();
    await apply.upsertProvider(
      'temp',
      { baseUrl: 'https://t.example.com/v1', apiKey: 'sk-t', api: 'openai-completions', models: [{ id: 'm' }] },
      before.hash,
    );
    const mid = service.read();
    const result = await apply.deleteProvider('temp', mid.hash);
    expect(gateway.removeProvider).toHaveBeenCalledWith('temp', []);
    expect(result.applied).toBe('next-run');
    expect(apply.getModelsView().providers.some((p) => p.name === 'temp')).toBe(false);
  });

  it('updateLevels：写盘 + 全量重建（levelMap 被 builder 捕获，如实 next-run）', async () => {
    const before = service.read();
    const result = await apply.updateLevels(
      { standard: { primary: 'openai/gpt-5-mini', fallback: ['openai/gpt-5.5'] } },
      before.hash,
    );
    expect(result.applied).toBe('next-run');
    expect(gateway.setModelLevels).toHaveBeenCalledWith({
      standard: { primary: 'openai/gpt-5-mini', fallback: ['openai/gpt-5.5'] },
    });
    expect(gateway.invalidateAllAgentBuilds).toHaveBeenCalled();
    expect(apply.getModelsView().level).toEqual({
      standard: { primary: 'openai/gpt-5-mini', fallback: ['openai/gpt-5.5'] },
    });
  });

  it('updateLevels：非对象 level 拒绝（防空体误清空）', async () => {
    const before = service.read();
    await expect(apply.updateLevels(null as never, before.hash)).rejects.toThrow(/level must be an object/);
  });

  it('testProvider：${VAR} 展开后调发现（fetch 桩）；缺省字段回落已存 provider', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'new-model' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);
    try {
      // body 只带 baseUrl：apiKey 回落盘上 ${TEST_OPENAI_KEY}（编辑现有 provider 测试不重填密钥）
      const result = await apply.testProvider('openai', {
        baseUrl: 'https://api.openai.com/v1',
        api: 'openai-completions',
      });
      expect(result.ok).toBe(true);
      expect(result.models.map((m) => m.id)).toEqual(['gpt-5.5', 'new-model']);
      // Bearer 用展开后的 key（来自已存 provider）
      const [, init] = fetchStub.mock.calls[0]! as unknown as [string, { headers: Record<string, string> }];
      expect(init.headers.Authorization).toBe('Bearer sk-test-env');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ConfigApplyService — agent CRUD（P2）', () => {
  let dir: string;
  let service: FileConfigService;
  let gateway: GatewayStub;
  let agentFiles: AgentFilesStub;
  let apply: ConfigApplyService;

  beforeEach(() => {
    process.env.TEST_OPENAI_KEY = 'sk-test-env';
    dir = mkdtempSync(join(tmpdir(), 'octopi-config-apply-agent-'));
    const configPath = join(dir, 'octopi.json');
    writeFileSync(configPath, `${JSON.stringify(minimalConfig(), null, 2)}\n`, 'utf-8');
    service = new FileConfigService({ configPath });
    gateway = makeGatewayStub();
    agentFiles = makeAgentFilesStub();
    apply = new ConfigApplyService({
      gateway: gateway as unknown as Gateway,
      configAdmin: service,
      providerFactory: (async (name: string) => ({ name })) as never,
      agentFiles: agentFiles as never,
      agentDefFactory: (rawEntry) => ({ id: String(rawEntry.id) }) as never,
    });
  });

  afterEach(() => {
    delete process.env.TEST_OPENAI_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('createAgent：scaffold → 写盘 → 注册 + 重建（affected=[新 id]）', async () => {
    const before = service.read();
    const result = await apply.createAgent({
      agent: {
        id: 'helper',
        // persona 省略：AGENTS.md 是身份真源（inline persona 断 resolver）
        model: 'standard',
        effectPolicy: { mode: 'project' },
      },
      agentsMd: '# helper persona',
      hash: before.hash,
    });

    expect(agentFiles.scaffold).toHaveBeenCalledWith('helper', expect.objectContaining({ agentsMd: '# helper persona' }));
    expect(gateway.registerAgent).toHaveBeenCalledTimes(1);
    expect(gateway.invalidateAgentBuild).toHaveBeenCalledWith('helper');
    expect(result.affectedAgents).toEqual(['helper']);
    expect(result.applied).toBe('next-run');
    // 写盘生效
    const raw = service.read().raw;
    const agents = raw.agents as Array<{ id: string }>;
    expect(agents.some((a) => a.id === 'helper')).toBe(true);
  });

  it('createAgent：重名 / 非法 id 拒绝（不动盘、不 scaffold）', async () => {
    const before = service.read();
    await expect(
      apply.createAgent({ agent: { id: 'assistant' }, hash: before.hash }),
    ).rejects.toThrow(/already exists/);
    await expect(
      apply.createAgent({ agent: { id: '../evil' }, hash: before.hash }),
    ).rejects.toThrow(/invalid config name/);
    expect(agentFiles.scaffold).not.toHaveBeenCalled();
  });

  it('updateAgent：浅合并——未展示字段（home/delegation）不丢（P1 input 透传教训回归锚）', async () => {
    // 预置带隐藏字段的条目
    const before = service.read();
    await apply.createAgent(
      {
        agent: {
          id: 'helper',
          model: 'standard',
          home: '/keep/me',
          delegation: { callable: true, canDelegate: false },
        },
        hash: before.hash,
      },
    );
    const mid = service.read();
    await apply.updateAgent(
      'helper',
      { effectPolicy: { mode: 'host' }, traits: ['t1'] },
      mid.hash,
    );

    const raw = service.read().raw;
    const helper = (raw.agents as Array<Record<string, unknown>>).find((a) => a.id === 'helper')!;
    // 变更字段生效
    expect(helper.effectPolicy).toEqual({ mode: 'host' });
    expect(helper.traits).toEqual(['t1']);
    // 未展示字段保留（merge 语义）
    expect(helper.home).toBe('/keep/me');
    expect(helper.delegation).toEqual({ callable: true, canDelegate: false });
    expect(gateway.registerAgent).toHaveBeenCalledTimes(2);
  });

  it('deleteAgent：写盘移除 + 注册表摘除（文件态语义由 agentFiles 保留，无删除调用）', async () => {
    const before = service.read();
    await apply.createAgent({ agent: { id: 'helper', model: 'standard' }, agentsMd: '# helper', hash: before.hash });
    const mid = service.read();
    const result = await apply.deleteAgent('helper', mid.hash);
    expect(gateway.removeAgent).toHaveBeenCalledWith('helper');
    expect(result.applied).toBe('next-run');
    const agents = service.read().raw.agents as Array<{ id: string }>;
    expect(agents.some((a) => a.id === 'helper')).toBe(false);
    // home 保留：scaffold 无「删除」语义
    expect(agentFiles.files.has('helper')).toBe(true);
  });

  it('persona 读写：内容 hash 乐观锁 + 写后重建', async () => {
    const before = service.read();
    await apply.createAgent({ agent: { id: 'helper', model: 'standard' }, agentsMd: '# v1', hash: before.hash });

    const view = apply.getPersona('helper');
    expect(view.content).toBe('# v1');

    const updated = await apply.updatePersona('helper', '# v2', view.hash);
    expect(updated.hash).toBe(apply.getPersona('helper').hash);
    expect(gateway.invalidateAgentBuild).toHaveBeenCalledWith('helper');

    // 冲突：旧 hash 拒绝
    await expect(apply.updatePersona('helper', '# v3', view.hash)).rejects.toBeInstanceOf(ConfigConflictError);
    expect(apply.getPersona('helper').content).toBe('# v2');
  });
});

describe('ConfigApplyService — review blocker 回归锚', () => {
  let dir: string;
  let service: FileConfigService;
  let gateway: GatewayStub;
  let agentFiles: AgentFilesStub;
  let apply: ConfigApplyService;
  let factoryCalls: Array<{ entry: Record<string, unknown>; raw: Record<string, unknown> }>;
  let factoryThrows: boolean;

  beforeEach(() => {
    process.env.TEST_OPENAI_KEY = 'sk-test-env';
    dir = mkdtempSync(join(tmpdir(), 'octopi-config-apply-anchor-'));
    const configPath = join(dir, 'octopi.json');
    writeFileSync(configPath, `${JSON.stringify(minimalConfig(), null, 2)}\n`, 'utf-8');
    service = new FileConfigService({ configPath });
    gateway = makeGatewayStub();
    agentFiles = makeAgentFilesStub();
    factoryCalls = [];
    factoryThrows = false;
    apply = new ConfigApplyService({
      gateway: gateway as unknown as Gateway,
      configAdmin: service,
      providerFactory: (async (name: string) => ({ name })) as never,
      agentFiles: agentFiles as never,
      agentDefFactory: (rawEntry, rawConfig) => {
        factoryCalls.push({ entry: rawEntry, raw: rawConfig });
        if (factoryThrows) throw new Error('resolve failed');
        return { id: String(rawEntry.id) } as never;
      },
    });
  });

  afterEach(() => {
    delete process.env.TEST_OPENAI_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('#1 锚：createAgent 条目自动补全 home/workspace/skillDirectory（persona 才会被加载）', async () => {
    const before = service.read();
    await apply.createAgent({ agent: { id: 'helper', model: 'standard' }, agentsMd: '# p', hash: before.hash });
    const helper = (service.read().raw.agents as Array<Record<string, unknown>>).find((a) => a.id === 'helper')!;
    expect(helper.home).toBe('/octopi/agents/helper');
    expect(helper.workspace).toBe('/octopi/workspace/helper');
    expect(helper.skillDirectory).toBe('/octopi/agents/helper/skills');
    // 预构造拿到的也是补全后条目
    expect(factoryCalls[0]!.entry.home).toBe('/octopi/agents/helper');
  });

  it('#3 锚：预构造失败不动盘（写盘永不先行）', async () => {
    const before = service.read();
    factoryThrows = true;
    await expect(
      apply.createAgent({ agent: { id: 'bad', model: 'standard' }, hash: before.hash }),
    ).rejects.toThrow(/resolve failed/);
    const after = service.read();
    expect(after.hash).toBe(before.hash);
    expect((after.raw.agents as unknown[]).length).toBe(2);
    expect(agentFiles.scaffold).not.toHaveBeenCalled();
    expect(gateway.registerAgent).not.toHaveBeenCalled();
  });

  it('#5 锚：effectPolicy 二级合并——只改 mode，高级旋钮（onClose/shellEscape）保留', async () => {
    const before = service.read();
    await apply.createAgent(
      {
        agent: {
          id: 'helper',
          model: 'standard',
          effectPolicy: { mode: 'project', onClose: 'discard', shellEscape: 'deny' },
        },
        hash: before.hash,
      },
    );
    const mid = service.read();
    await apply.updateAgent('helper', { effectPolicy: { mode: 'host' } }, mid.hash);
    const helper = (service.read().raw.agents as Array<Record<string, unknown>>).find((a) => a.id === 'helper')!;
    expect(helper.effectPolicy).toEqual({ mode: 'host', onClose: 'discard', shellEscape: 'deny' });
  });

  it('#6 锚：字段值 null = 删除键（effectPolicy: null 恢复继承全局）', async () => {
    const before = service.read();
    await apply.createAgent(
      { agent: { id: 'helper', model: 'standard', effectPolicy: { mode: 'host' } }, hash: before.hash },
    );
    const mid = service.read();
    await apply.updateAgent('helper', { effectPolicy: null }, mid.hash);
    const helper = (service.read().raw.agents as Array<Record<string, unknown>>).find((a) => a.id === 'helper')!;
    expect('effectPolicy' in helper).toBe(false);
  });

  it('#4 锚：路径穿越 id（..）拒绝', async () => {
    const before = service.read();
    await expect(
      apply.createAgent({ agent: { id: '..', model: 'standard' }, hash: before.hash }),
    ).rejects.toThrow(/invalid config name/);
    expect(() => apply.getPersona('..')).toThrow(/invalid config name/);
    expect(agentFiles.scaffold).not.toHaveBeenCalled();
  });
});
