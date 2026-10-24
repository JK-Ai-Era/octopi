/**
 * FileConfigService 单测：乐观锁冲突 / 写前校验失败不动盘 / 备份 / ${ENV} 保留 / 串行写
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConfigService } from '../src/config-service.js';
import { ConfigConflictError } from '../packages/engine/src/config-admin/port.js';

/** 最小合法配置（过 OctopiConfigSchema 校验） */
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
    },
    agents: [{ id: 'assistant', model: 'openai/gpt-5.5' }],
    channels: [{ type: 'http', port: 18180 }],
  };
}

describe('FileConfigService', () => {
  let dir: string;
  let configPath: string;
  let service: FileConfigService;

  beforeEach(() => {
    // 模拟 daemon 运行环境：loadConfig 启动时已解析的 env 在写校验时同样生效
    process.env.TEST_OPENAI_KEY = 'sk-test-env';
    dir = mkdtempSync(join(tmpdir(), 'octopi-config-service-'));
    configPath = join(dir, 'octopi.json');
    writeFileSync(configPath, `${JSON.stringify(minimalConfig(), null, 2)}\n`, 'utf-8');
    service = new FileConfigService({ configPath });
  });

  afterEach(() => {
    delete process.env.TEST_OPENAI_KEY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('read 返回 raw（${ENV} 占位符不展开）与 hash', () => {
    const snap = service.read();
    const providers = snap.raw.models as { providers: Record<string, { apiKey: string }> };
    expect(providers.providers.openai!.apiKey).toBe('${TEST_OPENAI_KEY}');
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('write 成功：写后 hash 更新 + 留备份 + ${ENV} 原样保留', async () => {
    const before = service.read();
    const result = await service.write((raw) => {
      const models = raw.models as { providers: Record<string, Record<string, unknown>> };
      models.providers.openai!.baseUrl = 'https://proxy.example.com/v1';
    }, before.hash);

    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('https://proxy.example.com/v1');
    expect(text).toContain('${TEST_OPENAI_KEY}');
    expect(result.hash).not.toBe(before.hash);
    expect(result.hash).toBe(service.read().hash);
    expect(readFileSync(result.backupPath, 'utf-8')).toContain('https://api.openai.com/v1');
  });

  it('乐观锁：expectedHash 过期抛 ConfigConflictError 且盘上不变', async () => {
    const stale = service.read();
    // 模拟外部手改
    const external = minimalConfig();
    (external.models as { providers: Record<string, { baseUrl: string }> }).providers.openai!.baseUrl =
      'https://external.example.com/v1';
    writeFileSync(configPath, `${JSON.stringify(external, null, 2)}\n`, 'utf-8');

    await expect(
      service.write((raw) => {
        (raw.models as Record<string, unknown>).providers = {};
      }, stale.hash),
    ).rejects.toBeInstanceOf(ConfigConflictError);

    expect(readFileSync(configPath, 'utf-8')).toContain('https://external.example.com/v1');
  });

  it('写前校验失败：抛错且盘上不变、无备份产生', async () => {
    const before = service.read();
    await expect(
      service.write((raw) => {
        // 非法配置：agents 置空（model 必填结构被破坏）
        raw.agents = 'not-an-array';
      }, before.hash),
    ).rejects.toThrow();

    expect(readFileSync(configPath, 'utf-8')).toContain('"assistant"');
    const backups = readdirSync(dir).filter((f) => f.includes('.bak.'));
    expect(backups).toHaveLength(0);
  });

  it('${VAR} 未解析：允许保存（keyless/后配 env），写回保留占位符', async () => {
    const before = service.read();
    delete process.env.TEST_OPENAI_KEY;
    // apiKey optional：未解析占位符展开为空但校验通过（请求时才 401；启动不变式保持）
    const result = await service.write((raw) => {
      const models = raw.models as { providers: Record<string, Record<string, unknown>> };
      models.providers.openai!.apiKey = '${UNSET_ENV_VAR}';
    }, before.hash);
    expect(result.hash).toBe(service.read().hash);
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('${UNSET_ENV_VAR}');
    process.env.TEST_OPENAI_KEY = 'sk-test-env';
  });

  it('并发写串行：同 hash 双写不交错，第二次正确冲突', async () => {
    const before = service.read();
    const p1 = service.write((raw) => {
      (raw as Record<string, unknown>).session = { dmScope: 'main' };
    }, before.hash);
    const p2 = service.write((raw) => {
      (raw as Record<string, unknown>).session = { dmScope: 'per-peer' };
    }, before.hash);

    const r1 = await p1;
    await expect(p2).rejects.toBeInstanceOf(ConfigConflictError);

    const final = service.read();
    expect(final.hash).toBe(r1.hash);
    expect((final.raw.session as { dmScope: string }).dmScope).toBe('main');
  });
});
