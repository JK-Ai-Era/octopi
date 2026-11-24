/**
 * config-admin 纯逻辑单测：预设展开 / 脱敏 / raw 段操作 / 乐观锁 hash / 引用完整性
 */
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_MODEL_PRESETS,
  BUILTIN_AGENT_ROLE_PRESETS,
  getProviderPreset,
  getProviderAccessMode,
  listProviderAccessModes,
  resolvePresetMode,
  getAgentRolePreset,
  renderAgentRole,
  renderRolePreset,
  expandProviderPreset,
  redactSecret,
  redactProvider,
  computeConfigHash,
  getJsonPath,
  setJsonPath,
  deleteJsonPath,
  findProviderReferences,
} from '../packages/engine/src/config-admin/index.js';
import { ModelProviderConfigSchemaExport } from '../packages/engine/src/config-schema/models.js';

describe('model presets', () => {
  it('接入方式：标准 API 恒为第一项，且与顶层字段一致', () => {
    for (const preset of BUILTIN_MODEL_PRESETS) {
      const modes = listProviderAccessModes(preset);
      expect(modes[0]!.id).toBe('standard');
      expect(modes[0]!.baseUrl).toBe(preset.baseUrl);
      expect(modes[0]!.api).toBe(preset.api);
      // id 唯一：UI 的下拉依赖它作为 React key 与选择值
      expect(new Set(modes.map((m) => m.id)).size).toBe(modes.length);
    }
  });

  it('接入方式：未给字段回落标准 API（models / apiKeyEnvHint / docsUrl）', () => {
    const preset = getProviderPreset('mimo')!;
    // token-plan 没写 models → 用顶层清单，不复制一份
    const resolved = resolvePresetMode(preset, 'token-plan');
    expect(resolved.models).toBe(preset.models);
    expect(resolved.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    // 套餐 key 与按量 key 不通用 → 该条自带 apiKeyEnvHint；未自带的条目才回落
    expect(resolved.apiKeyEnvHint).toBe('MIMO_TOKEN_PLAN_API_KEY');

    const standard = resolvePresetMode(preset);
    expect(standard.apiKeyEnvHint).toBe('MIMO_API_KEY');
    expect(standard.models).toBe(preset.models);
  });

  it('接入方式：认准每个已登记端点的协议与 baseUrl', () => {
    expect(getProviderAccessMode('doubao', 'agent-plan')).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
    });
    expect(getProviderAccessMode('doubao', 'coding-plan')).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    });
    // Coding Plan 的 key 与按量通用 → 不另设 env 变量（回落标准 key）
    expect(getProviderAccessMode('doubao', 'coding-plan')?.apiKeyEnvHint).toBeUndefined();
    // Agent Plan 的 key 是专属的
    expect(getProviderAccessMode('doubao', 'agent-plan')?.apiKeyEnvHint).toBe('ARK_AGENT_PLAN_API_KEY');
    // Step Plan 的 Anthropic baseUrl 刻意不带 /v1（客户端自拼 /v1/messages）
    expect(getProviderAccessMode('stepfun', 'step-plan-anthropic')?.baseUrl).toBe(
      'https://api.stepfun.com/step_plan',
    );
    expect(getProviderAccessMode('qwen', 'coding-plan')).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    });
    expect(getProviderAccessMode('mimo', 'token-plan-anthropic')).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    });
  });

  it('接入方式：订阅型条目都带计费/限制说明（防用户拿套餐端点做自动化）', () => {
    for (const preset of BUILTIN_MODEL_PRESETS) {
      for (const mode of preset.modes ?? []) {
        const isSubscription = /plan|token-plan|coding/i.test(mode.id)
          && mode.apiKeyEnvHint !== undefined
          && mode.apiKeyEnvHint !== preset.apiKeyEnvHint;
        if (isSubscription) {
          expect(mode.notes, `${preset.id}/${mode.id} 缺 notes`).toBeDefined();
        }
      }
    }
  });

  it('接入方式：未知 modeId fail-loud，不静默回落标准 API', () => {
    const preset = getProviderPreset('mimo')!;
    expect(() => resolvePresetMode(preset, 'nope')).toThrow(/unknown access mode/);
    expect(() => getProviderAccessMode('mimo', 'nope')).toThrow(/unknown access mode/);
  });

  it('接入方式：expandProviderPreset 按 mode 产出 baseUrl/api/models', () => {
    const cfg = expandProviderPreset('doubao', undefined, { modeId: 'agent-plan' });
    expect(cfg.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/plan');
    expect(cfg.api).toBe('anthropic-messages');
    expect(cfg.models.length).toBe(getProviderPreset('doubao')!.models.length);

    // 不传 modeId 时与改造前完全一致（向后兼容）
    const standard = expandProviderPreset('doubao');
    expect(standard.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(standard.api).toBe('openai-completions');
  });

  it('接入方式：每条的 baseUrl 非空且协议合法（防登记半截条目）', () => {
    for (const preset of BUILTIN_MODEL_PRESETS) {
      for (const mode of preset.modes ?? []) {
        expect(mode.baseUrl.length, `${preset.id}/${mode.id}`).toBeGreaterThan(0);
        expect(['openai-completions', 'anthropic-messages']).toContain(mode.api);
        expect(mode.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('接入方式：每种接入方式展开后都能过 config-schema（防「写得出但落盘失败」）', () => {
    // 用与运行时同一份 schema：预设条目只要有一条通不过，用户选它就会在保存时失败
    for (const preset of BUILTIN_MODEL_PRESETS) {
      for (const mode of listProviderAccessModes(preset)) {
        const cfg = expandProviderPreset(preset.id, undefined, { modeId: mode.id });
        // custom 是唯一已知例外：它是空模板（baseUrl/model 由用户填），
        // 两个消费方（向导 / 设置面板）保存前都会拦空值。
        if (preset.custom) {
          expect(cfg.baseUrl).toBe('');
          expect(cfg.models).toEqual([]);
          continue;
        }
        const result = ModelProviderConfigSchemaExport.safeParse(cfg);
        expect(
          result.success,
          `${preset.id}/${mode.id}: ${result.success ? '' : result.error.issues.map((i) => i.message).join('; ')}`,
        ).toBe(true);
      }
    }
  });

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
    expect(cfg.models[0]!.id).toBe('gpt-6.2-astra');
  });

  it('预设表结构不变量：id 唯一、非 custom 至少一条模型、条目 id 唯一且参数为正', () => {
    const ids = BUILTIN_MODEL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const preset of BUILTIN_MODEL_PRESETS) {
      if (preset.custom) {
        expect(preset.models).toEqual([]);
        continue;
      }
      // config-schema 要求 provider.models 至少 1 条（ModelProviderConfigSchema.models.min(1)）
      expect(preset.models.length).toBeGreaterThan(0);
      expect(preset.baseUrl.length).toBeGreaterThan(0);

      const modelIds = preset.models.map((m) => m.id);
      expect(new Set(modelIds).size).toBe(modelIds.length);

      for (const m of preset.models) {
        expect(m.id.length).toBeGreaterThan(0);
        expect(m.name.length).toBeGreaterThan(0);
        if (m.contextWindow !== undefined) expect(m.contextWindow).toBeGreaterThan(0);
        if (m.maxTokens !== undefined) expect(m.maxTokens).toBeGreaterThan(0);
        for (const modality of m.input ?? []) {
          expect(['text', 'image', 'audio', 'video']).toContain(modality);
        }
      }
    }
  });

  it('未公布逐模型输出上限的厂商不填估算 maxTokens', () => {
    for (const id of ['xai', 'mistral', 'ollama', 'siliconflow']) {
      const preset = getProviderPreset(id);
      expect(preset).toBeDefined();
      for (const m of preset!.models) {
        expect(m.maxTokens).toBeUndefined();
      }
    }
  });

  it('maxTokens 必须小于 contextWindow（否则输出预留吃光窗口，分配器判 infeasible）', () => {
    for (const preset of BUILTIN_MODEL_PRESETS) {
      for (const m of preset.models) {
        if (m.maxTokens === undefined || m.contextWindow === undefined) continue;
        expect(m.maxTokens, `${preset.id}/${m.id}`).toBeLessThan(m.contextWindow);
      }
    }
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

describe('agent role presets', () => {
  it('内置角色清单完整（6 角色，四件套 + 插槽 + 双语 + 安全组推荐）', () => {
    const ids = BUILTIN_AGENT_ROLE_PRESETS.map((p) => p.id);
    for (const required of ['general', 'researcher', 'coder', 'reviewer', 'writer', 'analyst']) {
      expect(ids).toContain(required);
    }
    for (const preset of BUILTIN_AGENT_ROLE_PRESETS) {
      // 四件套：AGENTS.md + 10-soul + 20-identity + 30-user（拍板 2026-11-21）
      expect(preset.template).toContain('{{agentName}}');
      const files = (preset.personaFiles ?? []).map((f) => f.file);
      expect(files).toEqual(expect.arrayContaining(['10-soul.md', '20-identity.md', '30-user.md']));
      // 插槽散布在四件套里（AGENTS.md 不再包揽身份内容）
      const whole = preset.template + JSON.stringify(preset.personaFiles ?? []);
      expect(whole).toContain('{{agentName}}');
      expect(whole).toContain('{{addressToUser}}');
      // 双语：zh 基准 + en 覆盖
      expect(preset.templates?.en).toBeTruthy();
      for (const f of preset.personaFiles ?? []) {
        expect(f.content).toBeTruthy();
        expect(f.contents?.en).toBeTruthy();
      }
      expect(['workspace', 'project', 'host', 'untrusted']).toContain(preset.recommendedEffectMode);
    }
    // 安全组推荐按角色风险分层（coder 动代码 → project；其余只读/文字 → workspace）
    expect(getAgentRolePreset('coder')!.recommendedEffectMode).toBe('project');
    expect(getAgentRolePreset('researcher')!.recommendedEffectMode).toBe('workspace');
  });

  it('renderAgentRole 插槽渲染：无残留插槽 + 推荐默认值透出', () => {
    const rendered = renderAgentRole('coder', { agentName: '小工', addressToUser: '大哥' });
    expect(rendered.agentsMd).toContain('小工');
    expect(rendered.agentsMd).toContain('大哥');
    expect(rendered.agentsMd).not.toContain('{{');
    expect(rendered.recommendedEffectMode).toBe('project');
    expect(rendered.recommendedModelLevel).toBe('pro');
    expect(rendered.recommendedTraits).toContain('engineering');
    // persona 补充件同样填槽
    for (const f of rendered.personaFiles) {
      expect(f.content).not.toContain('{{');
    }
  });

  it('renderAgentRole 双语：缺省 zh 基准，lang=en 产出英文四件套', () => {
    const zh = renderAgentRole('general', { agentName: '助手', addressToUser: '你' });
    expect(zh.agentsMd).toContain('工作方式');
    expect(zh.personaFiles.find((f) => f.file === '10-soul.md')!.content).toContain('人格定义');

    const en = renderAgentRole('general', { agentName: 'Assistant', addressToUser: 'you' }, 'en');
    expect(en.agentsMd).toContain('Operating Instructions');
    expect(en.agentsMd).not.toContain('工作方式');
    const soul = en.personaFiles.find((f) => f.file === '10-soul.md')!;
    expect(soul.content).toContain('Agent Persona');
    const user = en.personaFiles.find((f) => f.file === '30-user.md')!;
    expect(user.content).toContain('you');
    for (const f of en.personaFiles) expect(f.content).not.toContain('{{');
  });

  it('自定义模板缺 en 覆盖时回落 zh 基准；插槽一律填 trim 后的值', () => {
    const custom = {
      id: 'custom',
      label: '自定义',
      description: '',
      template: '# AGENTS.md — {{agentName}}\n\n中文基准 {{addressToUser}}',
      recommendedEffectMode: 'workspace' as const,
    };
    const en = renderRolePreset(custom, { agentName: '  bot  ', addressToUser: ' 大哥 ' }, 'en');
    // 缺译回落：无 templates.en → 用 zh 基准（不因 lang=en 抛错或产出空文）
    expect(en.agentsMd).toContain('中文基准');
    // trim 后填槽：标题无前后空白
    expect(en.agentsMd).toContain('# AGENTS.md — bot');
    expect(en.agentsMd).not.toContain('  bot  ');
  });

  it('未知角色 / 空插槽 fail-loud', () => {
    expect(() => renderAgentRole('nope', { agentName: 'x', addressToUser: 'y' })).toThrow(
      /unknown agent role preset/,
    );
    expect(() => renderAgentRole('general', { agentName: '', addressToUser: 'y' })).toThrow(/agentName/);
    expect(() => renderAgentRole('general', { agentName: 'x', addressToUser: '  ' })).toThrow(/addressToUser/);
    expect(getAgentRolePreset('nope')).toBeUndefined();
  });
});
