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
  invalidateAgentBuild: ReturnType<typeof vi.fn>;
  invalidateAllAgentBuilds: ReturnType<typeof vi.fn>;
  setModelLevels: ReturnType<typeof vi.fn>;
}

function makeGatewayStub(): GatewayStub {
  return {
    replaceProvider: vi.fn(),
    removeProvider: vi.fn(),
    invalidateAgentBuild: vi.fn(),
    invalidateAllAgentBuilds: vi.fn(),
    setModelLevels: vi.fn(),
  };
}

describe('ConfigApplyService', () => {
  let dir: string;
  let service: FileConfigService;
  let gateway: GatewayStub;
  let apply: ConfigApplyService;
  let providerFactory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.TEST_OPENAI_KEY = 'sk-test-env';
    dir = mkdtempSync(join(tmpdir(), 'octopi-config-apply-'));
    const configPath = join(dir, 'octopi.json');
    writeFileSync(configPath, `${JSON.stringify(minimalConfig(), null, 2)}\n`, 'utf-8');
    service = new FileConfigService({ configPath });
    gateway = makeGatewayStub();
    providerFactory = vi.fn(async (name: string) => ({ name }));
    apply = new ConfigApplyService({
      gateway: gateway as unknown as Gateway,
      configAdmin: service,
      providerFactory: providerFactory as never,
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
