/**
 * AgentSettingsPanel — agent 配置面板（arch/config-hot-reload.md §6，P2）
 *
 * 新建向导（角色模板生成器：选角色 → 填名字/称谓 → 预览可编辑 → 选安全组/模型）
 * + 详情编辑（persona / 模型 / 安全组四选一 / tools / traits）+ persona 编辑器。
 * 保存即热生效（新 run 用新构建）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  OctopiClient,
  type AgentRolePresetDto,
  type ConfigAgentsViewDto,
} from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey } from '../console-key';

type EffectMode = 'workspace' | 'project' | 'host' | 'untrusted';

/** 安全组四选一卡片文案（与 arch/tool-effect-policy.md 运行模式对齐） */
const EFFECT_MODE_CARDS: Array<{ mode: EffectMode; label: string; desc: string; risk: string }> = [
  {
    mode: 'workspace',
    label: 'workspace（严格工作空间）',
    desc: '工具效果限于 agent workspace；shell 默认拒绝。',
    risk: '最低权限',
  },
  {
    mode: 'project',
    label: 'project（项目树）',
    desc: '项目目录内读写自由；shell 允许；可动代码。',
    risk: '中——可改项目文件',
  },
  {
    mode: 'host',
    label: 'host（本机全能力）',
    desc: '本机文件/命令全放开；等同你现在给我的默认能力。',
    risk: '高——本机全权',
  },
  {
    mode: 'untrusted',
    label: 'untrusted（严格隔离）',
    desc: '强制隔离运行；无 L4 进程隔离能力的宿主上拒绝运行。',
    risk: '隔离最强',
  },
];

interface AgentForm {
  name: string;
  description: string;
  model: string;
  /** '' = 继承全局（保存时发 null 删 agent 级键） */
  effectMode: EffectMode | '';
  allow: string;
  deny: string;
  traits: string;
}

interface WizardState {
  rolePresetId: string;
  agentName: string;
  addressToUser: string;
  agentsMd: string;
  effectMode: EffectMode;
  model: string;
  /** 角色模板推荐特质（renderAgentRole 透出，创建时落 traits） */
  traits: string[];
}

const EMPTY_WIZARD: WizardState = {
  rolePresetId: '',
  agentName: '',
  addressToUser: '',
  agentsMd: '',
  effectMode: 'workspace',
  model: '',
  traits: [],
};

