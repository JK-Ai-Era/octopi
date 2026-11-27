/**
 * 薄层适配器 — 把现有存储/组件接到 ContextLayer 契约上
 *
 * 设计原则：只做「取内容 → 格式化 → 按预算截断」，
 * 不在本文件做相关性打分、embedding、衰减等智能逻辑。
 * 各层质量打磨后续替换 assemble 实现即可，契约不变。
 */

import type {
  ContextLayer,
  ContextLayerId,
  LayerAssembleContext,
  LayerContent,
  LayerPlacement,
} from './layer-types.js';
import {
  diffSkillIndex,
  renderSkillDelta,
  type FrozenSkillIndexStore,
} from './skill-freeze.js';
import {
  renderSkillIndexEntries,
  type SkillIndexEntry,
} from '../extension/plugin-ecosystem/skills/index-render.js';
import {
  LAYER_DEFAULT_SHARE,
  LAYER_ORDER,
  LAYER_PRIORITY,
} from './layer-types.js';
import { HeuristicTokenEstimator } from './token-estimator.js';
import type { MemoryStore, ConceptGraphStore } from '../memory/types.js';
import { deriveQuerySeeds, normName } from '../memory/cognition-seeds.js';
import { formatWisdomBody } from '../memory/wisdom-formation.js';
import { formatMemoryTimeSuffix } from '../memory/time-format.js';
import type {
  KnowledgeCatalogItem,
  KnowledgeCatalogProvider,
} from '../knowledge/catalog-types.js';

// ── 基类 ──

abstract class BaseLayer implements ContextLayer {
  readonly id: ContextLayerId;
  readonly priority: number;
  readonly defaultShare: number;
  readonly droppable: boolean;
  readonly order: number;
  readonly placement: LayerPlacement;

  constructor(id: ContextLayerId, overrides?: Partial<Pick<ContextLayer, 'priority' | 'defaultShare' | 'droppable' | 'order' | 'placement'>>) {
    this.id = id;
    this.priority = overrides?.priority ?? LAYER_PRIORITY[id];
    this.defaultShare = overrides?.defaultShare ?? LAYER_DEFAULT_SHARE[id];
    this.droppable = overrides?.droppable ?? id !== 'persona';
    this.order = overrides?.order ?? LAYER_ORDER[id];
    this.placement = overrides?.placement ?? 'system';
  }

  abstract assemble(ctx: LayerAssembleContext): Promise<LayerContent | null>;

  protected content(text: string, extra?: Partial<LayerContent>): LayerContent | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    return {
      layerId: this.id,
      text: trimmed,
      // 粗估；Assembler 会用统一 estimator 覆写
      tokens: Math.ceil(trimmed.length / 4),
      ...extra,
    };
  }

  /**
   * 粗滤截断（字符启发式，非权威）
   *
   * Assembler 会用统一 TokenEstimator 做二次截断；此处只避免把超长文本
   * 整段交给装配层，降低无意义拷贝。中英混排下 chars/token 不准是预期的。
   */
  protected truncateToBudget(text: string, tokenBudget: number): { text: string; dropped?: string } {
    if (tokenBudget <= 0) return { text: '', dropped: 'zero budget' };
    // 英文 ~4 chars/token，中文更紧，用 2 作为保守粗滤
    const maxChars = Math.max(80, tokenBudget * 2);
    if (text.length <= maxChars) return { text };
    return {
      text: text.slice(0, maxChars),
      dropped: `truncated from ${text.length} to ${maxChars} chars`,
    };
  }
}

// ── Persona ──

/**
 * Persona 层 — 包装已加载的人格文本
 *
 * 生产路径可传入 PersonaSource.load() 的结果，
 * 或 Runner 每轮 resolve 出的 basePrompt。
 */
export class PersonaLayer extends BaseLayer {
  private readonly getText: () => Promise<string> | string;
  private readonly sources: string[];

  constructor(options: {
    getText: () => Promise<string> | string;
    sources?: string[];
    order?: number;
  }) {
    super('persona', { order: options.order, droppable: false });
    this.getText = options.getText;
    this.sources = options.sources ?? ['persona'];
  }

