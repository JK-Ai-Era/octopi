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
  type RenderedAgentRoleDto,
} from '@octopi-agent/gateway/web/sdk/client';
import { resolveDefaultBase } from '../gateway-base';
import { getConsoleKey, getRegistryToken } from '../console-key';
import { useT } from '../i18n/react';
import { getLang, type MessageKey } from '../i18n/core';
import { normalizePersonaFileName } from './persona-file';

type EffectMode = 'workspace' | 'project' | 'host' | 'untrusted';

/** 安全组四选一卡片文案键（与 arch/tool-effect-policy.md 运行模式对齐） */
const EFFECT_MODE_CARDS: Array<{
  mode: EffectMode;
  labelKey: MessageKey;
  descKey: MessageKey;
  riskKey: MessageKey;
}> = [
  {
    mode: 'workspace',
    labelKey: 'agentSettings.modeWorkspaceLabel',
    descKey: 'agentSettings.modeWorkspaceDesc',
    riskKey: 'agentSettings.modeWorkspaceRisk',
  },
  {
    mode: 'project',
    labelKey: 'agentSettings.modeProjectLabel',
    descKey: 'agentSettings.modeProjectDesc',
    riskKey: 'agentSettings.modeProjectRisk',
  },
  {
    mode: 'host',
    labelKey: 'agentSettings.modeHostLabel',
    descKey: 'agentSettings.modeHostDesc',
    riskKey: 'agentSettings.modeHostRisk',
  },
  {
    mode: 'untrusted',
    labelKey: 'agentSettings.modeUntrustedLabel',
    descKey: 'agentSettings.modeUntrustedDesc',
    riskKey: 'agentSettings.modeUntrustedRisk',
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
  /** agent 级额外工作目录（effectPolicy.transactionRoots；基目录 workspace 不在此编辑） */
  transactionRoots: string[];
}

interface WizardState {
  rolePresetId: string;
  agentName: string;
  addressToUser: string;
  agentsMd: string;
  /** 类型模板 persona 补充件（创建时物化四件套） */
  personaFiles: RenderedAgentRoleDto['personaFiles'];
  /** 类型模板技能套装（创建时物化 SKILL.md + 落 definition.skills） */
  skills: RenderedAgentRoleDto['skills'];
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
  personaFiles: [],
  skills: [],
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

/** 两组字符串序列是否一致（工作目录 dirty 跟踪） */
function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 配置路径形态：客户端宽松预校验（POSIX/Windows 绝对路径、UNC 或 `~` 形态）。
 * 权威校验在 engine 配置 schema（`isConfigPathShape`，按网关平台收窄）——此处只做
 * 早反馈，服务端 Zod 拒绝才是最终裁决。 */
function isConfigPathShape(path: string): boolean {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return true;
  if (path.startsWith('/') || path.startsWith('\\\\')) return true;
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isConflictError(err: unknown): boolean {
  return err instanceof Error && /HTTP 409/.test(err.message);
}

export function AgentSettingsPanel() {
  const t = useT();
  const client = useMemo(
    () => new OctopiClient({ baseUrl: resolveDefaultBase(), apiKey: getConsoleKey() || undefined, registryToken: getRegistryToken() || undefined }),
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
    transactionRoots: [],
  });
  const [wizard, setWizard] = useState<WizardState>(EMPTY_WIZARD);
  const [personaText, setPersonaText] = useState('');
  const [personaHash, setPersonaHash] = useState('');
  /** 当前编辑的 persona 文件（AGENTS.md = 主 persona；其余为 persona/ 补充件四件套） */
  const [personaFile, setPersonaFile] = useState('AGENTS.md');
  const [personaFiles, setPersonaFiles] = useState<Array<{ file: string; content: string; hash: string }>>(
    [],
  );
  /** 新增自定义文件的输入（不含后缀；提交时统一补 .md） */
  const [newFileName, setNewFileName] = useState('');
  /** 新增工作目录的输入（随「保存配置」落盘） */
  const [newWorkdir, setNewWorkdir] = useState('');
  /** 载入快照（#6/#7 dirty 跟踪：未改动的字段不发，防全局固化/对象降级） */
  const [initial, setInitial] = useState<{ effectMode: string; model: string; transactionRoots: string[] }>({
    effectMode: '',
    model: '',
    transactionRoots: [],
  });
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

  /** 当前选中 agent 的视图（基目录展示 + 工作目录写入策略判据） */
  const selectedAgent = view?.agents.find((a) => a.id === selected);
  const selectedHasOwnEffectPolicy = selectedAgent?.hasOwnEffectPolicy ?? false;

  const handleWriteError = async (err: unknown): Promise<void> => {
    if (isConflictError(err)) {
      setError(t('agentSettings.conflictReloaded'));
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
      setNewWorkdir('');
      return;
    }
    const source = freshView ?? view;
    const agent = source?.agents.find((a) => a.id === id);
    if (!agent) return;
    const modelObj = agent.model as { provider?: string; model?: string } | undefined;
    const modelStr = modelObj?.provider ? `${modelObj.provider}/${modelObj.model}` : String(modelObj?.model ?? '');
    const effectMode = (agent.effectMode as EffectMode) ?? 'workspace';
    const transactionRoots = [...agent.transactionRoots];
    setInitial({ effectMode, model: modelStr, transactionRoots });
    setForm({
      name: agent.persona.name,
      description: agent.persona.description,
      model: modelStr,
      effectMode,
      allow: agent.tools.allow.join(', '),
      deny: agent.tools.deny.join(', '),
      traits: agent.traits.join(', '),
      transactionRoots,
    });
    try {
      const [persona, files] = await Promise.all([
        client.getAgentPersona(id),
        client.getAgentPersonaFiles(id),
      ]);
      setPersonaFile('AGENTS.md');
      setPersonaText(persona.content ?? '');
      setPersonaHash(persona.hash);
      setPersonaFiles(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 向导：渲染角色模板（服务端单一实现） */
  const renderRole = async () => {
    if (!wizard.rolePresetId || !wizard.agentName.trim() || !wizard.addressToUser.trim()) {
      setError(t('agentSettings.roleRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rendered = await client.renderAgentRolePreset(
        wizard.rolePresetId,
        {
          agentName: wizard.agentName.trim(),
          addressToUser: wizard.addressToUser.trim(),
        },
        getLang(),
      );
      setWizard((prev) => ({
        ...prev,
        agentsMd: rendered.agentsMd,
        personaFiles: rendered.personaFiles,
        skills: rendered.skills,
        effectMode: rendered.recommendedEffectMode,
        model: rendered.recommendedModelLevel ?? '',
        traits: rendered.recommendedTraits ?? [],
      }));
      setNotice(t('agentSettings.roleGenerated'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createAgent = async () => {
    const id = wizard.agentName.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      setError(t('agentSettings.nameInvalid'));
      return;
    }
    if (!wizard.agentsMd.trim()) {
      setError(t('agentSettings.agentsMdRequired'));
      return;
    }
    if (!wizard.model.trim()) {
      setError(t('agentSettings.modelRequired'));
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
      if (wizard.skills.length > 0) agent.skills = wizard.skills.map((s) => s.id);
      const result = await client.createConfigAgent({
        agent,
        agentsMd: wizard.agentsMd,
        personaFiles: wizard.personaFiles,
        skills: wizard.skills,
        // 缺省四件套（若模板未提供某成员）与渲染语言保持同一界面语言
        lang: getLang(),
        hash: view?.hash ?? '',
      });
      setNotice(t('agentSettings.created', { id }));
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

  /** 追加工作目录（本地编辑态；随「保存配置」写入 effectPolicy.transactionRoots） */
  const addWorkdir = () => {
    const path = newWorkdir.trim();
    if (!path) return;
    if (!isConfigPathShape(path)) {
      setError(t('agentSettings.workdirsPathInvalid'));
      return;
    }
    if (form.transactionRoots.includes(path)) {
      setError(t('agentSettings.workdirsDuplicate'));
      return;
    }
    setError(null);
    setForm((p) => ({ ...p, transactionRoots: [...p.transactionRoots, path] }));
    setNewWorkdir('');
  };

  const saveAgent = async () => {
    if (!selected || selected === '__new__') return;
    // 「继承全局」= 删除 agent 级 effectPolicy 整段（对象级覆盖语义）；与 agent 级
    // 工作目录互斥——删键会连 transactionRoots 一起删，无法表达「跟随全局 + 自带根」
    if (!form.effectMode && form.transactionRoots.length > 0) {
      setError(t('agentSettings.workdirsInheritConflict'));
      return;
    }
    const rootsDirty = !sameStringArray(form.transactionRoots, initial.transactionRoots);
    // 静默固化才要确认（F3 反向后果：固化 = 该 agent 脱离全局安全组的后续收紧）：
    // 本次显式改安全组 = 用户已表态，不追加弹窗
    const silentPin = rootsDirty && !selectedHasOwnEffectPolicy && form.transactionRoots.length > 0
      && form.effectMode === initial.effectMode;
    if (silentPin && !window.confirm(t('agentSettings.workdirsPinConfirm', { mode: form.effectMode }))) {
      return;
    }
    // 「继承全局」删整段（含面板未展示的安全旋钮）——显式确认（F7）
    if (!form.effectMode && selectedHasOwnEffectPolicy && !window.confirm(t('agentSettings.inheritGlobalConfirm'))) {
      return;
    }
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
      if (form.effectMode !== initial.effectMode || rootsDirty) {
        if (!form.effectMode) {
          // 继承全局：删整段（工作目录必为空——顶部校验已挡互斥）
          patch.effectPolicy = null;
        } else {
          const effectPolicy: Record<string, unknown> = {};
          // 例外：给无 agent 级策略的 agent 建段（首个工作目录）时不带 mode 会让运行
          // 模式从「继承全局」静默漂到引擎缺省 workspace——随建段固化当前生效安全组
          if (form.effectMode !== initial.effectMode || (rootsDirty && !selectedHasOwnEffectPolicy)) {
            effectPolicy.mode = form.effectMode;
          }
          if (rootsDirty) effectPolicy.transactionRoots = form.transactionRoots;
          patch.effectPolicy = effectPolicy;
        }
      }
      // #7 模型 dirty：未改动不发（防对象形态被字符串降级）
      if (form.model.trim() && form.model.trim() !== initial.model) {
        patch.model = form.model.trim();
      }
      // traits 全量发（空数组 = 清除，#25）
      patch.traits = splitList(form.traits);
      await client.updateConfigAgent(selected, patch, view?.hash ?? '');
      // 保存成功 = 服务端已对齐本次提交：快照跟上（否则「删根→保存→加回→保存」
      // 会被旧快照判成未改动而静默丢弃）。model 未发（空）时服务端保留旧值，快照同留。
      setInitial({
        effectMode: form.effectMode,
        model: form.model.trim() || initial.model,
        transactionRoots: [...form.transactionRoots],
      });
      setNotice(t('agentSettings.saved'));
      await reload();
    } catch (err) {
      await handleWriteError(err);
    } finally {
      setBusy(false);
    }
  };

  /** 切换正在编辑的 persona 文件（放弃未保存编辑——与切换 agent 的既有行为一致） */
  const switchPersonaFile = async (file: string) => {
    if (!selected || selected === '__new__') return;
    setError(null);
    try {
      const data =
        file === 'AGENTS.md'
          ? await client.getAgentPersona(selected)
          : await client.getAgentPersonaFile(selected, file);
      setPersonaFile(file);
      setPersonaText(data.content ?? '');
      setPersonaHash(data.hash);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * 新增自定义 persona 文件：输入名统一补 `.md` 后经既有单文件 PUT 首建
   * （落该 agent 的 persona/ 目录），随后刷新清单并切进新文件。
   */
  const createPersonaFile = async () => {
    if (!selected || selected === '__new__') return;
    const file = normalizePersonaFileName(newFileName);
    if (!file) {
      setError(t('agentSettings.newPersonaFileInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (personaFiles.some((f) => f.file === file)) {
        // 重名：不报错，直接切过去编辑
        setNewFileName('');
        await switchPersonaFile(file);
        return;
      }
      // 首建：不存在 → content=null、hash=空内容 hash；空正文进编辑器待输入
      const current = await client.getAgentPersonaFile(selected, file);
      await client.updateAgentPersonaFile(selected, file, '', current.hash);
      setPersonaFiles(await client.getAgentPersonaFiles(selected));
      setNewFileName('');
      await switchPersonaFile(file);
      setNotice(t('agentSettings.personaFileCreated', { file }));
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
      const result =
        personaFile === 'AGENTS.md'
          ? await client.updateAgentPersona(selected, personaText, personaHash)
          : await client.updateAgentPersonaFile(selected, personaFile, personaText, personaHash);
      setPersonaHash(result.hash);
      setNotice(t('agentSettings.personaSaved'));
      if (personaFile !== 'AGENTS.md' && !personaFiles.some((f) => f.file === personaFile)) {
        setPersonaFiles(await client.getAgentPersonaFiles(selected));
      }
    } catch (err) {
      if (isConflictError(err)) {
        // #13 冲突可恢复：换新锁但保留用户编辑内容——再点保存 = 明确覆盖外部修改
        try {
          const latest =
            personaFile === 'AGENTS.md'
              ? await client.getAgentPersona(selected)
              : await client.getAgentPersonaFile(selected, personaFile);
          setPersonaHash(latest.hash);
          setError(t('agentSettings.personaConflict'));
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
    if (!window.confirm(t('agentSettings.deleteConfirm', { id: selected }))) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.deleteConfigAgent(selected, view?.hash ?? '');
      setNotice(t('agentSettings.deleted', { id: selected }));
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
        <h2>{t('agentSettings.title')}</h2>
        <span className="small muted">{t('agentSettings.subtitle')}</span>
      </div>

      {/* 向导模式下错误显示在底栏（见 set-wizard-footer），避免顶部横幅滚出视野 */}
      {error && selected !== '__new__' && <div className="set-error">{error}</div>}
      {notice && <div className="set-notice">{notice}</div>}

      <div className="set-body">
        <aside className="set-list">
          <button type="button" className="btn-secondary small" onClick={() => selectAgent('__new__')}>
            {t('agentSettings.newAgent')}
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
                {a.effectModeSource === 'global' ? t('agentSettings.globalSuffix') : ''}
              </span>
            </button>
          ))}
        </aside>

        <section className="set-form">
          {selected === '__new__' && (
            <>
              <div className="set-presets">
                <div className="small muted">{t('agentSettings.stepRole')}</div>
                <div className="set-preset-grid">
                  {rolePresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={
                        wizard.rolePresetId === preset.id ? 'set-preset-card set-item-active' : 'set-preset-card'
                      }
                      onClick={() =>
                        // 切换角色 = 上一轮渲染产物全部作废（agentsMd/persona/skills/traits
                        // 都是派生态，沿用会把旧角色的四件套安到新角色头上）；已输入的名字/称谓保留
                        setWizard((p) => ({
                          ...EMPTY_WIZARD,
                          rolePresetId: preset.id,
                          agentName: p.agentName,
                          addressToUser: p.addressToUser,
                        }))
                      }
                      title={preset.descriptions?.[getLang()] ?? preset.description}
                    >
                      <strong>{preset.labels?.[getLang()] ?? preset.label}</strong>
                      <span className="small muted">
                        {preset.descriptions?.[getLang()] ?? preset.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="set-field">
                <span>{t('agentSettings.stepName')}</span>
                <input
                  className="set-input mono"
                  value={wizard.agentName}
                  onChange={(e) => setWizard((p) => ({ ...p, agentName: e.target.value }))}
                  placeholder="helper"
                />
              </label>
              <label className="set-field">
                <span>{t('agentSettings.stepAddress')}</span>
                <input
                  className="set-input"
                  value={wizard.addressToUser}
                  onChange={(e) => setWizard((p) => ({ ...p, addressToUser: e.target.value }))}
                  placeholder={t('agentSettings.addressPlaceholder')}
                />
              </label>

              <div className="set-actions">
                <button type="button" className="btn-secondary" onClick={renderRole} disabled={busy}>
                  {t('agentSettings.stepGenerate')}
                </button>
              </div>

              {wizard.agentsMd && (
                <>
                  <label className="set-field">
                    <span>{t('agentSettings.stepPreview')}</span>
                    <textarea
                      className="set-input mono"
                      rows={16}
                      value={wizard.agentsMd}
                      onChange={(e) => setWizard((p) => ({ ...p, agentsMd: e.target.value }))}
                    />
                  </label>

                  <div className="set-field">
                    <span>{t('agentSettings.stepEffectMode')}</span>
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
                          <strong>{t(card.labelKey)}</strong>
                          <span className="small muted">{t(card.descKey)}</span>
                          <span className="small">{t(card.riskKey)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="set-field">
                    <span>{t('agentSettings.stepModel')}</span>
                    <input
                      className="set-input mono"
                      value={wizard.model}
                      onChange={(e) => setWizard((p) => ({ ...p, model: e.target.value }))}
                      placeholder={t('agentSettings.modelPlaceholderWizard')}
                    />
                  </label>
                </>
              )}

              {/* 向导操作常驻底栏：创建按钮不随内容滚走；错误就地可见（不再只挂在面板顶部） */}
              <div className="set-wizard-footer">
                {error && <div className="small set-footer-error" role="alert">{error}</div>}
                {wizard.agentsMd ? (
                  <div className="set-actions">
                    <button type="button" className="btn-secondary" onClick={createAgent} disabled={busy}>
                      {busy ? t('agentSettings.creating') : t('agentSettings.createAndApply')}
                    </button>
                  </div>
                ) : (
                  <div className="small muted">{t('agentSettings.wizardFooterHint')}</div>
                )}
              </div>
            </>
          )}

          {selected && selected !== '__new__' && (
            <>
              <label className="set-field">
                <span>{t('agentSettings.idLabel')}</span>
                <input className="set-input mono" value={selected} disabled />
              </label>
              <label className="set-field">
                <span>{t('agentSettings.modelLabel')}</span>
                <input
                  className="set-input mono"
                  value={form.model}
                  onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
                  placeholder="standard"
                />
              </label>

              <div className="set-field">
                <span>{t('agentSettings.effectModeLabel')}</span>
                <div className="set-preset-grid">
                  <button
                    type="button"
                    className={form.effectMode === '' ? 'set-preset-card set-item-active' : 'set-preset-card'}
                    onClick={() => setForm((p) => ({ ...p, effectMode: '' }))}
                    title={t('agentSettings.inheritGlobalTitle')}
                  >
                    <strong>{t('agentSettings.inheritGlobal')}</strong>
                    <span className="small muted">{t('agentSettings.inheritGlobalDesc')}</span>
                    <span className="small">{t('agentSettings.inheritGlobalRisk')}</span>
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
                      <strong>{t(card.labelKey)}</strong>
                      <span className="small muted">{t(card.descKey)}</span>
                      <span className="small">{t(card.riskKey)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="set-field">
                <span>{t('agentSettings.workdirsLabel')}</span>
                {selectedAgent?.workspace && (
                  <div className="small muted">
                    {t('agentSettings.workdirsBase', { path: selectedAgent.workspace })}
                  </div>
                )}
                {form.transactionRoots.map((p) => (
                  <div key={p} className="set-file-create">
                    <code className="small" style={{ flex: 1, wordBreak: 'break-all', whiteSpace: 'normal' }}>
                      {p}
                    </code>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          transactionRoots: prev.transactionRoots.filter((r) => r !== p),
                        }))
                      }
                      disabled={busy}
                    >
                      {t('agentSettings.workdirsRemove')}
                    </button>
                  </div>
                ))}
                <div className="set-file-create">
                  <input
                    className="set-input mono"
                    value={newWorkdir}
                    onChange={(e) => setNewWorkdir(e.target.value)}
                    placeholder={t('agentSettings.workdirsPlaceholder')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addWorkdir();
                    }}
                  />
                  <button type="button" className="btn-ghost" onClick={addWorkdir} disabled={busy}>
                    {t('agentSettings.workdirsAdd')}
                  </button>
                </div>
                <span className="small muted">{t('agentSettings.workdirsHint')}</span>
                {selectedHasOwnEffectPolicy && (
                  <span className="small muted">{t('agentSettings.workdirsOwnPolicyNote')}</span>
                )}
              </div>

              <label className="set-field">
                <span>{t('agentSettings.toolsAllow')}</span>
                <input
                  className="set-input mono"
                  value={form.allow}
                  onChange={(e) => setForm((p) => ({ ...p, allow: e.target.value }))}
                />
              </label>
              <label className="set-field">
                <span>{t('agentSettings.toolsDeny')}</span>
                <input
                  className="set-input mono"
                  value={form.deny}
                  onChange={(e) => setForm((p) => ({ ...p, deny: e.target.value }))}
                />
              </label>
              <label className="set-field">
                <span>{t('agentSettings.traitsLabel')}</span>
                <input
                  className="set-input mono"
                  value={form.traits}
                  onChange={(e) => setForm((p) => ({ ...p, traits: e.target.value }))}
                />
              </label>

              <div className="set-actions">
                <button type="button" className="btn-secondary" onClick={saveAgent} disabled={busy}>
                  {busy ? t('agentSettings.saving') : t('agentSettings.saveConfig')}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={async () => {
                    const tplId = window.prompt(t('agentSettings.templateIdPrompt'));
                    if (!tplId) return;
                    const label = window.prompt(t('agentSettings.templateLabelPrompt')) ?? '';
                    try {
                      await client.saveAgentAsTemplate(selected, { id: tplId.trim(), label });
                      setNotice(t('agentSettings.templateSaved', { id: tplId.trim() }));
                    } catch (err) {
                      await handleWriteError(err);
                    }
                  }}
                  disabled={busy}
                >
                  {t('agentSettings.saveAsTemplate')}
                </button>
                <button type="button" className="btn-ghost" onClick={deleteAgent} disabled={busy}>
                  {t('agentSettings.unregister')}
                </button>
              </div>

              <label className="set-field">
                <span>{t('agentSettings.personaFileLabel')}</span>
                <select
                  className="set-input"
                  value={personaFile}
                  onChange={(e) => void switchPersonaFile(e.target.value)}
                >
                  <option value="AGENTS.md">AGENTS.md</option>
                  {personaFiles.map((f) => (
                    <option key={f.file} value={f.file}>
                      {f.file}
                    </option>
                  ))}
                </select>
              </label>
              <div className="set-field">
                <span>{t('agentSettings.newPersonaFile')}</span>
                <div className="set-file-create">
                  <input
                    className="set-input mono"
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    placeholder={t('agentSettings.newPersonaFilePlaceholder')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createPersonaFile();
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void createPersonaFile()}
                    disabled={busy}
                  >
                    {t('agentSettings.createPersonaFile')}
                  </button>
                </div>
              </div>
              <label className="set-field">
                <span>{t('agentSettings.personaLabel')}</span>
                <textarea
                  className="set-input mono"
                  rows={18}
                  value={personaText}
                  onChange={(e) => setPersonaText(e.target.value)}
                />
              </label>
              <div className="set-actions">
                <button type="button" className="btn-secondary" onClick={savePersona} disabled={busy}>
                  {t('agentSettings.savePersona')}
                </button>
              </div>
            </>
          )}

          {!selected && <div className="small muted">{t('agentSettings.selectPrompt')}</div>}
        </section>
      </div>
    </div>
  );
}
