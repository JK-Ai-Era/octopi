import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_AGENT_NAME,
  DEMO_REPORT_PATH,
  DEMO_SAMPLE_FILES,
  DEMO_SCRIPT_PROMPTS,
  seedDemoKit,
} from '../packages/engine/src/config-admin/demo-kit.js';
import { DemoKitService } from '../packages/gateway/src/web/api/demo-kit.js';
import { RegistryService } from '../packages/engine/src/harness/governance/registry/service.js';
import { agentWorkspaceDir } from '../packages/engine/src/paths.js';

describe('演示任务包（批 3-1）', () => {
  let home: string;
  let tenantId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'octopi-demo-'));
    const registry = await RegistryService.create({ dbPath: join(home, 'registry.db') });
    try {
      const tenant = registry.ensureTenant('default', 'default');
      const user = await registry.createUserInTenant({ tenantId: tenant.tenantId, name: 'default' });
      tenantId = tenant.tenantId as string;
      ownerUserId = user.userId as string;
    } finally {
      registry.close();
    }
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('播种：demo agent 建立（name 判据 + 宿主白名单可 materialize——评审 B1）+ 三份样例落盘', async () => {
    const result = await seedDemoKit({ octopiHome: home, tenantId, ownerUserId });
    expect(result.created).toBe(true);
    expect(result.samplesWritten).toBe(DEMO_SAMPLE_FILES.length);

    const registry = await RegistryService.create({ dbPath: join(home, 'registry.db') });
    try {
      const record = registry.getAgent(result.agentId as never);
      expect(record).not.toBeNull();
      expect((JSON.parse(record!.definition) as Record<string, unknown>).name).toBe(DEMO_AGENT_NAME);
      // B1 回归锚：definition 只含宿主治理白名单键——materialize 不得抛 registry_invalid_definition
      const { createRegistryAgentBridge } = await import('../src/registry-bridge.js');
      const bridge = createRegistryAgentBridge({
        getRawConfig: () => ({
          models: {
            providers: {
              mock: {
                baseUrl: 'http://127.0.0.1:1/v1',
                apiKey: 'test-key',
                api: 'openai-completions',
                models: [{ id: 'm', name: 'm', contextWindow: 32000, maxTokens: 4096 }],
              },
            },
            level: { standard: { primary: 'mock/m' } },
          },
        }),
        homeDir: join(home, 'home'),
      });
      const def = await bridge.materialize(record as never);
      // 锚本意：materialize 走完宿主治理白名单不抛 registry_invalid_definition（B1 核心）
      expect(def).toBeTruthy();
    } finally {
      registry.close();
    }

    const workspace = agentWorkspaceDir(home, tenantId, result.agentId);
    for (const sample of DEMO_SAMPLE_FILES) {
      const p = join(workspace, ...sample.path.split('/'));
      expect(existsSync(p)).toBe(true);
    }
    expect(existsSync(join(home, 'agents', result.agentId, 'AGENTS.md'))).toBe(true);
  });

  it('幂等：重跑不重建 agent、不重写文件', async () => {
    const first = await seedDemoKit({ octopiHome: home, tenantId, ownerUserId });
    const second = await seedDemoKit({ octopiHome: home, tenantId, ownerUserId });
    expect(second.created).toBe(false);
    expect(second.agentId).toBe(first.agentId);
    expect(second.samplesWritten).toBe(0);
  });

  it('用户改动保护：已存在的样例文件不被覆盖（演示数据与用户数据同一路径）', async () => {
    const first = await seedDemoKit({ octopiHome: home, tenantId, ownerUserId });
    const workspace = agentWorkspaceDir(home, tenantId, first.agentId);
    const target = join(workspace, ...DEMO_SAMPLE_FILES[0].path.split('/'));
    writeFileSync(target, '# 我改过的素材', 'utf8');
    await seedDemoKit({ octopiHome: home, tenantId, ownerUserId });
    expect(readFileSync(target, 'utf8')).toBe('# 我改过的素材');
  });

  it('剧本契约：三步剧本覆盖 读资料→总结周报→存成文件，产物路径显式', () => {
    for (const lang of ['zh', 'en'] as const) {
      const prompt = DEMO_SCRIPT_PROMPTS[lang];
      expect(prompt).toContain('demo/');
      expect(prompt).toContain(DEMO_REPORT_PATH);
    }
    expect(DEMO_REPORT_PATH).toBe('demo/weekly-report.md');
  });

  it('下发面 getKit：demo 未播种 available=false；播种后下发 agentId + 单源 prompt', async () => {
    const svc = new DemoKitService({ octopiHome: home });
    const before = await svc.getKit('zh');
    expect(before.available).toBe(false);

    const seeded = await seedDemoKit({ octopiHome: home, tenantId, ownerUserId });
    const after = await svc.getKit('zh');
    expect(after.available).toBe(true);
    expect(after.agentId).toBe(seeded.agentId);
    // 单源锚：下发的 prompt 就是 engine 常量本体（webui 消费下发值，不存第二份）
    expect(after.prompt).toBe(DEMO_SCRIPT_PROMPTS.zh);
    const en = await svc.getKit('en');
    expect(en.prompt).toBe(DEMO_SCRIPT_PROMPTS.en);
  });
});

describe('评审回归锚（del-1d95563a）', () => {
  it('B3：writeEnvLine 同步 process.env（热应用 expandEnvValues 读进程 env——只写盘会用空/旧 key）', async () => {
    const { writeEnvLine } = await import('../packages/engine/src/config-admin/onboarding-apply.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'octopi-envsync-'));
    const key = `TEST_ENV_SYNC_${Date.now()}`;
    try {
      writeEnvLine(home, `${key}=fresh-value`);
      expect(process.env[key]).toBe('fresh-value');
      writeEnvLine(home, `${key}=rotated-value`);
      expect(process.env[key]).toBe('rotated-value'); // 重跑向导换 key：新值即刻生效
    } finally {
      delete process.env[key];
      rmSync(home, { recursive: true, force: true });
    }
  });
});
