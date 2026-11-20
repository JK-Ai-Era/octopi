/**
 * Onboarding 向导核心与 CLI 渲染器纯逻辑回归（批 1-7）。
 *
 * 覆盖：九步校验链 / 配置组装（${VAR} 占位、模型档）/ key 环境变量名 /
 * 探针错误四类归并 / .env 写入（0600、同名替换）/ octopi.json 片段合入。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOYMENT_MODES,
  ONBOARDING_STEPS,
  apiKeyEnvVar,
  assembleOnboarding,
  pickLang,
  validateStep,
} from '../packages/engine/src/config-admin/onboarding.js';
import { initialOnboardingState, nextStep, mergeOnboardingChoices } from '../packages/engine/src/config-admin/onboarding.js';
import { getProviderPreset } from '../packages/engine/src/config-admin/model-presets.js';
import { MIN_ADMIN_PASSWORD_LENGTH } from '../packages/engine/src/config-admin/password-policy.js';
import type { OnboardingChoices } from '../packages/engine/src/config-admin/onboarding.js';
import { classifyProbeError, mergeConfigFragment, writeEnvLine } from '../packages/engine/src/config-admin/onboarding-apply.js';
import { expectRestrictedToOwner } from './helpers/file-mode.js';

function baseChoices(overrides: Partial<OnboardingChoices> = {}): OnboardingChoices {
  return {
    lang: 'zh',
    initMode: 'cli',
    deploymentMode: 'personal',
    providerId: 'deepseek',
    apiKey: 'sk-test-123',
    modelId: 'deepseek-flash',
    ...overrides,
  };
}

describe('onboarding 核心状态机', () => {
  it('九步步骤序固定（welcome→…→first-chat）', () => {
    expect(ONBOARDING_STEPS).toEqual([
      'welcome',
      'init-mode',
      'deployment-mode',
      'provider',
      'api-key',
      'model',
      'probe',
      'services',
      'first-chat',
    ]);
  });

  it('部署模式三选带产品语言描述（组织内共享知识库口径）', () => {
    expect(DEPLOYMENT_MODES.map((m) => m.id)).toEqual(['personal', 'organization', 'multi-organization']);
    const org = DEPLOYMENT_MODES[1];
    expect(pickLang(org.descriptions, '', 'zh')).toContain('共享知识库');
    expect(pickLang(org.labels, '', 'en')).toBe('Organization');
  });

  it('校验链：api-key 对免 key 预设放行、对需 key 预设缺 key 报错', () => {
    expect(validateStep('api-key', baseChoices({ providerId: 'ollama', apiKey: '' }))).toBe('');
    const err = validateStep('api-key', baseChoices({ apiKey: '' }));
    expect(err).toContain('API Key');
  });

  it('校验链：model 缺失报错（双语随 lang）', () => {
    expect(validateStep('model', baseChoices({ modelId: '' }))).toContain('模型');
    expect(validateStep('model', baseChoices({ modelId: '', lang: 'en' }))).toContain('model');
  });

  it('assembleOnboarding：apiKey 落 ${VAR} 占位（绝不明文），模型档位与 language/deploymentMode 同落', () => {
    const out = assembleOnboarding(baseChoices());
    expect(out.envLines).toEqual(['DEEPSEEK_API_KEY=sk-test-123']);
    const provider = out.configFragment.providers.deepseek as { apiKey?: string; models: Array<{ id: string }> };
    expect(provider.apiKey).toBe('${DEEPSEEK_API_KEY}');
    // 明文 key 只允许出现在 envLines（.env 落盘行），绝不进配置面
    expect(JSON.stringify(out.configFragment)).not.toContain('sk-test-123');
    expect(provider.models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']); // 目录全量落配置
    expect(out.configFragment.language).toBe('zh');
    expect(out.configFragment.deploymentMode).toBe('personal');
  });

  it('assembleOnboarding：目录全量落配置，手填 id 追加；所选模型只接线 levels/agentModel', () => {
    const out = assembleOnboarding(baseChoices({ modelId: 'deepseek-v4-pro' }));
    const provider = out.configFragment.providers.deepseek as { models: Array<{ id: string; contextWindow?: number }> };
    expect(provider.models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    // 参考参数随目录行落盘（断言与目录同源，避免厂商刷新数值时再改测试）
    expect(provider.models[1].contextWindow).toBe(getProviderPreset('deepseek')!.models[1]!.contextWindow);
    expect(out.configFragment.agentModel).toBe('deepseek/deepseek-v4-pro');
    expect(out.configFragment.levels).toEqual({
      mini: { primary: 'deepseek/deepseek-v4-pro' },
      standard: { primary: 'deepseek/deepseek-v4-pro' },
      pro: { primary: 'deepseek/deepseek-v4-pro' },
    });

    const typed = assembleOnboarding(baseChoices({ modelId: 'my-custom-model' }));
    const p2 = typed.configFragment.providers.deepseek as { models: Array<{ id: string }> };
    expect(p2.models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro', 'my-custom-model']);
    expect(typed.configFragment.agentModel).toBe('deepseek/my-custom-model');
  });

  it('assembleOnboarding：免 key 预设无 env 行、无 apiKey 引用', () => {
    const out = assembleOnboarding(baseChoices({ providerId: 'ollama', apiKey: '' }));
    expect(out.envLines).toEqual([]);
    const provider = out.configFragment.providers.ollama as { apiKey?: string };
    expect(provider.apiKey ?? '').toBe(''); // 空或缺省皆可，绝不能是 ${VAR} 引用
  });

  it('apiKeyEnvVar：未知预设 fail-loud', () => {
    expect(apiKeyEnvVar('deepseek')).toBe('DEEPSEEK_API_KEY');
    expect(apiKeyEnvVar('ollama')).toBe('');
    expect(() => apiKeyEnvVar('nope')).toThrow(/unknown provider preset/);
  });
});

describe('探针错误四类归并（§5 映射）', () => {
  it('auth：401/403/key 类', () => {
    expect(classifyProbeError(new Error('401 Unauthorized'))).toBe('auth');
    expect(classifyProbeError(new Error('invalid api key'))).toBe('auth');
    expect(classifyProbeError(new Error('403 Forbidden'))).toBe('auth');
  });
  it('network：DNS/连接/超时类', () => {
    expect(classifyProbeError(new Error('fetch failed'))).toBe('network');
    expect(classifyProbeError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe('network');
    expect(classifyProbeError(new Error('getaddrinfo ENOTFOUND api.x'))).toBe('network');
  });
  it('model：模型不存在类', () => {
    expect(classifyProbeError(new Error('model not found: qwen9'))).toBe('model');
    expect(classifyProbeError(new Error('404 unknown model'))).toBe('model');
  });
  it('server：其余', () => {
    expect(classifyProbeError(new Error('502 bad gateway'))).toBe('server');
    expect(classifyProbeError(new Error('boom'))).toBe('server');
  });
});

describe('落盘动作', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'octopi-onb-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('writeEnvLine：同名键替换、异名保留', () => {
    writeEnvLine(home, 'A_KEY=one');
    writeEnvLine(home, 'B_KEY=two');
    writeEnvLine(home, 'A_KEY=updated');
    const text = readFileSync(join(home, '.env'), 'utf8');
    expect(text).toContain('A_KEY=updated');
    expect(text).toContain('B_KEY=two');
    expect(text).not.toContain('A_KEY=one');
  });

  it('writeEnvLine：.env 收紧到仅当前用户可读（两平台真跑：POSIX 断位、Windows 断 ACL）', () => {
    writeEnvLine(home, 'A_KEY=one');
    expectRestrictedToOwner(join(home, '.env'), 'file');
  });

  it('mergeConfigFragment：providers 合并不覆盖既有、language/deploymentMode 落顶层', () => {
    const configPath = join(home, 'octopi.json');
    writeFileSync(
      configPath,
      JSON.stringify({ models: { providers: { openai: { api: 'openai-completions', baseUrl: 'https://x/v1', models: [{ id: 'gpt-test' }] } } }, agents: [{ id: 'default', model: 'openai/gpt-test' }] }),
      'utf8',
    );
    const out = assembleOnboarding(baseChoices());
    mergeConfigFragment(configPath, out, () => {}); // 校验器由套件层注入（M2）；本用例测合并语义
    const merged = JSON.parse(readFileSync(configPath, 'utf8')) as {
      language: string;
      deploymentMode: string;
      models: { providers: Record<string, unknown> };
      agents: unknown[];
    };
    expect(merged.language).toBe('zh');
    expect(merged.deploymentMode).toBe('personal');
    expect(Object.keys(merged.models.providers).sort()).toEqual(['deepseek', 'openai']);
    expect(merged.agents).toHaveLength(1); // 既有 agents 不动
  });

  it('writeEnvLine：已存在宽松权限的 .env 会被收紧到仅当前用户可读', () => {
    const envPath = join(home, '.env');
    writeFileSync(envPath, 'K=v\n', { mode: 0o644 });
    chmodSync(envPath, 0o644);
    writeEnvLine(home, 'K=v2');
    expectRestrictedToOwner(envPath, 'file');
  });
});

describe('评审回归锚（del-20f0cd79）', () => {
  it('B-4：配置损坏（JSON 语法错）不得被空对象覆盖——mergeConfigFragment 必须抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-corrupt-'));
    const configPath = join(dir, 'octopi.json');
    writeFileSync(configPath, '{ broken json');
    const out = { configFragment: {}, envLines: [] } as never;
    expect(() => mergeConfigFragment(configPath, out, () => {})).toThrow();
    expect(readFileSync(configPath, 'utf8')).toBe('{ broken json'); // 原文未被覆盖
    rmSync(dir, { recursive: true, force: true });
  });

  it('MINOR-2：goto 非法目标忽略（状态不变）；goto 自身不压栈', () => {
    let st = initialOnboardingState('welcome');
    const bad = nextStep(st, { kind: 'goto', step: 'nope' as never });
    expect(bad.state.current).toBe('welcome');
    const self = nextStep(st, { kind: 'goto', step: 'welcome' });
    expect(self.state.stack).toHaveLength(0); // 自身不压栈
  });

  it('MINOR-1：mergeOnboardingChoices 白名单——未知键不进 choices', () => {
    const base = { lang: 'zh', initMode: 'web', deploymentMode: 'personal', providerId: 'x', modelId: 'm' } as never;
    const merged = mergeOnboardingChoices(base, { evil: 1, providerId: 'y' } as never) as unknown as Record<string, unknown>;
    expect(merged.evil).toBeUndefined();
    expect(merged.providerId).toBe('y');
  });

  describe('模式切换的字段清理（真机复现的两个静默副作用）', () => {
    it('切回 personal（本机）丢弃残留密码/组织名——不静默给 default 用户设密码', () => {
      const base = baseChoices({
        deploymentMode: 'organization',
        adminPassword: 'S3cret!pw',
        orgName: 'acme',
      });
      const merged = mergeOnboardingChoices(base, { deploymentMode: 'personal' });
      expect(merged.adminPassword).toBeUndefined();
      expect(merged.orgName).toBeUndefined();
      expect(merged.deploymentMode).toBe('personal');
    });

    it('需要密码时不清（个人+远程绑定 / ②③）——否则刚输入的密码被抹掉', () => {
      const base = baseChoices({ deploymentMode: 'personal' });
      const merged = mergeOnboardingChoices(
        base,
        { adminPassword: 'S3cret!pw' },
        { adminPasswordRequired: true },
      );
      expect(merged.adminPassword).toBe('S3cret!pw');
    });

    it('provider 变更清空 modelId（旧 provider 的模型名不得带进新 provider）', () => {
      const base = baseChoices({ providerId: 'openai', modelId: 'gpt-6.1-terra' });
      const merged = mergeOnboardingChoices(base, { providerId: 'deepseek' });
      expect(merged.modelId).toBe('');
      expect(merged.providerId).toBe('deepseek');
    });

    it('provider 未变但显式给了 modelId 时保留该值', () => {
      const base = baseChoices({ providerId: 'deepseek', modelId: 'deepseek-flash' });
      const merged = mergeOnboardingChoices(base, { modelId: 'deepseek-v4-pro' });
      expect(merged.modelId).toBe('deepseek-v4-pro');
    });
  });

  describe('deployment-mode 校验（本步就拦住无效状态）', () => {
    it('组织模式缺密码 → 报出（不再等到第 7 步才爆）', () => {
      const err = validateStep('deployment-mode', baseChoices({ deploymentMode: 'organization' }));
      expect(err).toContain('admin');
    });

    it('组织模式密码短于下限 → 报出（文案与实现同一常量）', () => {
      const err = validateStep(
        'deployment-mode',
        baseChoices({ deploymentMode: 'organization', adminPassword: 'short' }),
      );
      expect(err).toContain(String(MIN_ADMIN_PASSWORD_LENGTH));
    });

    it('组织模式密码合格 → 通过；个人模式无密码 → 通过', () => {
      expect(
        validateStep(
          'deployment-mode',
          baseChoices({ deploymentMode: 'organization', adminPassword: 'S3cret!pw' }),
        ),
      ).toBe('');
      expect(validateStep('deployment-mode', baseChoices({ deploymentMode: 'personal' }))).toBe('');
    });

    it('多组织模式缺组织名 → 报出', () => {
      const err = validateStep(
        'deployment-mode',
        baseChoices({ deploymentMode: 'multi-organization', adminPassword: 'S3cret!pw' }),
      );
      expect(err).toContain('组织');
    });
  });
});
