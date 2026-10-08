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
} from './layer-types.js';
import {
  LAYER_DEFAULT_SHARE,
  LAYER_ORDER,
  LAYER_PRIORITY,
} from './layer-types.js';
import type { MemoryStore, ConceptGraphStore } from '../memory/types.js';
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

  constructor(id: ContextLayerId, overrides?: Partial<Pick<ContextLayer, 'priority' | 'defaultShare' | 'droppable' | 'order'>>) {
    this.id = id;
    this.priority = overrides?.priority ?? LAYER_PRIORITY[id];
    this.defaultShare = overrides?.defaultShare ?? LAYER_DEFAULT_SHARE[id];
    this.droppable = overrides?.droppable ?? id !== 'persona';
    this.order = overrides?.order ?? LAYER_ORDER[id];
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

/** Skill 层 — 包装 SkillManager.formatForPrompt() 索引 */
export class SkillLayer extends BaseLayer {
  private readonly getPromptText: () => Promise<string> | string;

  constructor(options: { getPromptText: () => Promise<string> | string; order?: number }) {
    super('skill', { order: options.order });
    this.getPromptText = options.getPromptText;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    const text = await this.getPromptText();
    const { text: body, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(body, { dropped, sources: ['skills'] });
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
  }) {
    super('runtime', { order: options.order });
    this.getText = options.getText;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    const text = await this.getText(ctx);
    const { text: body, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(body, { dropped, sources: ['runtime'] });
  }
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
      if (desc) lines.push(`  purpose: ${desc}`);
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
    super('memory', { order: options.order });
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
      .map((m: { type: string; content: string; futureUse?: string }) =>
        m.futureUse ? `- [${m.type}] ${m.content} (when: ${m.futureUse})` : `- [${m.type}] ${m.content}`,
      )
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

export class CognitionLayer extends BaseLayer {
  private readonly store: ConceptGraphStore;
  private readonly depth: number;

  constructor(options: { store: ConceptGraphStore; depth?: number; order?: number }) {
    super('cognition', { order: options.order });
    this.store = options.store;
    this.depth = options.depth ?? 2;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    if (!ctx.query?.trim()) return null;
    const queryTokens = ctx.query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 8);
    const seeds = queryTokens.length ? queryTokens : [ctx.query.trim()];

    const graph = await this.store.spreadingActivate(seeds, {
      depth: this.depth,
      limit: 40,
    });
    if (!graph.nodes.length) return null;

    const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
    const strong: string[] = [];
    const weakNames = new Set<string>();

    for (const edge of graph.edges) {
      const source = nameOf.get(edge.sourceId);
      const target = nameOf.get(edge.targetId);
      if (!source || !target) continue;
      if (edge.relationType === 'related' || edge.status === 'shadow') {
        weakNames.add(source);
        weakNames.add(target);
        continue;
      }
      const desc = edge.description ? ` (${edge.description})` : '';
      strong.push(`- ${source} —[${edge.relationType}]→ ${target}${desc}`);
    }

    // 弱边只作折叠相关，不伪造成因果格式
    for (const n of graph.nodes) {
      if (!weakNames.has(n.name) && !strong.some((l) => l.includes(n.name))) {
        weakNames.add(n.name);
      }
    }

    const lines: string[] = [...strong];
    const weak = [...weakNames].filter((name) => !strong.some((l) => l.includes(name)));
    if (weak.length) {
      lines.push(`相关：${weak.join('、')}`);
    }
    if (lines.length === 0) return null;

    const text = `# 相关概念\n\n${lines.join('\n')}`;
    const { text: truncated, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(truncated, {
      dropped,
      sources: graph.nodes.map((n) => n.id),
    });
  }
}

// ── Wisdom（静态/半静态） ──

/**
 * Wisdom 层 — 从 WisdomStore 读取高优先思维范式
 *
 * 当前薄实现：取全部并按 priority 排序后截断。
 * 后续可改为场景匹配 / applicableScenarios 过滤。
 */
export class WisdomLayer extends BaseLayer {
  private readonly getEntries: () => Promise<Array<{ id: string; content: string; priority: number }>>;

  constructor(options: {
    getEntries: () => Promise<Array<{ id: string; content: string; priority: number }>>;
    order?: number;
  }) {
    super('wisdom', { order: options.order });
    this.getEntries = options.getEntries;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    const entries = await this.getEntries();
    if (entries.length === 0) return null;
    const sorted = [...entries].sort((a, b) => b.priority - a.priority);
    const body = sorted.map((w) => w.content).join('\n\n');
    const text = `# 思维框架\n\n${body}`;
    const { text: truncated, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(truncated, {
      dropped,
      sources: sorted.map((e) => e.id),
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
  wisdomEntries?: () => Promise<Array<{ id: string; content: string; priority: number }>>;
}

/**
 * 按可用依赖创建启用层列表
 *
 * 未提供的依赖对应层直接不注册（而不是注册空层），
 * 避免 manifest 里出现永远 empty 的噪声层。
 */
export function createDefaultLayers(options: CreateDefaultLayersOptions): ContextLayer[] {
  const layers: ContextLayer[] = [];

  if (options.wisdomEntries) {
    layers.push(new WisdomLayer({ getEntries: options.wisdomEntries }));
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
