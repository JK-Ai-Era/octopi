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
import type { KnowledgeStore } from './knowledge/types.js';

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

// ── Knowledge（薄检索） ──

export class KnowledgeLayer extends BaseLayer {
  private readonly store: KnowledgeStore;
  private readonly limit: number;
  private readonly minConfidence: number;

  constructor(options: {
    store: KnowledgeStore;
    limit?: number;
    minConfidence?: number;
    order?: number;
  }) {
    super('knowledge', { order: options.order });
    this.store = options.store;
    this.limit = options.limit ?? 5;
    this.minConfidence = options.minConfidence ?? 0.3;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    if (!ctx.query?.trim()) return null;
    const entries = await this.store.retrieve(ctx.query, {
      limit: this.limit,
      minConfidence: this.minConfidence,
      updateAccess: true,
    });
    if (entries.length === 0) return null;

    const body = entries
      .map((e) => `- [${e.type}] ${e.content} (confidence: ${e.confidence})`)
      .join('\n');
    const text = `# 相关知识\n\n${body}`;
    const { text: truncated, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(truncated, {
      dropped,
      sources: entries.map((e) => e.id),
    });
  }
}

// ── Memory（薄召回） ──

export class MemoryLayer extends BaseLayer {
  private readonly store: MemoryStore;
  private readonly limit: number;

  constructor(options: { store: MemoryStore; limit?: number; order?: number }) {
    super('memory', { order: options.order });
    this.store = options.store;
    this.limit = options.limit ?? 5;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    if (!ctx.query?.trim()) return null;
    const entries = await this.store.retrieve({
      text: ctx.query,
      limit: this.limit,
      updateAccess: true,
    });
    if (entries.length === 0) return null;

    const body = entries.map((m: { type: string; content: string }) => `- [${m.type}] ${m.content}`).join('\n');
    const text = `# 相关记忆\n\n${body}`;
    const { text: truncated, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(truncated, {
      dropped,
      sources: entries.map((e: { id: string }) => e.id),
    });
  }
}

// ── Cognition（薄图谱片段） ──

export class CognitionLayer extends BaseLayer {
  private readonly store: ConceptGraphStore;
  private readonly depth: number;

  constructor(options: { store: ConceptGraphStore; depth?: number; order?: number }) {
    super('cognition', { order: options.order });
    this.store = options.store;
    this.depth = options.depth ?? 1;
  }

  async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
    if (!ctx.query?.trim()) return null;
    const graph = await resolveCognitionGraph(this.store, ctx.query, this.depth);
    if (!graph.nodes.length) return null;

    const lines: string[] = [];
    for (const edge of graph.edges) {
      const source = graph.nodes.find((n: { id: string }) => n.id === edge.sourceId);
      const target = graph.nodes.find((n: { id: string }) => n.id === edge.targetId);
      if (source && target) {
        const desc = edge.description ? ` (${edge.description})` : '';
        lines.push(`- ${source.name} —[${edge.relationType}]→ ${target.name}${desc}`);
      }
    }
    // 无边时仍列出命中概念，避免「有节点却整层 empty」
    if (lines.length === 0) {
      for (const node of graph.nodes) {
        const desc = node.description ? `: ${node.description}` : '';
        lines.push(`- ${node.name}${desc}`);
      }
    }
    if (lines.length === 0) return null;

    const text = `# 相关概念\n\n${lines.join('\n')}`;
    const { text: truncated, dropped } = this.truncateToBudget(text, ctx.tokenBudget);
    return this.content(truncated, {
      dropped,
      sources: graph.nodes.map((n: { id: string }) => n.id),
    });
  }
}

/**
 * 解析认知图：先 store.queryRelated，失败则从全图按「概念名 ⊆ query」筛种子再扩边
 *
 * @param store - ConceptGraphStore
 * @param query - 检索文本（通常为最近用户消息）
 * @param depth - 扩展深度
 * @returns 命中的子图（可能为空）
 */
async function resolveCognitionGraph(
  store: ConceptGraphStore,
  query: string,
  depth: number,
): Promise<{ nodes: Array<{ id: string; name: string; description?: string }>; edges: Array<{ sourceId: string; targetId: string; relationType: string; description?: string }> }> {
  const direct = await store.queryRelated(query, depth);
  if (direct.nodes.length) return direct;

  const full = await store.getFullGraph();
  const q = query.toLowerCase();
  const seeds = full.nodes.filter((n) => n.name && q.includes(n.name.toLowerCase()));
  if (!seeds.length) return { nodes: [], edges: [] };

  const collected = new Map(seeds.map((n) => [n.id, n]));
  const nodeById = new Map(full.nodes.map((n) => [n.id, n]));
  const visited = new Set(seeds.map((n) => n.id));
  const queue = seeds.map((n) => ({ id: n.id, d: 0 }));
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    if (d >= depth) continue;
    for (const e of full.edges) {
      const neighborId = e.sourceId === id ? e.targetId : e.targetId === id ? e.sourceId : null;
      if (!neighborId || visited.has(neighborId)) continue;
      const node = nodeById.get(neighborId);
      if (!node) continue;
      visited.add(neighborId);
      collected.set(neighborId, node);
      queue.push({ id: neighborId, d: d + 1 });
    }
  }
  const edges = full.edges.filter((e) => collected.has(e.sourceId) && collected.has(e.targetId));
  return { nodes: [...collected.values()], edges };
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
  knowledgeStore?: KnowledgeStore;
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
  if (options.knowledgeStore) {
    layers.push(new KnowledgeLayer({ store: options.knowledgeStore }));
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
