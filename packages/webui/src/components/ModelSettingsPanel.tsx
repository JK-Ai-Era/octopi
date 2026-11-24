/**
 * ModelSettingsPanel — 模型配置面板（arch/config-hot-reload.md §6，P1）
 *
 * provider 预设卡片 → 表单预填（可改）→ 测试连通/拉取模型清单 → 保存即热生效。
 * 预设是生成器/表单默认值：保存产物是 octopi.json 标准配置，无运行时新概念。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  OctopiClient,
  type ConfigApplyResultDto,
  type ConfigModelsViewDto,
  type ModelPresetDto,
} from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, getRegistryToken } from '../console-key';
import { useT, useLang } from '../i18n/react';
import { t as tStatic } from '../i18n/core';

interface ModelRow {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: string;
  maxTokens: string;
  temperature: string;
  /** 输入模态：UI 不编辑但透传保留（防保存丢数据） */
  input?: Array<'text' | 'image' | 'audio' | 'video'>;
}

interface ProviderForm {
  name: string;
  baseUrl: string;
  /** 内置协议（插件 provider 无 api；与 plugin 二选一） */
  api?: 'openai-completions' | 'anthropic-messages';
  /** 插件 Provider 贡献 id（UI 不编辑、透传保留防保存丢数据） */
  plugin?: string;
  /** 插件旋钮（UI 不编辑、透传保留） */
  options?: Record<string, unknown>;
  apiKey: string;
  timeoutSeconds: string;
  models: ModelRow[];
  /** 当前选中的接入方式（仅新建态有意义：换方式＝重新加载预设默认值） */
  accessModeId?: string;
}

interface LevelRow {
  name: string;
  primary: string;
  fallback: string;
}

const EMPTY_FORM: ProviderForm = {
  name: '',
  baseUrl: '',
  api: 'openai-completions',
  apiKey: '',
  timeoutSeconds: '',
  models: [],
};

function modelRowFromPreset(m: ModelPresetDto['models'][number]): ModelRow {
  return {
    id: m.id,
    name: m.name,
    reasoning: m.reasoning ?? false,
    contextWindow: m.contextWindow != null ? String(m.contextWindow) : '',
    maxTokens: m.maxTokens != null ? String(m.maxTokens) : '',
    temperature: '',
    input: m.input ? [...m.input] : undefined,
  };
}

function modelRowFromUnknown(m: Record<string, unknown>): ModelRow {
  return {
    id: String(m.id ?? ''),
    name: String(m.name ?? m.id ?? ''),
    reasoning: Boolean(m.reasoning),
    contextWindow: m.contextWindow != null ? String(m.contextWindow) : '',
    maxTokens: m.maxTokens != null ? String(m.maxTokens) : '',
    temperature: m.temperature != null ? String(m.temperature) : '',
    input: Array.isArray(m.input)
      ? [...(m.input as Array<'text' | 'image' | 'audio' | 'video'>)]
      : undefined,
  };
}

/** 接入方式的本地化展示名（缺省回落 label；品牌名常两语同形） */
function modeLabel(
  lang: string,
  labels: Record<string, string> | undefined,
  fallback: string,
): string {
  if (!labels) return fallback;
  return labels[lang] ?? labels.zh ?? fallback;
}

/** 数字字段解析：空串→undefined；非数字抛错（防 NaN 落盘） */
function parseNumberField(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(tStatic('modelSettings.numberMustBeNumber', { label, value }));
  return n;
}

/** 表单 → provider 配置片段（空可选字段不落盘） */
function formToProviderConfig(form: ProviderForm): Record<string, unknown> {
  const models = form.models
    .filter((m) => m.id.trim().length > 0)
    .map((m) => {
      const entry: Record<string, unknown> = { id: m.id.trim() };
      if (m.name.trim()) entry.name = m.name.trim();
      if (m.reasoning) entry.reasoning = true;
      const contextWindow = parseNumberField(m.contextWindow, 'contextWindow');
      if (contextWindow != null) entry.contextWindow = contextWindow;
      const maxTokens = parseNumberField(m.maxTokens, 'maxTokens');
      if (maxTokens != null) entry.maxTokens = maxTokens;
      const temperature = parseNumberField(m.temperature, 'temperature');
      if (temperature != null) entry.temperature = temperature;
      if (m.input && m.input.length > 0) entry.input = [...m.input];
      return entry;
    });
  const cfg: Record<string, unknown> = {
    baseUrl: form.baseUrl.trim(),
    models,
  };
  if (form.plugin !== undefined) {
    // 插件 provider：只透传 plugin/options，不写 api（二选一契约）；UI 不编辑其旋钮
    cfg.plugin = form.plugin;
    if (form.options !== undefined) cfg.options = form.options;
  } else {
    cfg.api = form.api ?? 'openai-completions';
  }
  if (form.apiKey.trim()) cfg.apiKey = form.apiKey.trim();
  if (form.timeoutSeconds.trim()) cfg.timeoutSeconds = parseNumberField(form.timeoutSeconds, 'timeoutSeconds');
  return cfg;
}