/** 逗号/空格分隔 → 字符串数组 */
function splitList(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isConflictError(err: unknown): boolean {
  return err instanceof Error && /HTTP 409/.test(err.message);
}

export function AgentSettingsPanel() {
  const client = useMemo(
    () => new OctopiClient({ baseUrl: resolveDefaultBase(), apiKey: getConsoleKey() || undefined }),
    [],
  );

  const [view, setView] = useState<ConfigAgentsViewDto | null>(null);
  const [rolePresets, setRolePresets] = useState<AgentRolePresetDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // agent id；'__new__' 向导
  const [form, setForm] = useState<AgentForm>({
    name: '',
    description: '',
    model: '',
    effectMode: 'workspace',
    allow: '',
    deny: '',
    traits: '',
  });
  const [wizard, setWizard] = useState<WizardState>(EMPTY_WIZARD);
  const [personaText, setPersonaText] = useState('');
  const [personaHash, setPersonaHash] = useState('');
  /** 载入快照（#6/#7 dirty 跟踪：未改动的字段不发，防全局固化/对象降级） */
  const [initial, setInitial] = useState<{ effectMode: string; model: string }>({ effectMode: '', model: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [agentsView, presets] = await Promise.all([
        client.getConfigAgents(),
        client.getAgentRolePresets(),
      ]);
      setView(agentsView);
      setRolePresets(presets);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleWriteError = async (err: unknown): Promise<void> => {
    if (isConflictError(err)) {
      setError('配置已被外部修改，已重新载入最新内容——请重新确认你的修改再保存');
      await reload();
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectAgent = async (id: string | null, freshView?: ConfigAgentsViewDto | null) => {
    setSelected(id);
    setError(null);
    setNotice(null);
    if (!id || id === '__new__') {
      setWizard(EMPTY_WIZARD);
      return;
    }
    const source = freshView ?? view;
    const agent = source?.agents.find((a) => a.id === id);
    if (!agent) return;
    const modelObj = agent.model as { provider?: string; model?: string } | undefined;
    const modelStr = modelObj?.provider ? `${modelObj.provider}/${modelObj.model}` : String(modelObj?.model ?? '');
    const effectMode = (agent.effectMode as EffectMode) ?? 'workspace';
    setInitial({ effectMode, model: modelStr });
    setForm({
      name: agent.persona.name,
      description: agent.persona.description,
      model: modelStr,
      effectMode,
      allow: agent.tools.allow.join(', '),
      deny: agent.tools.deny.join(', '),
      traits: agent.traits.join(', '),
    });
    try {
      const persona = await client.getAgentPersona(id);
      setPersonaText(persona.content ?? '');
      setPersonaHash(persona.hash);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 向导：渲染角色模板（服务端单一实现） */
  const renderRole = async () => {
    if (!wizard.rolePresetId || !wizard.agentName.trim() || !wizard.addressToUser.trim()) {
      setError('先选角色，并填写 agent 名字与对用户的称谓');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rendered = await client.renderAgentRolePreset(wizard.rolePresetId, {
        agentName: wizard.agentName.trim(),
        addressToUser: wizard.addressToUser.trim(),
      });
      setWizard((prev) => ({
        ...prev,
        agentsMd: rendered.agentsMd,
        effectMode: rendered.recommendedEffectMode,
        model: rendered.recommendedModelLevel ?? '',
        traits: rendered.recommendedTraits ?? [],
      }));
      setNotice('已按角色生成 AGENTS.md 初稿（可直接编辑），并带出推荐安全组/模型档');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createAgent = async () => {
    const id = wizard.agentName.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      setError('agent 名字需为 1-64 位字母/数字/._-（它同时是 agent id 与 home 目录名）');
      return;
    }
    if (!wizard.agentsMd.trim()) {
      setError('AGENTS.md 不能为空（点「生成初稿」或手动填写）');
      return;
    }
    if (!wizard.model.trim()) {
      setError('模型必填（provider/model 或档位名，如 standard）');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const agent: Record<string, unknown> = {
        id,
        // persona 省略：AGENTS.md 是身份真源（inline persona 带 systemPrompt 会断 resolver）
        model: wizard.model.trim(),
        effectPolicy: { mode: wizard.effectMode },
      };
      if (wizard.traits.length > 0) agent.traits = wizard.traits;
      const result = await client.createConfigAgent({
        agent,
        agentsMd: wizard.agentsMd,
        hash: view?.hash ?? '',
      });
      setNotice(`已创建 ${id}，新会话生效`);
      // fresh view 重新选中（防 stale state 串味旧 agent 的表单值）
      const fresh = await client.getConfigAgents();
      setView(fresh);
      setSelected(id);
      await selectAgent(id, fresh);
      void result;
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async () => {
    if (!selected || selected === '__new__') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // 只发编辑字段（服务端字段级合并，未展示字段不丢）。
      // persona 不发：AGENTS.md 是身份真源（inline persona 会断 resolver）。
      const patch: Record<string, unknown> = {
        tools: { allow: splitList(form.allow), deny: splitList(form.deny) },
      };
      // #6 安全组 dirty：未改动不发（防全局模式被固化到 agent）；改「继承全局」发 null 删键
      if (form.effectMode !== initial.effectMode) {
        patch.effectPolicy = form.effectMode ? { mode: form.effectMode } : null;
      }
      // #7 模型 dirty：未改动不发（防对象形态被字符串降级）
      if (form.model.trim() && form.model.trim() !== initial.model) {
        patch.model = form.model.trim();
      }
      // traits 全量发（空数组 = 清除，#25）
      patch.traits = splitList(form.traits);
      await client.updateConfigAgent(selected, patch, view?.hash ?? '');
      setNotice('已保存，新会话生效');
      await reload();
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  const savePersona = async () => {
    if (!selected || selected === '__new__') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.updateAgentPersona(selected, personaText, personaHash);
      setPersonaHash(result.hash);
      setNotice('persona 已保存，新会话生效');
    } catch (err) {
      if (isConflictError(err)) {
        // #13 冲突可恢复：换新锁但保留用户编辑内容——再点保存 = 明确覆盖外部修改
        try {
          const latest = await client.getAgentPersona(selected);
          setPersonaHash(latest.hash);
          setError('persona 已被外部修改——已更新校验 token，再点一次「保存 persona」将覆盖外部修改');
        } catch {
          await handleWriteError(err);
        }
      } else {
        await handleWriteError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected || selected === '__new__') return;
    if (!window.confirm(`确认下线 agent「${selected}」？配置将移除，但 home/persona 文件会保留。`)) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.deleteConfigAgent(selected, view?.hash ?? '');
      setNotice(`已下线 ${selected}`);
      setSelected(null);
      await reload();
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-panel">
      <div className="set-header">
        <h2>Agent 配置</h2>
        <span className="small muted">
          保存即生效（新会话用新配置）· 安全组 = 工具效应面策略 · 下线不删文件
        </span>
      </div>

      {error && <div className="set-error">{error}</div>}
      {notice && <div className="set-notice">{notice}</div>}

      <div className="set-body">
        <aside className="set-list">
          <button type="button" className="btn-secondary small" onClick={() => selectAgent('__new__')}>
            + 新建 agent
          </button>
          {(view?.agents ?? []).map((a) => (
            <button
              key={a.id}
              type="button"
              className={selected === a.id ? 'set-item set-item-active' : 'set-item'}
              onClick={() => selectAgent(a.id)}
            >
              <span className="mono">{a.id}</span>
              <span className="small muted">
                {a.effectMode}
                {a.effectModeSource === 'global' ? '（全局）' : ''}
              </span>
            </button>
          ))}
        </aside>

        <section className="set-form">
          {selected === '__new__' && (
            <>
              <div className="set-presets">
                <div className="small muted">① 选角色（生成器：预览可改，落盘即标准 AGENTS.md）：</div>
                <div className="set-preset-grid">
                  {rolePresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={
                        wizard.rolePresetId === preset.id ? 'set-preset-card set-item-active' : 'set-preset-card'
                      }
                      onClick={() => setWizard((p) => ({ ...p, rolePresetId: preset.id }))}
                      title={preset.description}
                    >
                      <strong>{preset.label}</strong>
                      <span className="small muted">{preset.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="set-field">
                <span>② agent 名字（同时是 id / home 目录名）</span>
                <input
                  className="set-input mono"
                  value={wizard.agentName}
                  onChange={(e) => setWizard((p) => ({ ...p, agentName: e.target.value }))}
                  placeholder="helper"
                />
              </label>
              <label className="set-field">
                <span>③ 对用户的称谓（写入 persona「Your Human」段）</span>
                <input
                  className="set-input"
                  value={wizard.addressToUser}
                  onChange={(e) => setWizard((p) => ({ ...p, addressToUser: e.target.value }))}
                  placeholder="大哥"
                />
              </label>

              <div className="set-actions">
                <button type="button" className="btn-secondary" onClick={renderRole} disabled={busy}>
                  ④ 生成 AGENTS.md 初稿
                </button>
              </div>

              {wizard.agentsMd && (
                <>
                  <label className="set-field">
                    <span>⑤ 预览（可直接编辑）：</span>
                    <textarea
                      className="set-input mono"
                      rows={16}
                      value={wizard.agentsMd}
                      onChange={(e) => setWizard((p) => ({ ...p, agentsMd: e.target.value }))}
                    />
                  </label>

                  <div className="set-field">
                    <span>⑥ 安全组（工具效应面策略）</span>
                    <div className="set-preset-grid">
                      {EFFECT_MODE_CARDS.map((card) => (
                        <button
                          key={card.mode}
                          type="button"
                          className={
                            wizard.effectMode === card.mode ? 'set-preset-card set-item-active' : 'set-preset-card'
                          }
                          onClick={() => setWizard((p) => ({ ...p, effectMode: card.mode }))}
                        >
                          <strong>{card.label}</strong>
                          <span className="small muted">{card.desc}</span>
                          <span className="small">{card.risk}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="set-field">
                    <span>⑦ 模型（provider/model 或档位名，必填）</span>
                    <input
                      className="set-input mono"
                      value={wizard.model}
                      onChange={(e) => setWizard((p) => ({ ...p, model: e.target.value }))}
                      placeholder="standard 或 openai/gpt-5.5"
                    />
                  </label>

                  <div className="set-actions">
                    <button type="button" className="btn-secondary" onClick={createAgent} disabled={busy}>
                      {busy ? '创建中…' : '创建并生效'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {selected && selected !== '__new__' && (
            <>
              <label className="set-field">
                <span>id（不可改）· 身份/称谓请在下方 persona（AGENTS.md）中编辑</span>
                <input className="set-input mono" value={selected} disabled />
              </label>
              <label className="set-field">
                <span>模型（provider/model 或档位名）</span>
                <input
                  className="set-input mono"
                  value={form.model}
                  onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
                  placeholder="standard"
                />
              </label>

              <div className="set-field">
                <span>安全组（工具效应面策略）</span>
                <div className="set-preset-grid">
                  <button
                    type="button"
                    className={form.effectMode === '' ? 'set-preset-card set-item-active' : 'set-preset-card'}
                    onClick={() => setForm((p) => ({ ...p, effectMode: '' }))}
                    title="删除 agent 级配置，跟随全局 effectPolicy"
                  >
                    <strong>继承全局</strong>
                    <span className="small muted">不写 agent 级策略，跟随全局配置。</span>
                    <span className="small">跟随</span>
                  </button>
                  {EFFECT_MODE_CARDS.map((card) => (
                    <button
                      key={card.mode}
                      type="button"
                      className={
                        form.effectMode === card.mode ? 'set-preset-card set-item-active' : 'set-preset-card'
                      }
                      onClick={() => setForm((p) => ({ ...p, effectMode: card.mode }))}
                    >
                      <strong>{card.label}</strong>
                      <span className="small muted">{card.desc}</span>
                      <span className="small">{card.risk}</span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="set-field">
                <span>工具 allow（逗号分隔，空 = 不限）</span>
                <input
                  className="set-input mono"
                  value={form.allow}
                  onChange={(e) => setForm((p) => ({ ...p, allow: e.target.value }))}
                />
              </label>
              <label className="set-field">
                <span>工具 deny（逗号分隔）</span>
                <input
                  className="set-input mono"
                  value={form.deny}
                  onChange={(e) => setForm((p) => ({ ...p, deny: e.target.value }))}
                />
              </label>
              <label className="set-field">
                <span>特质标签（委派发现用，逗号分隔）</span>
                <input
                  className="set-input mono"
                  value={form.traits}
                  onChange={(e) => setForm((p) => ({ ...p, traits: e.target.value }))}
                />
              </label>

              <div className="set-actions">
                <button type="button" className="btn-secondary" onClick={saveAgent} disabled={busy}>
                  {busy ? '保存中…' : '保存配置'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={async () => {
                    const tplId = window.prompt('模板 id（字母/数字/._-，如 my-coder）：');
                    if (!tplId) return;
                    const label = window.prompt('模板显示名（可留空）：') ?? '';
                    try {
                      await client.saveAgentAsTemplate(selected, { id: tplId.trim(), label });
                      setNotice(`已另存为角色模板 ${tplId.trim()}（新建向导可选）`);
                    } catch (err) {
                      await handleWriteError(err);
                    }
                  }}
                  disabled={busy}
                >
                  另存为模板
                </button>
                <button type="button" className="btn-ghost" onClick={deleteAgent} disabled={busy}>
                  下线 agent
                </button>
              </div>

              <label className="set-field">
                <span>persona（AGENTS.md 全文，保存即热生效）</span>
                <textarea
                  className="set-input mono"
                  rows={18}
                  value={personaText}
                  onChange={(e) => setPersonaText(e.target.value)}
                />
              </label>
              <div className="set-actions">
                <button type="button" className="btn-secondary" onClick={savePersona} disabled={busy}>
                  保存 persona
                </button>
              </div>
            </>
          )}

          {!selected && <div className="small muted">选择左侧 agent 编辑，或新建。</div>}
        </section>
      </div>
    </div>
  );
}
