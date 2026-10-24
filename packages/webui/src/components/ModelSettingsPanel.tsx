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

interface ModelRow {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: string;
  maxTokens: string;
  /** 输入模态：UI 不编辑但透传保留（防保存丢数据） */
  input?: Array<'text' | 'image' | 'audio' | 'video'>;
}

interface ProviderForm {
  name: string;
  baseUrl: string;
  api: 'openai-completions' | 'anthropic-messages';
  apiKey: string;
  timeoutSeconds: string;
  models: ModelRow[];
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
    input: Array.isArray(m.input)
      ? [...(m.input as Array<'text' | 'image' | 'audio' | 'video'>)]
      : undefined,
  };
}

/** 数字字段解析：空串→undefined；非数字抛错（防 NaN 落盘） */
function parseNumberField(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} 必须是数字：${value}`);
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
      if (m.input && m.input.length > 0) entry.input = [...m.input];
      return entry;
    });
  const cfg: Record<string, unknown> = {
    baseUrl: form.baseUrl.trim(),
    api: form.api,
    models,
  };
  if (form.apiKey.trim()) cfg.apiKey = form.apiKey.trim();
  if (form.timeoutSeconds.trim()) cfg.timeoutSeconds = parseNumberField(form.timeoutSeconds, 'timeoutSeconds');
  return cfg;
}

/** 409 冲突（乐观锁）：文件被外部修改 → 提示并重载（#7 冲突可恢复） */
function isConflictError(err: unknown): boolean {
  return err instanceof Error && /HTTP 409/.test(err.message);
}

export function ModelSettingsPanel() {
  const client = useMemo(() => new OctopiClient({ baseUrl: resolveDefaultBase() }), []);

  const [view, setView] = useState<ConfigModelsViewDto | null>(null);
  const [presets, setPresets] = useState<ModelPresetDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // provider 名；'__new__' 新建
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [levels, setLevels] = useState<LevelRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [modelsView, presetList] = await Promise.all([
        client.getConfigModels(),
        client.getModelPresets(),
      ]);
      setView(modelsView);
      setPresets(presetList);
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
      api: provider.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
      apiKey: '', // 不回显明文；留空 = 保留现有值
      timeoutSeconds: provider.timeoutSeconds != null ? String(provider.timeoutSeconds) : '',
      models: provider.models.map(modelRowFromUnknown),
    });
  };

  const applyPreset = (preset: ModelPresetDto) => {
    setForm({
      name: preset.id,
      baseUrl: preset.baseUrl,
      api: preset.api,
      apiKey: preset.apiKeyEnvHint ? `\${${preset.apiKeyEnvHint}}` : '',
      timeoutSeconds: '',
      models: preset.models.map(modelRowFromPreset),
    });
  };

  const noticeForApply = (result: ConfigApplyResultDto): string => {
    const scope =
      result.applied === 'hot'
        ? '立即生效'
        : result.affectedAgents.length > 0
          ? `已保存，新会话生效（影响 ${result.affectedAgents.join(', ')}）`
          : '已保存，新会话生效';
    return scope;
  };

  /** 写操作错误统一处理：409 冲突 → 重载最新内容让用户重新确认（乐观锁可恢复） */
  const handleWriteError = async (err: unknown): Promise<void> => {
    if (isConflictError(err)) {
      setError('配置已被外部修改，已重新载入最新内容——请重新确认你的修改再保存');
      await reload();
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveProvider = async () => {
    if (!form.name.trim()) {
      setError('provider 名不能为空');
      return;
    }
    if (!form.baseUrl.trim()) {
      setError('baseUrl 不能为空');
      return;
    }
    if (form.models.length === 0) {
      setError('至少配置一个模型（或点「拉取模型列表」自动填充）');
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
        setTestResult(`✓ 连通成功，发现 ${result.models.length} 个模型`);
        // 拉取式发现：未声明的模型合并进表单（已有的不动）
        setForm((prev) => {
          const known = new Set(prev.models.map((m) => m.id));
          const merged = [
            ...prev.models,
            ...result.models
              .filter((m) => !known.has(m.id))
              .map((m) => ({ id: m.id, name: m.name ?? m.id, reasoning: false, contextWindow: '', maxTokens: '' })),
          ];
          return { ...prev, models: merged };
        });
      } else {
        setTestResult(`✗ 连通失败：${result.error ?? '未知错误'}`);
      }
    } catch (err) {
      setTestResult(`✗ 连通失败：${err instanceof Error ? err.message : String(err)}`);
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

  return (
    <div className="set-panel">
      <div className="set-header">
        <h2>模型配置</h2>
        <span className="small muted">
          保存即生效（新会话用新配置）· apiKey 不回显明文 · 修改会自动备份 octopi.json
        </span>
      </div>

      {error && <div className="set-error">{error}</div>}
      {notice && <div className="set-notice">{notice}</div>}

      <div className="set-body">
        <aside className="set-list">
          <button type="button" className="btn-secondary small" onClick={() => selectProvider('__new__')}>
            + 新建 provider
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
                {p.models.length} 模型{p.apiKey.configured ? ' · key ✓' : ''}
              </span>
            </button>
          ))}
        </aside>

        <section className="set-form">
          {selected === '__new__' && (
            <div className="set-presets">
              <div className="small muted">选择预设快速填充（生成器：可改后保存）：</div>
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
                    <span className="small muted">{preset.custom ? '自定义' : `${preset.models.length} 预置模型`}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {selected && (
            <>
              <label className="set-field">
                <span>名称</span>
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
                <span>API 协议</span>
                <select
                  className="set-input"
                  value={form.api}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, api: e.target.value as ProviderForm['api'] }))
                  }
                >
                  <option value="openai-completions">openai-completions</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                </select>
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
                        ? `已配置（${view.providers.find((p) => p.name === selected)?.apiKey.ref ?? 'literal'}），留空保留`
                        : '未配置；建议用 ${ENV_VAR} 引用'
                      : '建议用 ${ENV_VAR} 引用；也可填明文'
                  }
                />
              </label>
              <label className="set-field">
                <span>超时（秒，可选）</span>
                <input
                  className="set-input"
                  value={form.timeoutSeconds}
                  onChange={(e) => setForm((p) => ({ ...p, timeoutSeconds: e.target.value }))}
                  placeholder="60"
                />
              </label>

              <div className="set-models">
                <div className="set-models-head">
                  <span>模型清单</span>
                  <button type="button" className="btn-secondary small" onClick={testProvider} disabled={busy}>
                    测试连通并拉取模型列表
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
                      placeholder="展示名"
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
                      models: [...p.models, { id: '', name: '', reasoning: false, contextWindow: '', maxTokens: '' }],
                    }))
                  }
                >
                  + 添加模型
                </button>
              </div>

              <div className="set-actions">
                <button type="button" className="btn-secondary" onClick={saveProvider} disabled={busy}>
                  {busy ? '保存中…' : '保存并生效'}
                </button>
                {selected !== '__new__' && (
                  <button type="button" className="btn-ghost" onClick={deleteProvider} disabled={busy}>
                    删除 provider
                  </button>
                )}
              </div>
            </>
          )}

          {!selected && <div className="small muted">选择左侧 provider 编辑，或新建。</div>}
        </section>
      </div>

      <div className="set-levels">
        <h3>模型分级路由（models.level）</h3>
        <div className="small muted">
          供 agent 默认模型按档位解析；primary 形如 <span className="mono">openai/gpt-5.5</span>，fallback 逗号分隔。
        </div>
        {levels.map((row, i) => (
          <div key={i} className="set-level-row">
            <input
              className="set-input mono"
              value={row.name}
              onChange={(e) =>
                setLevels((prev) => prev.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
              }
              placeholder="level 名（如 standard）"
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
            + 添加 level
          </button>
          <button type="button" className="btn-secondary" onClick={saveLevels} disabled={busy}>
            保存 level（立即生效）
          </button>
        </div>
      </div>
    </div>
  );
}