/**
 * 向量模型表单（models.embedding）— 独立填写，不引用 provider。
 *
 * 引用 provider 的隐患：provider 一换接入方式（如 coding-plan），embedding
 * 会静默跟着换端点，而 plan 端点通常没有 /embeddings，且多数订阅额度
 * 明确禁止后端脚本调用。因此这里要求独立的 baseUrl / apiKey。
 *
 * 签名字段只用于「是否换了向量空间」的判断，变更时提示全量重建。
 */
interface EmbeddingForm {
  enabled: boolean;
  type: 'openai' | 'ollama' | 'http';
  model: string;
  baseUrl: string;
  apiKey: string;
  dimensions: string;
  maxBatchSize: string;
  timeoutMs: string;
  path: string;
  apiKeyHeader: string;
  apiKeyPrefix: string;
  vectorEngine: 'auto' | 'js' | 'sqlite-vec';
  supportsBatch: boolean;
}

const EMPTY_EMBEDDING_FORM: EmbeddingForm = {
  enabled: true,
  type: 'openai',
  model: '',
  baseUrl: '',
  apiKey: '',
  dimensions: '',
  maxBatchSize: '',
  timeoutMs: '',
  path: '',
  apiKeyHeader: '',
  apiKeyPrefix: '',
  vectorEngine: 'auto',
  supportsBatch: true,
};

/** 视图 DTO → 表单（apiKey 不回显明文，留空=保留现有） */
function embeddingFormFromView(view: ConfigModelsViewDto['embedding']): EmbeddingForm {
  if (!view) return EMPTY_EMBEDDING_FORM;
  return {
    enabled: view.enabled !== false,
    type:
      view.type === 'ollama' ? 'ollama' : view.type === 'http' || view.type === 'custom' ? 'http' : 'openai',
    model: String(view.model ?? ''),
    baseUrl: String(view.baseUrl ?? ''),
    apiKey: '',
    dimensions: view.dimensions != null ? String(view.dimensions) : '',
    maxBatchSize: view.maxBatchSize != null ? String(view.maxBatchSize) : '',
    timeoutMs: view.timeoutMs != null ? String(view.timeoutMs) : '',
    path: String(view.path ?? ''),
    apiKeyHeader: String(view.apiKeyHeader ?? ''),
    apiKeyPrefix: String(view.apiKeyPrefix ?? ''),
    vectorEngine:
      view.vectorEngine === 'js' ? 'js' : view.vectorEngine === 'sqlite-vec' ? 'sqlite-vec' : 'auto',
    supportsBatch: view.supportsBatch !== false,
  };
}

/** 表单 → 配置片段（空可选字段不落盘；apiKey 留空则整个键不写＝保留现有） */
function embeddingFormToConfig(form: EmbeddingForm): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    type: form.type,
    model: form.model.trim(),
  };
  if (!form.enabled) cfg.enabled = false;
  if (form.baseUrl.trim()) cfg.baseUrl = form.baseUrl.trim();
  if (form.apiKey.trim()) cfg.apiKey = form.apiKey.trim();
  const dimensions = parseNumberField(form.dimensions, 'dimensions');
  if (dimensions != null) cfg.dimensions = dimensions;
  const maxBatchSize = parseNumberField(form.maxBatchSize, 'maxBatchSize');
  if (maxBatchSize != null) cfg.maxBatchSize = maxBatchSize;
  const timeoutMs = parseNumberField(form.timeoutMs, 'timeoutMs');
  if (timeoutMs != null) cfg.timeoutMs = timeoutMs;
  if (form.path.trim()) cfg.path = form.path.trim();
  if (form.apiKeyHeader.trim()) cfg.apiKeyHeader = form.apiKeyHeader.trim();
  if (form.apiKeyPrefix.trim()) cfg.apiKeyPrefix = form.apiKeyPrefix.trim();
  if (form.vectorEngine !== 'auto') cfg.vectorEngine = form.vectorEngine;
  if (!form.supportsBatch) cfg.supportsBatch = false;
  return cfg;
}