  async fingerprint(): Promise<string> {
    // 默认装配路径里 getText 返回已是内存字符串（Runner resolve 后传入），
    // 不读盘；若调用方包装 PersonaSource.load，由其自身 fingerprint 缓存兜底。
    const text = await this.getText();
    return `len:${text.length}`;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    const text = await this.getText();
    const { text: body, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(body, { dropped, sources: this.sources });
  }
}

// ── Skill ──

/**
 * Skill 层 — 技能索引（system 稳定份）
 *
 * 冻结语义（设计 §7）：会话首轮把当前技能集固化（write-once），之后 system
 * 份逐字节稳定——中途技能变化不 bust 缓存前缀；变化经 SkillDeltaLayer 进
 * snapshot 增量块。无 freeze 配置 = 历史行为（每轮实时渲染）。
 */
export class SkillLayer extends BaseLayer {
  private readonly getPromptText: () => Promise<string> | string;
  private readonly freeze?: {
    store: FrozenSkillIndexStore;
    getEntries: () => Promise<SkillIndexEntry[]> | SkillIndexEntry[];
  };

  constructor(options: {
    getPromptText: () => Promise<string> | string;
    order?: number;
    /** 冻结配置：store（session 作用域 write-once）+ 当前技能集供给 */
    freeze?: {
      store: FrozenSkillIndexStore;
      getEntries: () => Promise<SkillIndexEntry[]> | SkillIndexEntry[];
    };
  }) {
    super('skill', { order: options.order });
    this.getPromptText = options.getPromptText;
    this.freeze = options.freeze;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    let text: string;
    if (this.freeze) {
      // 冻结：首轮固化当前集，之后恒用冻结文本（逐字节稳定）
      const frozen = await this.freeze.store.load(ctx.sessionId);
      if (frozen) {
        text = frozen.text;
      } else {
        const entries = await this.freeze.getEntries();
        text = renderSkillIndexEntries(entries);
        try {
          await this.freeze.store.save(ctx.sessionId, {
            entries,
            text,
            frozenAt: Date.now(),
          });
        } catch (err) {
          // 冻结写入失败（磁盘满/只读 home）= 本轮降级为不冻结（下轮重试），
          // 但索引文本照常返回——缓存优化失败绝不能退化成技能从 prompt 消失
          console.warn(
            `[Skills] frozen skill index persist failed (session=${ctx.sessionId}, degraded to live render): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } else {
      text = await this.getPromptText();
    }
    const { text: body, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(body, { dropped, sources: ['skills'] });
  }
}

/**
 * Skill 增量层 — 会话中途技能变化（snapshot 易变份，设计 §7）
 *
 * placement='snapshot'：进本轮快照（消息尾 content 侧 `<runtime_snapshot>` 槽），
 * 不改 system 前缀。每轮随快照重发（快照只回放最近一条）；新会话冻结时归零转正。
 */
export class SkillDeltaLayer extends BaseLayer {
  private readonly store: FrozenSkillIndexStore;
  private readonly getEntries: () => Promise<SkillIndexEntry[]> | SkillIndexEntry[];
  private readonly getAvailableTools?: () => string[];

  constructor(options: {
    store: FrozenSkillIndexStore;
    getEntries: () => Promise<SkillIndexEntry[]> | SkillIndexEntry[];
    /** S4 失配标注数据源（缺省不标注）：与索引渲染同一可用工具集 */
    getAvailableTools?: () => string[];
    order?: number;
  }) {
    super('skill', { order: options.order, placement: 'snapshot' });
    this.store = options.store;
    this.getEntries = options.getEntries;
    this.getAvailableTools = options.getAvailableTools;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    // 首轮（尚未冻结）无 delta：system 份正在冻结当时的全量
    const frozen = await this.store.load(ctx.sessionId);
    if (!frozen) return null;
    const current = await this.getEntries();
    const diff = diffSkillIndex(frozen.entries, current);
    if (diff.added.length === 0 && diff.updated.length === 0 && diff.removed.length === 0) {
      return null;
    }
    const text = renderSkillDelta(diff, { availableTools: this.getAvailableTools?.() });
    const { text: body, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(body, { dropped, sources: ['skills:delta'] });
  }
}

// ── Runtime（session tasks / injectedContext） ──

/**
 * Runtime 层 — 每轮动态注入（会话任务、子系统 guidance 等）
 *
 * 对应现有 Runner 的 injectedContext 拼接逻辑，收编为契约层。
 */
export class RuntimeLayer extends BaseLayer {
  private readonly getText: (ctx: LayerAssembleContext) => Promise<string> | string;

  constructor(options: {
    getText: (ctx: LayerAssembleContext) => Promise<string> | string;
    order?: number;
    /** E8：稳定锚点（workspace/root_instructions）留 system；易变注入（datetime/tasks）标 snapshot */
    placement?: LayerPlacement;
  }) {
    super('runtime', { order: options.order, placement: options.placement ?? 'system' });
    this.getText = options.getText;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    const text = await this.getText(ctx);
    const { text: body, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(body, { dropped, sources: ['runtime'] });
  }
}

/** Plugin Collect is a budgeted Runtime snapshot, never a systemPrompt override. */
export class PluginRuntimeSnapshotLayer extends BaseLayer {
  constructor(private readonly contributions: readonly { pluginId: string; value: { text: string } }[]) {
    super('runtime', { placement: 'snapshot', order: 75 });
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    const body = this.contributions
      .map(({ pluginId, value }) => `<plugin-contribution plugin="${escapeXmlAttribute(pluginId)}">\n${escapeXmlText(value.text)}\n</plugin-contribution>`)
      .join('\n\n');
    const { text, dropped } = this.truncateToBudget(body, ctx.tokenBudget);
    return this.content(text, {
      dropped,
      sources: this.contributions.map(({ pluginId }) => `plugin:${pluginId}`),
    });
  }
}

function escapeXmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** Contribution text is data, not markup: escape it so a plugin cannot forge sibling tags or close the slot. */
function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// ── Knowledge（Tier 0 catalog；内容命中不进 system） ──

function resolveCatalogList(
  provider: KnowledgeCatalogProvider,
  ctx?: LayerAssembleContext,
): Promise<KnowledgeCatalogItem[]> | KnowledgeCatalogItem[] {
  if (typeof provider !== 'function') return provider;
  return provider({
    agentId: ctx?.agentId,
    sessionId: ctx?.sessionId,
  });
}

export class KnowledgeLayer extends BaseLayer {
  private readonly getCatalog: KnowledgeCatalogProvider;
  private readonly maxEntries: number;
  private readonly groupByScope: boolean;
  /** off=不显示状态；bucket=粗标；exact=含 scale 细节 */
  private readonly showProgress: 'off' | 'bucket' | 'exact';

  constructor(options: {
    getCatalog: KnowledgeCatalogProvider;
    maxEntries?: number;
    groupByScope?: boolean;
    showProgress?: 'off' | 'bucket' | 'exact';
    order?: number;
  }) {
    super('knowledge', { order: options.order });
    this.getCatalog = options.getCatalog;
    this.maxEntries = options.maxEntries ?? 10;
    this.groupByScope = options.groupByScope ?? false;
    this.showProgress = options.showProgress ?? 'bucket';
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    // provider 返回可见全集；截断与 overflow 只在此处算一次
    const all = await resolveCatalogList(this.getCatalog, ctx);
    if (!all?.length) return null;

    const shown = all.slice(0, this.maxEntries);
    const overflow = all.length - shown.length;

    // 标签化 catalog（arch/knowledge-catalog-redesign.md）：id/name/type/status/scale/location + purpose/topics
    const formatItem = (item: KnowledgeCatalogItem): string => {
      const tags: string[] = [`id=${item.id}`, `name=${item.displayName}`];
      if (item.kind) tags.push(`type=${item.kind}`);
      if (this.showProgress !== 'off') {
        if (item.status) tags.push(`status=${item.status}`);
        if (item.scaleLabel && item.scaleLabel !== item.status) {
          if (this.showProgress === 'exact' || item.scaleLabel !== 'ready') {
            tags.push(`scale=${item.scaleLabel}`);
          }
        }
      }
      if (item.location) tags.push(`location=${item.location}`);
      const head = `- ${tags.join(' ')}`;
      const lines = [head];
      const desc = item.description?.trim();
      // 强制标注（2026-11-02）：LLM 生成的描述会注入 prompt，必须可溯源；
      // heuristic 文本自带 "derived:" 前缀、human 为权威默认，均不加标
      if (desc) {
        lines.push(
          item.descriptionSource === 'llm' ? `  purpose: [llm] ${desc}` : `  purpose: ${desc}`,
        );
      }
      if (item.topics?.length) lines.push(`  topics: ${item.topics.join(' · ')}`);
      return lines.join('\n');
    };

    const overflowLine = `- ${overflow} more sources (use knowledge_search)`;
    const legend = [
      'Legend: id=source handle name=display type=kind',
      this.showProgress === 'off'
        ? 'location=root'
        : 'status=ready|indexing|error|off scale=size location=root',
      'Purpose (indented) = when to search. Prefer knowledge_search(query, source_id) then knowledge_read.',
      'status=ready means searchable; indexing means incomplete hits.',
    ].join('\n');

    let body: string;
    if (this.groupByScope) {
      const groups = new Map<string, KnowledgeCatalogItem[]>();
      for (const item of shown) {
        const key = item.scopeLevel ?? 'other';
        const list = groups.get(key) ?? [];
        list.push(item);
        groups.set(key, list);
      }
      const scopeTitle: Record<string, string> = {
        global: 'Global',
        project: 'Project',
        session: 'Session',
        other: 'Other',
      };
      const order = ['global', 'project', 'session', 'other'];
      const sections = order
        .filter((k) => groups.has(k))
        .map((k) => `## ${scopeTitle[k] ?? k}\n${(groups.get(k) ?? []).map(formatItem).join('\n')}`);
      if (overflow > 0) {
        sections.push(overflowLine);
      }
      body = sections.join('\n\n');
    } else {
      const lines = shown.map(formatItem);
      if (overflow > 0) {
        lines.push(overflowLine);
      }
      body = lines.join('\n');
    }

    const text = `## Knowledge Sources\n${legend}\n\n${body}`;
    const budget = Math.max(ctx.tokenBudget, 400);
    const { text: truncated, dropped } = this.truncateToBudget(text, budget);
    return this.content(truncated, {
      dropped,
      sources: shown.map((e) => e.id),
    });
  }
}

// ── Memory（薄召回） ──

export class MemoryLayer extends BaseLayer {
  private readonly store: MemoryStore;
  private readonly limit: number;
  /** 向量相关性地板；默认见 retrieval-rank（与 search 工具相比更严） */
  private readonly minSimilarity?: number;

  constructor(options: {
    store: MemoryStore;
    limit?: number;
    order?: number;
    minSimilarity?: number;
  }) {
    super('memory', { order: options.order, placement: 'snapshot' });
    this.store = options.store;
    this.limit = options.limit ?? 5;
    this.minSimilarity = options.minSimilarity;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    if (!ctx.query?.trim()) return null;
    const entries = await this.store.retrieve({
      text: ctx.query,
      limit: this.limit,
      updateAccess: true,
      includeShadow: false,
      includeDeleted: false,
      minSimilarity: this.minSimilarity,
    });
    const { injectFilter } = await import('../memory/confidence.js');
    const injectable = entries.filter((e) => injectFilter(e));
    if (injectable.length === 0) return null;

    const body = injectable
      .map((m: { type: string; content: string; futureUse?: string; createdAt?: number; asOf?: number }) => {
        const when = m.futureUse ? ` (when: ${m.futureUse})` : '';
        return `- [${m.type}] ${m.content}${when}${formatMemoryTimeSuffix(m)}`;
      })
      .join('\n');
    const text = `# 相关记忆\n\n${body}`;
    const { text: truncated, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(truncated, {
      dropped,
      sources: injectable.map((e: { id: string }) => e.id),
    });
  }
}

// ── Cognition（扩散激活子图；强弱边分列） ──

/**
 * 语义种子默认上限：0 = 暂关（R4 拍板 2026-11-20：语义种子绝对距离带无区分力，
 * 无关对与相关对距离域重叠），等 OP-9R（写侧 name+description 嵌入）后重评。
 * 显式配置 > 0 可恢复。单源常量：CognitionLayer 缺省与 layer-health 装配事实共用。
 */
export const DEFAULT_SEMANTIC_SEED_COUNT = 0;

export class CognitionLayer extends BaseLayer {
  private readonly store: ConceptGraphStore;
  private readonly depth: number;
  private readonly semanticSeedCount: number;

  constructor(options: {
    store: ConceptGraphStore;
    depth?: number;
    order?: number;
    /** 语义种子上限（缺省 DEFAULT_SEMANTIC_SEED_COUNT=0 暂关；>0 显式开启） */
    semanticSeedCount?: number;
  }) {
    super('cognition', { order: options.order, placement: 'snapshot' });
    this.store = options.store;
    this.depth = options.depth ?? 2;
    this.semanticSeedCount = options.semanticSeedCount ?? DEFAULT_SEMANTIC_SEED_COUNT;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    if (!ctx.query?.trim()) return null;
    const seeds = deriveQuerySeeds(ctx.query);
    // 语义种子：向量近邻概念名补充（store 无向量能力/嵌入失败时为空 = 降级纯词面）
    if (this.semanticSeedCount > 0 && this.store.supportsSemanticSeeds) {
      const semantic = await this.store.semanticSeeds(ctx.query, this.semanticSeedCount);
      for (const name of semantic) {
        const key = normName(name);
        if (key && !seeds.some((s) => normName(s) === key)) seeds.push(name);
      }
    }

    const graph = await this.store.spreadingActivate(seeds, {
      depth: this.depth,
      limit: 40,
    });
    if (!graph.nodes.length) return null;

const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));

    // 行构造（R6 格式）：概念卡 + 关系行；name/释义单行化（换行不得伪造注入行）
    const cardLine = new Map<string, string>();
    for (const n of graph.nodes) {
      const desc = n.description ? `：${singleLineGloss(n.description)}` : '';
      cardLine.set(n.id, `- ${singleLine(n.name)}（${n.kind}）${desc}`);
    }
    const relationLines: Array<{ sourceId: string; targetId: string; line: string }> = [];
    for (const edge of graph.edges) {
      const source = nameOf.get(edge.sourceId);
      const target = nameOf.get(edge.targetId);
      if (!source || !target) continue;
      // 弱边（related/shadow）只作邻域成员资格，不伪造成因果格式
      if (edge.relationType === 'related' || edge.status === 'shadow') continue;
      const desc = edge.description ? ` (${singleLineGloss(edge.description)})` : '';
      relationLines.push({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        line: `- ${singleLine(source)} —[${edge.relationType}]→ ${singleLine(target)}${desc}`,
      });
    }

    // ── R6 行级装箱截断 ──
    // 原子单位 = 整行（永不切半）；连通子图成组（弱边也绑成员资格）按激活分取舍；
    // 尾部 in-band 标注省略数；单行超软顶保完整（首行例外准入）；
    // 装不下任何完整行即层 empty。
    const parent = new Map(graph.nodes.map((n) => [n.id, n.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    for (const e of graph.edges) {
      if (!parent.has(e.sourceId) || !parent.has(e.targetId)) continue;
      const a = find(e.sourceId);
      const b = find(e.targetId);
      if (a !== b) parent.set(a, b);
    }

    interface PackedGroup {
      cards: Array<{ id: string; line: string }>;
      rels: string[];
      rank: number;
    }
    const groups = new Map<string, PackedGroup>();
    const groupOf = (id: string): PackedGroup => {
      const root = find(id);
      let g = groups.get(root);
      if (!g) {
        g = { cards: [], rels: [], rank: Number.POSITIVE_INFINITY };
        groups.set(root, g);
      }
      return g;
    };
    graph.nodes.forEach((n, i) => {
      const g = groupOf(n.id);
      g.cards.push({ id: n.id, line: cardLine.get(n.id)! });
      g.rank = Math.min(g.rank, i);
    });
    for (const r of relationLines) {
      // source/target 必同组（union-find 跑全边），groupOf(source) 即组
      groupOf(r.sourceId).rels.push(r.line);
    }

    const sorted = [...groups.values()].sort((a, b) => a.rank - b.rank);
    if (ctx.tokenBudget <= 0) return null;

    // 装箱以**统一 TokenEstimator** 计量（M1：层内启发式与装配预算不得两套口径）；
    // 台账实测最终渲染全文（header/分隔/标注都计入——M2 不漏渲染期字面量）；
    // 标注常驻预留（数字位数上界），终文恒 ≤ tokenBudget
    const estimator = new HeuristicTokenEstimator();
    const renderText = (cs: string[], rs: string[], note?: string): string => {
      const lines = [...cs];
      if (rs.length) lines.push('', ...rs);
      if (note) lines.push('', note);
      return `# 相关概念\n\n${lines.join('\n')}`;
    };
    const fitsIn = (cs: string[], rs: string[]): boolean =>
      estimator.estimateText(renderText(cs, rs, '（已省略 0000 个概念 / 0000 条关系）')) <=
      ctx.tokenBudget;

    // 取舍语义：组原子优先（连通子图成组按激活分取舍）；组装不下时**行级兜底**
    //（M4 降级路径：单种子查询是单分量，纯组原子会退化全有/全无——组内前缀保序准入，
    // 停在首个装不下的行，组间继续尝试）。首行保完整（单行超软顶不切半）。
    const cLines: string[] = [];
    const rLines: string[] = [];
    const admittedIds: string[] = [];
    let omittedConcepts = 0;
    let omittedRelations = 0;
    const admitCard = (card: { id: string; line: string }, free: boolean): void => {
      if (free || fitsIn([...cLines, card.line], rLines)) {
        cLines.push(card.line);
        admittedIds.push(card.id);
      } else {
        omittedConcepts += 1;
      }
    };
    for (const g of sorted) {
      const nothingYet = cLines.length + rLines.length === 0;
      if (fitsIn([...cLines, ...g.cards.map((c) => c.line)], [...rLines, ...g.rels])) {
        for (const c of g.cards) admitCard(c, false);
        rLines.push(...g.rels);
        continue;
      }
      // 行级兜底：卡在前、关系在后（组内序），前缀保序、停在首个装不下的行
      let stopped = false;
      for (const c of g.cards) {
        const free = nothingYet && cLines.length === 0 && rLines.length === 0;
        if (stopped && !free) {
          omittedConcepts += 1;
          continue;
        }
        if (free || fitsIn([...cLines, c.line], rLines)) {
          cLines.push(c.line);
          admittedIds.push(c.id);
        } else {
          stopped = true;
          omittedConcepts += 1;
        }
      }
      for (const rel of g.rels) {
        if (stopped) {
          omittedRelations += 1;
          continue;
        }
        if (fitsIn(cLines, [...rLines, rel])) {
          rLines.push(rel);
        } else {
          stopped = true;
          omittedRelations += 1;
        }
      }
    }
    if (cLines.length + rLines.length === 0) return null;

    const hasOmission = omittedConcepts + omittedRelations > 0;
    const note = hasOmission
      ? `（已省略 ${omittedConcepts} 个概念 / ${omittedRelations} 条关系）`
      : undefined;
    const text = renderText(cLines, rLines, note);
    return this.content(text, {
      // 丢弃不静默：in-band 标注 + manifest dropped 双记
      dropped: hasOmission
        ? `已省略 ${omittedConcepts} 个概念 / ${omittedRelations} 条关系`
        : undefined,
      sources: admittedIds,
    });
  }
}

/** 行内原子（M1）：name/边端点单行化——换行不得伪造注入行（保留字间空格）；超 120 字截断带省略号 */
function singleLine(text: string): string {
  const flat = text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[^\S\r\n]+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/** 释义单行化 + 200 字符上限（截断带省略号标记，不产生看似完整的残缺释义） */
function singleLineGloss(text: string): string {
  const flat = singleLine(text);
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

// ── Wisdom（静态/半静态） ──

/**
 * Wisdom 层 — 小核心 + 场景匹配注入判断范式
 *
 * 不做全量 dump。匹配失败只注入 core（宁缺毋滥）。
 */
export class WisdomLayer extends BaseLayer {
  private readonly select: (
    query: string,
  ) => Promise<import('../memory/types.js').WisdomInjectPick[]>;
  private readonly onInjected?: (ids: string[]) => void | Promise<void>;

  constructor(options: {
    select: (query: string) => Promise<import('../memory/types.js').WisdomInjectPick[]>;
    /** S1 applied 入账（注入命中） */
    onInjected?: (ids: string[]) => void | Promise<void>;
    order?: number;
  }) {
    super('wisdom', { order: options.order, placement: 'snapshot' });
    this.select = options.select;
    this.onInjected = options.onInjected;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    const picks = await this.select(ctx.query ?? '');
    if (picks.length === 0) return null;
    const body = formatWisdomBody(picks);
    if (!body) return null;
    const text = `# 思维框架\n\n${body}`;
    const { text: truncated, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    // S1：只对实际留在文本里的条目报 sources——truncate 粗滤会裁掉尾部条目，被裁掉的不入账。
    // applied 只记 core/scenario 命中：trial 轮转是保底曝光（bucket='trial'），入账 applied 会
    // 稀释 contestRate、废掉 zero-apply 淘汰、抬高 utility——曝光与「被使用」是两件事。
    // sources 仍含 trial（归因窗口需要真实注入清单，判官才能裁 assisted）。
    const kept = picks.filter((p) => truncated.includes(p.entry.statement));
    const appliedIds = kept.filter((p) => p.bucket !== 'trial').map((p) => p.entry.id);
    if (this.onInjected && appliedIds.length) {
      try {
        await this.onInjected(appliedIds);
      } catch {
        // 入账失败不拖垮装配；结局环可由 evaluate 兜
      }
    }
    return this.content(truncated, {
      dropped,
      sources: kept.map((p) => p.entry.id),
    });
  }
}

// ── 工厂 ──

export interface CreateDefaultLayersOptions {
  personaText?: () => Promise<string> | string;
  skillPromptText?: () => Promise<string> | string;
  runtimeText?: (ctx: LayerAssembleContext) => Promise<string> | string;
  knowledgeCatalog?: KnowledgeCatalogProvider;
  knowledgeMaxEntries?: number;
  knowledgeGroupByScope?: boolean;
  knowledgeShowProgress?: 'off' | 'bucket' | 'exact';
  memoryStore?: MemoryStore;
  cognitionStore?: ConceptGraphStore;
  wisdomStore?: import('../memory/types.js').WisdomStore;
  wisdomCoreMaxItems?: number;
  wisdomScenarioMaxItems?: number;
  /** trial 轮转试用名额（wisdom.injection.trialMaxItems；缺省 2——保底曝光打破晋升死锁；0 关闭） */
  wisdomTrialMaxItems?: number;
  /** trial 可见性（wisdom.injection.trialVisible；缺省 true——trial 的意义就是被试用） */
  wisdomIncludeTrial?: boolean;
}

/**
 * 按可用依赖创建启用层列表
 *
 * 未提供的依赖对应层直接不注册（而不是注册空层），
 * 避免 manifest 里出现永远 empty 的噪声层。
 */
/**
 * 造默认层集合（外置/定制装配用）。
 *
 * 注意：技能索引冻结+增量（设计 §7）只在 `createDefaultSystemPromptAssembler`
 * 路径生效（需 freeze 配置）；本工厂产出的 SkillLayer 为实时渲染（历史行为）。
 */
export function createDefaultLayers(options: CreateDefaultLayersOptions): ContextLayer[] {
  const layers: ContextLayer[] = [];

  if (options.wisdomStore) {
    const store = options.wisdomStore;
    layers.push(
      new WisdomLayer({
        select: async (query) => {
          const picks = await store.selectForInjection({
            text: query,
            coreMaxItems: options.wisdomCoreMaxItems,
            scenarioMaxItems: options.wisdomScenarioMaxItems,
            trialMaxItems: options.wisdomTrialMaxItems,
            includeTrial: options.wisdomIncludeTrial,
          });
          return picks;
        },
        onInjected: (ids) => store.touchApplied(ids),
      }),
    );
  }
  if (options.personaText) {
    layers.push(new PersonaLayer({ getText: options.personaText }));
  }
  if (options.skillPromptText) {
    layers.push(new SkillLayer({ getPromptText: options.skillPromptText }));
  }
  if (options.knowledgeCatalog) {
    layers.push(
      new KnowledgeLayer({
        getCatalog: options.knowledgeCatalog,
        maxEntries: options.knowledgeMaxEntries,
        groupByScope: options.knowledgeGroupByScope,
        showProgress: options.knowledgeShowProgress,
      }),
    );
  }
  if (options.cognitionStore) {
    layers.push(new CognitionLayer({ store: options.cognitionStore }));
  }
  if (options.memoryStore) {
    layers.push(new MemoryLayer({ store: options.memoryStore }));
  }
  if (options.runtimeText) {
    layers.push(new RuntimeLayer({ getText: options.runtimeText }));
  }

  return layers;
}
