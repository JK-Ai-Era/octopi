/**
 * config-admin 纯逻辑单测：预设展开 / 脱敏 / raw 段操作 / 乐观锁 hash / 引用完整性
 */
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_MODEL_PRESETS,
  getProviderPreset,
  expandProviderPreset,
  redactSecret,
  redactProvider,
  computeConfigHash,
  getJsonPath,
  setJsonPath,
  deleteJsonPath,
  findProviderReferences,
} from '../packages/engine/src/config-admin/index.js';

describe('model presets', () => {
  it('内置清单含必需条目且结构完整', () => {
    const ids = BUILTIN_MODEL_PRESETS.map((p) => p.id);
    for (const required of ['openai', 'anthropic', 'deepseek', 'ollama', 'custom']) {
      expect(ids).toContain(required);
    }
    for (const preset of BUILTIN_MODEL_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(['openai-completions', 'anthropic-messages']).toContain(preset.api);
    }
  });

  it('expandProviderPreset 展开为 ModelProviderConfig，默认 apiKey 为 ${ENV} 引用形态', () => {
    const cfg = expandProviderPreset('openai');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.api).toBe('openai-completions');
    expect(cfg.apiKey).toBe('${OPENAI_API_KEY}');
    expect(cfg.models.length).toBeGreaterThan(0);
    expect(cfg.models[0]!.id).toBe('gpt-5.5');
  });

  it('expandProviderPreset overrides 逐字段覆盖预设默认值', () => {
    const cfg = expandProviderPreset('openai', {
      baseUrl: 'https://proxy.example.com/v1',
      models: [{ id: 'my-model' }],
    });
    expect(cfg.baseUrl).toBe('https://proxy.example.com/v1');
    expect(cfg.models).toEqual([{ id: 'my-model' }]);
    expect(cfg.apiKey).toBe('${OPENAI_API_KEY}');
  });

  it('ollama 无鉴权提示 → apiKey 空串；custom 预设不带默认 models', () => {
    expect(expandProviderPreset('ollama').apiKey).toBe('');
    expect(expandProviderPreset('custom').models).toEqual([]);
  });

  it('未知 presetId fail-loud', () => {
    expect(() => expandProviderPreset('nope')).toThrow(/unknown model preset/);
    expect(getProviderPreset('nope')).toBeUndefined();
  });
});

describe('redact', () => {
  it('redactSecret 三种形态', () => {
    expect(redactSecret(undefined)).toEqual({ configured: false, ref: null });
    expect(redactSecret('')).toEqual({ configured: false, ref: null });
    expect(redactSecret('${OPENAI_API_KEY}')).toEqual({ configured: true, ref: 'OPENAI_API_KEY' });
    expect(redactSecret('${KEY:-fallback}')).toEqual({ configured: true, ref: 'KEY' });
    expect(redactSecret('sk-super-secret')).toEqual({ configured: true, ref: 'literal' });
  });

  it('redactProvider 不泄漏明文', () => {
    const view = redactProvider('openai', {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-super-secret',
      api: 'openai-completions',
      models: [{ id: 'gpt-5.5' }],
      timeoutSeconds: 60,
    });
    expect(JSON.stringify(view)).not.toContain('sk-super-secret');
    expect(view.apiKey).toEqual({ configured: true, ref: 'literal' });
    expect(view.timeoutSeconds).toBe(60);
    expect(view.models).toHaveLength(1);
  });
});

describe('patch primitives', () => {
  it('computeConfigHash 稳定且对内容敏感', () => {
    const a = computeConfigHash('{"x":1}');
    expect(a).toBe(computeConfigHash('{"x":1}'));
    expect(a).not.toBe(computeConfigHash('{"x":2}'));
  });

  it('get/set/deleteJsonPath 基本行为', () => {
    const raw: Record<string, unknown> = { models: { providers: { openai: { apiKey: '${K}' } } }, agents: [] };
    expect(getJsonPath(raw, ['models', 'providers', 'openai', 'apiKey'])).toBe('${K}');
    expect(getJsonPath(raw, ['models', 'missing', 'deep'])).toBeUndefined();

    setJsonPath(raw, ['models', 'providers', 'openai', 'apiKey'], '${NEW}');
    expect(getJsonPath(raw, ['models', 'providers', 'openai', 'apiKey'])).toBe('${NEW}');

    setJsonPath(raw, ['models', 'providers', 'newp'], { baseUrl: 'x' });
    expect(getJsonPath(raw, ['models', 'providers', 'newp'])).toEqual({ baseUrl: 'x' });

    deleteJsonPath(raw, ['models', 'providers', 'newp']);
    expect(getJsonPath(raw, ['models', 'providers', 'newp'])).toBeUndefined();
  });

  it('deleteJsonPath 对缺失键 fail-loud', () => {
    const raw: Record<string, unknown> = { a: {} };
    expect(() => deleteJsonPath(raw, ['a', 'nope'])).toThrow(/key not found/);
    expect(() => deleteJsonPath(raw, ['nope', 'deep'])).toThrow(/path not found/);
  });

  it('setJsonPath 数组 push 与越界拒绝', () => {
    const raw: Record<string, unknown> = { list: ['a'] };
    setJsonPath(raw, ['list', 1], 'b');
    expect(getJsonPath(raw, ['list'])).toEqual(['a', 'b']);
    expect(() => setJsonPath(raw, ['list', 5], 'x')).toThrow(/index out of range/);
  });
});

describe('findProviderReferences', () => {
  it('覆盖 agents[].model 字符串 / 对象 / fallback / level 递归', () => {
    const raw: Record<string, unknown> = {
      models: {
        providers: { openai: {}, anthropic: {} },
        level: {
          standard: { primary: 'openai/gpt-5.5', fallback: ['anthropic/claude-sonnet-4-6'] },
        },
      },
      agents: [
        { id: 'assistant', model: 'openai/gpt-5.5' },
        { id: 'researcher', model: { provider: 'anthropic', model: 'claude-sonnet-4-6', fallbackModels: ['openai/gpt-5-mini'] } },
        { id: 'plain', model: 'standard' },
      ],
    };
    const hits = findProviderReferences(raw, 'openai');
    expect(hits).toContain('agents[assistant].model');
    expect(hits).toContain('agents[researcher].model.fallbackModels[0]');
    expect(hits).toContain('models.level.standard.primary');
    // 'standard' 裸名 level 递归也要命中
    expect(hits).toContain('agents[plain].model');
  });

  it('无引用返回空数组', () => {
    const raw: Record<string, unknown> = {
      models: { providers: { openai: {} } },
      agents: [{ id: 'a', model: 'openai/gpt-5.5' }],
    };
    expect(findProviderReferences(raw, 'anthropic')).toEqual([]);
  });
});