/** 409 冲突（乐观锁）：文件被外部修改 → 提示并重载（#7 冲突可恢复） */
function isConflictError(err: unknown): boolean {
  return err instanceof Error && /HTTP 409/.test(err.message);
}

export function ModelSettingsPanel() {
  const t = useT();
  const [lang] = useLang();
  const client = useMemo(
    () => new OctopiClient({ baseUrl: resolveDefaultBase(), apiKey: getConsoleKey() || undefined, registryToken: getRegistryToken() || undefined }),
    [],
  );

  const [view, setView] = useState<ConfigModelsViewDto | null>(null);
  const [presets, setPresets] = useState<ModelPresetDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // provider 名；'__new__' 新建
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [levels, setLevels] = useState<LevelRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState<EmbeddingForm>(EMPTY_EMBEDDING_FORM);
  const [embeddingConfigured, setEmbeddingConfigured] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [modelsView, presetList] = await Promise.all([
        client.getConfigModels(),
        client.getModelPresets(),
      ]);
      setView(modelsView);
      setPresets(presetList);
      // 向量模型：视图为 null 表示未配置（检索走纯关键词）
      setEmbedding(embeddingFormFromView(modelsView.embedding));
      setEmbeddingConfigured(modelsView.embedding !== null);
      setLevels(
        Object.entries(modelsView.level ?? {}).map(([name, lv]) => {
          const v = lv as { primary?: string; fallback?: string[] };
          return {
            name,
            primary: v.primary ?? '',
            fallback: (v.fallback ?? []).join(', '),
          };
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const activePreset = useMemo(
    () => (selected === '__new__' ? presets.find((p) => p.id === form.name) : undefined),
    [selected, presets, form.name],
  );
  const activeMode = activePreset?.accessModes?.find((m) => m.id === (form.accessModeId ?? 'standard'));

  const selectProvider = (name: string | null) => {
    setSelected(name);
    setTestResult(null);
    setError(null);
    setNotice(null);
    if (!name) {
      setForm(EMPTY_FORM);
      return;
    }
    if (name === '__new__') {
      setForm(EMPTY_FORM);
      return;
    }
    const provider = view?.providers.find((p) => p.name === name);
    if (!provider) return;
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api === 'anthropic-messages' ? 'anthropic-messages' : provider.api === 'openai-completions' ? 'openai-completions' : undefined,
      plugin: provider.plugin,
      options: provider.options,
      apiKey: '', // 不回显明文；留空 = 保留现有值
      timeoutSeconds: provider.timeoutSeconds != null ? String(provider.timeoutSeconds) : '',
      models: provider.models.map(modelRowFromUnknown),
    });
  };

  /** 按接入方式加载预设默认值（未给字段回落 standard，规则与服务端同源） */
  const applyPresetMode = (preset: ModelPresetDto, modeId: string) => {
    const modes = preset.accessModes ?? [];
    const mode = modes.find((m) => m.id === modeId) ?? modes[0];
    const models = mode?.models ?? preset.models;
    setForm((prev) => ({
      ...prev,
      name: preset.id,
      baseUrl: mode?.baseUrl ?? preset.baseUrl,
      api: mode?.api ?? preset.api,
      apiKey: (mode?.apiKeyEnvHint ?? preset.apiKeyEnvHint)
        ? `\${${mode?.apiKeyEnvHint ?? preset.apiKeyEnvHint}}`
        : '',
      timeoutSeconds: '',
      models: models.map(modelRowFromPreset),
      accessModeId: mode?.id ?? 'standard',
    }));
  };

  const applyPreset = (preset: ModelPresetDto) => {
    const first = preset.accessModes?.[0];
    applyPresetMode(preset, first?.id ?? 'standard');
  };

  const noticeForApply = (result: ConfigApplyResultDto): string => {
    const scope =
      result.applied === 'hot'
        ? t('modelSettings.appliedHot')
        : result.affectedAgents.length > 0
          ? t('modelSettings.savedAffected', { agents: result.affectedAgents.join(', ') })
          : t('modelSettings.saved');
    return scope;
  };

  /** 写操作错误统一处理：409 冲突 → 重载最新内容让用户重新确认（乐观锁可恢复） */
  const handleWriteError = async (err: unknown): Promise<void> => {
    if (isConflictError(err)) {
      setError(t('modelSettings.conflictReloaded'));
      await reload();
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveProvider = async () => {
    if (!form.name.trim()) {
      setError(t('modelSettings.nameRequired'));
      return;
    }
    if (!form.baseUrl.trim()) {
      setError(t('modelSettings.baseUrlRequired'));
      return;
    }
    if (form.models.length === 0) {
      setError(t('modelSettings.modelsRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cfg = formToProviderConfig(form);
      // 编辑且 apiKey 留空：保留现有值（不把「空」写回）
      if (selected && selected !== '__new__' && !form.apiKey.trim()) {
        delete cfg.apiKey;
      }
      const result = await client.upsertModelProvider(form.name.trim(), cfg, view?.hash ?? '');
      setNotice(noticeForApply(result));
      setSelected(form.name.trim());
      await reload();
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = async () => {
    if (!selected || selected === '__new__') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.deleteModelProvider(selected, view?.hash ?? '');
      setNotice(noticeForApply(result));
      setSelected(null);
      setForm(EMPTY_FORM);
      await reload();
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  const testProvider = async () => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await client.testModelProvider(form.name.trim() || 'test', formToProviderConfig(form));
      if (result.ok) {
        // degraded = 端点没有模型清单接口，探测已用最小对话请求确认连通；
        // 此时 models 是「已配置清单」回填，不能说成「发现了 N 个模型」。
        setTestResult(
          result.degraded
            ? t('modelSettings.testOkDegraded')
            : t('modelSettings.testOk', { count: result.models.length }),
        );
        // 拉取式发现：未声明的模型合并进表单（已有的不动）
        setForm((prev) => {
          const known = new Set(prev.models.map((m) => m.id));
          const merged = [
            ...prev.models,
            ...result.models
              .filter((m) => !known.has(m.id))
              .map((m) => ({ id: m.id, name: m.name ?? m.id, reasoning: false, contextWindow: '', maxTokens: '', temperature: '' })),
          ];
          return { ...prev, models: merged };
        });
      } else {
        setTestResult(
          t('modelSettings.testFailed', { error: result.error ?? t('modelSettings.unknownError') }),
        );
      }
    } catch (err) {
      setTestResult(
        t('modelSettings.testFailed', { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const saveLevels = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const level: Record<string, { primary: string; fallback?: string[] }> = {};
      for (const row of levels) {
        if (!row.name.trim()) continue;
        level[row.name.trim()] = {
          primary: row.primary.trim(),
          ...(row.fallback.trim()
            ? { fallback: row.fallback.split(',').map((s) => s.trim()).filter(Boolean) }
            : {}),
        };
      }
      const result = await client.updateModelLevels(level, view?.hash ?? '');
      setNotice(noticeForApply(result));
      await reload();
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  const updateModelRow = (index: number, patch: Partial<ModelRow>) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }));
  };

  const saveEmbedding = async () => {
    if (!embedding.model.trim()) {
      setError(t('modelSettings.embeddingModelRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.updateModelEmbedding(embeddingFormToConfig(embedding), view?.hash ?? '');
      // 该接口恒返回 restart-required：不谎报已生效
      setNotice(t('modelSettings.embeddingSavedRestart'));
      await reload();
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  const clearEmbedding = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.clearModelEmbedding(view?.hash ?? '');
      setNotice(t('modelSettings.embeddingClearedRestart'));
      await reload();
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  /** embedding 字段更新（受控表单） */
  const setEmb = (patch: Partial<EmbeddingForm>) => setEmbedding((p) => ({ ...p, ...patch }));

  return (
    <div className="set-panel">
      <div className="set-header">
        <h2>{t('modelSettings.title')}</h2>
        <span className="small muted">{t('modelSettings.subtitle')}</span>
      </div>

      {error && <div className="set-error">{error}</div>}
      {notice && <div className="set-notice">{notice}</div>}

      <div className="set-body">
        <aside className="set-list">
          <button type="button" className="btn-secondary small" onClick={() => selectProvider('__new__')}>
            {t('modelSettings.newProvider')}
          </button>
          {(view?.providers ?? []).map((p) => (
            <button
              key={p.name}
              type="button"
              className={selected === p.name ? 'set-item set-item-active' : 'set-item'}
              onClick={() => selectProvider(p.name)}
            >
              <span className="mono">{p.name}</span>
              <span className="small muted">
                {t(
                  p.apiKey.configured
                    ? 'modelSettings.providerSummaryKeyed'
                    : 'modelSettings.providerSummary',
                  { count: p.models.length },
                )}
              </span>
            </button>
          ))}
        </aside>

        <section className="set-form">
          {selected === '__new__' && (
            <div className="set-presets">
              <div className="small muted">{t('modelSettings.presetHint')}</div>
              <div className="set-preset-grid">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="set-preset-card"
                    onClick={() => applyPreset(preset)}
                    title={preset.docsUrl}
                  >
                    <strong>{preset.label}</strong>
                    <span className="small muted">
                      {preset.custom
                        ? t('modelSettings.presetCustom')
                        : t('modelSettings.presetModelCount', { count: preset.models.length })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {selected && (
            <>
              {selected === '__new__' && activePreset && (activePreset.accessModes?.length ?? 0) > 1 && (
                // 接入方式：仅在确实有多种接入方式的预设上出现（单方式不占版面）
                <label className="set-field">
                  <span>{t('modelSettings.fieldAccessMode')}</span>
                  <select
                    className="set-input"
                    value={form.accessModeId ?? 'standard'}
                    onChange={(e) => applyPresetMode(activePreset, e.target.value)}
                  >
                    {activePreset.accessModes!.map((mode) => (
                      <option key={mode.id} value={mode.id}>
                        {modeLabel(lang, mode.labels, mode.label)}
                      </option>
                    ))}
                  </select>
                  {activeMode?.notes && (
                    <span className="small muted">{modeLabel(lang, activeMode.notes, '')}</span>
                  )}
                </label>
              )}
              <label className="set-field">
                <span>{t('modelSettings.fieldName')}</span>
                <input
                  className="set-input mono"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  disabled={selected !== '__new__'}
                  placeholder="openai"
                />
              </label>
              <label className="set-field">
                <span>Base URL</span>
                <input
                  className="set-input mono"
                  value={form.baseUrl}
                  onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="set-field">
                <span>{t('modelSettings.fieldProtocol')}</span>
                {form.plugin !== undefined ? (
                  // 插件 provider：协议由贡献决定，UI 不编辑；只读展示防误改
                  <input className="set-input mono" value={`plugin:${form.plugin}`} readOnly />
                ) : (
                  <select
                    className="set-input"
                    value={form.api ?? 'openai-completions'}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, api: e.target.value as ProviderForm['api'] }))
                    }
                  >
                    <option value="openai-completions">openai-completions</option>
                    <option value="anthropic-messages">anthropic-messages</option>
                  </select>
                )}
              </label>
              <label className="set-field">
                <span>API Key</span>
                <input
                  className="set-input mono"
                  value={form.apiKey}
                  onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))}
                  placeholder={
                    selected !== '__new__'
                      ? view?.providers.find((p) => p.name === selected)?.apiKey.configured
                        ? t('modelSettings.apiKeyConfiguredPlaceholder', {
                            ref:
                              view.providers.find((p) => p.name === selected)?.apiKey.ref ??
                              'literal',
                          })
                        : t('modelSettings.apiKeyUnconfiguredPlaceholder')
                      : t('modelSettings.apiKeyNewPlaceholder')
                  }
                />
              </label>
              <label className="set-field">
                <span>{t('modelSettings.fieldTimeout')}</span>
                <input
                  className="set-input"
                  value={form.timeoutSeconds}
                  onChange={(e) => setForm((p) => ({ ...p, timeoutSeconds: e.target.value }))}
                  placeholder="60"
                />
              </label>

              <div className="set-models">
                <div className="set-models-head">
                  <span>{t('modelSettings.modelList')}</span>
                  <button type="button" className="btn-secondary small" onClick={testProvider} disabled={busy}>
                    {t('modelSettings.testAndFetch')}
                  </button>
                </div>
                {testResult && <div className="small">{testResult}</div>}
                {form.models.map((m, i) => (
                  <div key={i} className="set-model-row">
                    <input
                      className="set-input mono"
                      value={m.id}
                      onChange={(e) => updateModelRow(i, { id: e.target.value })}
                      placeholder="model id"
                    />
                    <input
                      className="set-input"
                      value={m.name}
                      onChange={(e) => updateModelRow(i, { name: e.target.value })}
                      placeholder={t('modelSettings.displayNamePlaceholder')}
                    />
                    <input
                      className="set-input"
                      value={m.contextWindow}
                      onChange={(e) => updateModelRow(i, { contextWindow: e.target.value })}
                      placeholder="context"
                    />
                    <input
                      className="set-input"
                      value={m.maxTokens}
                      onChange={(e) => updateModelRow(i, { maxTokens: e.target.value })}
                      placeholder="maxTokens"
                    />
                    <label className="small">
                      <input
                        type="checkbox"
                        checked={m.reasoning}
                        onChange={(e) => updateModelRow(i, { reasoning: e.target.checked })}
                      />
                      reasoning
                    </label>
                    <button
                      type="button"
                      className="btn-ghost small"
                      onClick={() =>
                        setForm((p) => ({ ...p, models: p.models.filter((_, j) => j !== i) }))
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-ghost small"
                  onClick={() =>
                    setForm((p) => ({
                      ...p,
                      models: [...p.models, { id: '', name: '', reasoning: false, contextWindow: '', maxTokens: '', temperature: '' }],
                    }))
                  }
                >
                  {t('modelSettings.addModel')}
                </button>
              </div>

              <div className="set-actions">
                <button type="button" className="btn-secondary" onClick={saveProvider} disabled={busy}>
                  {busy ? t('modelSettings.saving') : t('modelSettings.saveAndApply')}
                </button>
                {selected !== '__new__' && presets.some((p) => p.id === selected) && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      const preset = presets.find((p) => p.id === selected);
                      if (preset) {
                        applyPreset(preset);
                        // #9 重置≠换钥：保留当前 apiKey 输入（含"留空=保留现有"语义）
                        setForm((p) => ({ ...p, name: selected ?? p.name, apiKey: p.apiKey }));
                        setNotice(
                          t('modelSettings.presetApplied', { label: preset.label }),
                        );
                      }
                    }}
                    disabled={busy}
                  >
                    {t('modelSettings.resetToPreset')}
                  </button>
                )}
                {selected !== '__new__' && (
                  <button type="button" className="btn-ghost" onClick={deleteProvider} disabled={busy}>
                    {t('modelSettings.deleteProvider')}
                  </button>
                )}
              </div>
            </>
          )}

          {!selected && <div className="small muted">{t('modelSettings.selectPrompt')}</div>}
        </section>
      </div>

      <div className="set-levels">
        <h3>{t('modelSettings.levelsTitle')}</h3>
        <div className="small muted">
          {t('modelSettings.levelsHintPrefix')}{' '}
          <span className="mono">openai/gpt-5.5</span>
          {t('modelSettings.levelsHintSuffix')}
        </div>
        {levels.map((row, i) => (
          <div key={i} className="set-level-row">
            <input
              className="set-input mono"
              value={row.name}
              onChange={(e) =>
                setLevels((prev) => prev.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
              }
              placeholder={t('modelSettings.levelNamePlaceholder')}
            />
            <input
              className="set-input mono"
              value={row.primary}
              onChange={(e) =>
                setLevels((prev) => prev.map((r, j) => (j === i ? { ...r, primary: e.target.value } : r)))
              }
              placeholder="primary: provider/model"
            />
            <input
              className="set-input mono"
              value={row.fallback}
              onChange={(e) =>
                setLevels((prev) => prev.map((r, j) => (j === i ? { ...r, fallback: e.target.value } : r)))
              }
              placeholder="fallback: provider/model, provider/model"
            />
            <button
              type="button"
              className="btn-ghost small"
              onClick={() => setLevels((prev) => prev.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="set-actions">
          <button
            type="button"
            className="btn-ghost small"
            onClick={() => setLevels((prev) => [...prev, { name: '', primary: '', fallback: '' }])}
          >
            {t('modelSettings.addLevel')}
          </button>
          <button type="button" className="btn-secondary" onClick={saveLevels} disabled={busy}>
            {t('modelSettings.saveLevels')}
          </button>
        </div>
      </div>

      {/*
        向量模型（models.embedding）：与 provider 列表并列而非塞进 provider 表单。
        语义边界是「共享能力」而非「某个 provider 的附属」——memory 与 knowledge
        共用这一份配置，且要求独立填写（引用 provider 会随接入方式切换而静默失效）。
      */}
      <div className="set-levels">
        <h3>{t('modelSettings.embeddingTitle')}</h3>
        <div className="small muted">
          {t('modelSettings.embeddingHint')}
        </div>
        {/* 用户明确要求：变更模型或参数可能导致已有向量不可比，需全量重建 */}
        <div className="set-warn">{t('modelSettings.embeddingRebuildWarning')}</div>
        {!embeddingConfigured && (
          <div className="small muted">{t('modelSettings.embeddingNotConfigured')}</div>
        )}

        <div className="set-level-row">
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={embedding.enabled}
              onChange={(e) => setEmb({ enabled: e.target.checked })}
            />
            {t('modelSettings.embeddingEnabled')}
          </label>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            {t('modelSettings.embeddingType')}
            <select
              className="set-input"
              value={embedding.type}
              onChange={(e) => setEmb({ type: e.target.value as EmbeddingForm['type'] })}
            >
              <option value="openai">openai</option>
              <option value="ollama">ollama</option>
              <option value="http">http</option>
            </select>
          </label>
        </div>

        <label className="set-field">
          <span>{t('modelSettings.embeddingModel')}</span>
          <input
            className="set-input mono"
            value={embedding.model}
            onChange={(e) => setEmb({ model: e.target.value })}
            placeholder="text-embedding-3-small / bge-m3 / qwen3.7-text-embedding"
          />
        </label>
        <label className="set-field">
          <span>Base URL</span>
          <input
            className="set-input mono"
            value={embedding.baseUrl}
            onChange={(e) => setEmb({ baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
          <span className="small muted">{t('modelSettings.embeddingBaseUrlHint')}</span>
        </label>
        <label className="set-field">
          <span>API Key</span>
          <input
            className="set-input mono"
            value={embedding.apiKey}
            onChange={(e) => setEmb({ apiKey: e.target.value })}
            placeholder={
              embeddingConfigured
                ? t('modelSettings.embeddingKeyPlaceholder')
                : t('modelSettings.apiKeyNewPlaceholder')
            }
          />
        </label>
        <label className="set-field">
          <span>{t('modelSettings.embeddingDimensions')}</span>
          <input
            className="set-input"
            value={embedding.dimensions}
            onChange={(e) => setEmb({ dimensions: e.target.value })}
            placeholder="1536"
          />
          <span className="small muted">{t('modelSettings.embeddingDimensionsHint')}</span>
        </label>
        <div className="set-level-row">
          <input
            className="set-input"
            value={embedding.maxBatchSize}
            onChange={(e) => setEmb({ maxBatchSize: e.target.value })}
            placeholder={t('modelSettings.embeddingMaxBatchPlaceholder')}
          />
          <input
            className="set-input"
            value={embedding.timeoutMs}
            onChange={(e) => setEmb({ timeoutMs: e.target.value })}
            placeholder={t('modelSettings.embeddingTimeoutPlaceholder')}
          />
          <input
            className="set-input mono"
            value={embedding.path}
            onChange={(e) => setEmb({ path: e.target.value })}
            placeholder="/embeddings"
          />
        </div>
        <label className="set-field">
          <span>{t('modelSettings.embeddingVectorEngine')}</span>
          <select
            className="set-input"
            value={embedding.vectorEngine}
            onChange={(e) => setEmb({ vectorEngine: e.target.value as EmbeddingForm['vectorEngine'] })}
          >
            <option value="auto">auto</option>
            <option value="sqlite-vec">sqlite-vec</option>
            <option value="js">js</option>
          </select>
          <span className="small muted">{t('modelSettings.embeddingVectorEngineHint')}</span>
        </label>

        <div className="set-actions">
          <button type="button" className="btn-secondary" onClick={saveEmbedding} disabled={busy}>
            {busy ? t('modelSettings.saving') : t('modelSettings.saveAndRestart')}
          </button>
          {embeddingConfigured && (
            <button type="button" className="btn-ghost" onClick={clearEmbedding} disabled={busy}>
              {t('modelSettings.embeddingClear')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
