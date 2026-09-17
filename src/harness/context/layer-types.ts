/**
 * ContextLayer — 七层上下文内容契约
 *
 * @layer harness/context
 *
 * 与 ContextEngine 的分工：
 * - ContextLayer / ContextAssembler：决定 **system prompt 里有什么**
 *   （Wisdom / Persona / Skill / Knowledge / Cognition / Memory / Runtime）
 * - ContextEngine：决定 **消息窗口怎么压**
 *   （Information 层，选择 / 路由 / 压缩）
 *
 * 契约优先：本文件只定义层接口与装配输入输出。
 * 各层业务实现（检索、打分、落盘）可在后续迭代中逐个替换，
 * 不改变本契约。
 */

import type { Message } from '../../core/types.js';

// ── 层标识 ──

/**
 * System prompt 内容层（契约 id）
 *
 * 排列顺序：Wisdom → Persona → Skill → Knowledge → Cognition → Memory → Runtime。
 *
 * **产品七层概念模型的第 7 层是 Information（session 消息）**，不是本契约里的 runtime。
 * Information 由 ContextEngine 管消息窗口，**不是** ContextLayer。
 * runtime 是契约附加层：injectedContext（任务/guidance）等 system 侧动态注入。
 */
export type ContextLayerId =
  | 'wisdom'
  | 'persona'
  | 'skill'
  | 'knowledge'
  | 'cognition'
  | 'memory'
  | 'runtime';

/**
 * 默认层顺序（数字越小越靠 system prompt 前部）
 *
 * 注意：`defaultShare` **不再**驱动 Assembler 全局配额。
 * 预算默认只控 system 总量 + priority 竞争；
 * 仅 `DefaultContextAssemblerConfig.layerShares` / assemble 参数里显式配置的层
 * 才有硬顶（floor(contentBudget × share)）。
 */
export const LAYER_ORDER: Record<ContextLayerId, number> = {
  wisdom: 10,
  persona: 20,
  skill: 30,
  knowledge: 40,
  cognition: 50,
  memory: 60,
  /** 会话任务 / 子系统 guidance 等每轮动态注入，靠近对话侧 */
  runtime: 70,
};

/** 默认层优先级（预算竞争时越大越先保留） */
export const LAYER_PRIORITY: Record<ContextLayerId, number> = {
  persona: 100,
  runtime: 80,
  wisdom: 70,
  skill: 60,
  knowledge: 40,
  memory: 30,
  cognition: 20,
};

/**
 * 历史默认 share（文档/UI 参考；Assembler 默认不读此表做配额）
 *
 * 需要单层硬顶时，在 contextAssembler.layerShares 配置对应层。
 */
export const LAYER_DEFAULT_SHARE: Record<ContextLayerId, number> = {
  persona: 0.35,
  wisdom: 0.12,
  skill: 0.15,
  knowledge: 0.12,
  memory: 0.10,
  cognition: 0.06,
  runtime: 0.10,
};

// ── 装配上下文 ──

/**
 * 每层 assemble 时可见的会话视图
 *
 * 注意：这里 **不** 含完整工具列表与 token 全局状态之外的引擎内部结构，
 * 层实现只依赖消息与显式预算，便于单独测试与替换。
 */
export interface LayerAssembleContext {
  sessionId: string;
  agentId?: string;
  /** 当前完整消息历史（含本轮用户输入） */
  messages: Message[];
  /**
   * 检索用查询文本。
   * 默认由 Assembler 从最近用户消息提取；层可忽略。
   */
  query?: string;
  /** 本层本轮可用 token 预算 */
  tokenBudget: number;
  /** system prompt 总 token 预算（供需要全局视野的层参考） */
  systemBudget: number;
  signal?: AbortSignal;
}

// ── 层输出 ──

/** 单层产出 */
export interface LayerContent {
  layerId: ContextLayerId;
  /** 已格式化的注入正文（含标题时由层自行决定） */
  text: string;
  /** 正文估算 token（层负责填，Assembler 可覆写校准） */
  tokens: number;
  /** 层内截断/丢弃说明（可观测；不进入 system prompt） */
  dropped?: string;
  /** 溯源：文件路径、memory id、skill id 等 */
  sources?: string[];
}

// ── 层接口 ──

/**
 * ContextLayer — 单层内容提供者
 *
 * 实现约束：
 * - `assemble` 返回 `null`/空 text 表示本层本轮无内容（不算失败）
 * - 层 **不得** 直接改写其他层内容；只产出自己的片段
 * - 层 **不得** 假设自己一定被纳入最终 system（Assembler 可能因预算丢弃）
 */
export interface ContextLayer {
  readonly id: ContextLayerId;
  /** 预算竞争优先级，越大越先保留 */
  readonly priority: number;
  /** system 预算默认份额 [0,1]，启用层之间归一化 */
  readonly defaultShare: number;
  /** 预算不足时是否允许整层丢弃；persona 通常 false */
  readonly droppable: boolean;
  /** system prompt 中的位置（小的在前） */
  readonly order: number;

  /**
   * 变更指纹。与上次不同则强制重新 assemble；返回 null 表示每轮都重算。
   *
   * 典型：
   * - persona：文件 path:mtime:size
   * - skill：技能列表 id+desc 摘要
   * - memory/knowledge：可每轮重算（返回 null）
   */
  fingerprint?(ctx: LayerAssembleContext): Promise<string | null> | string | null;

  /** 产出本层内容；空则跳过 */
  assemble(ctx: LayerAssembleContext): Promise<LayerContent | null>;
}

// ── 装配结果 ──

/** 装配清单（可观测，不进入模型输入） */
export interface LayerManifestEntry {
  id: ContextLayerId;
  included: boolean;
  tokens: number;
  /** 本层硬顶 token（仅 layerShares 配置过的层）；无单层上限时缺省 */
  budgetTokens?: number;
  priority: number;
  order: number;
  /** 本轮装配时该层的 droppable（以 ContextLayer 实例为准） */
  droppable?: boolean;
  /** 未纳入或截断的原因 */
  reason?: string;
  dropped?: string;
  sources?: string[];
  /** 层正文截断预览（仅 includeLayerPreview 时写入；不进入模型输入） */
  preview?: string;
  /**
   * 层正文全文（includeLayerContent 时写入；供 Web 检查器点选查看）
   * 不进入模型输入。WS 广播会剥离此字段，仅 REST 提供。
   */
  content?: string;
}

export interface AssembleManifest {
  sessionId: string;
  /** system 总预算 */
  systemBudget: number;
  /** 结构预留（分隔符等） */
  structureReserve?: number;
  /** 实际使用的 token */
  usedTokens: number;
  /**
   * 显式配置的 layerShares 硬顶比例（未配置的层不出现）
   * 不再表示「启用层归一化后的全局配额」
   */
  shares: Partial<Record<ContextLayerId, number>>;
  layers: LayerManifestEntry[];
}

export interface SystemAssembleResult {
  /** 组装后的 system prompt（不含消息窗口内容） */
  systemPrompt: string;
  manifest: AssembleManifest;
}

// ── 装配器 ──

export interface ContextAssembler {
  /**
   * 组装 system prompt
   *
   * @param params.layers - 本轮启用的层（顺序无关，Assembler 按 order 排序）
   */
  assemble(params: ContextAssembleParams): Promise<SystemAssembleResult>;
}

export interface ContextAssembleParams {
  sessionId: string;
  agentId?: string;
  messages: Message[];
  /** system prompt 总 token 预算 */
  systemBudget: number;
  /** 启用层；缺省空数组则产出空 system */
  layers: ContextLayer[];
  /** 检索查询；缺省从 messages 提取 */
  query?: string;
  /**
   * 单层硬顶比例（覆盖/合并构造器配置）：id → contentBudget 比例。
   * 仅配置的层生效；未配置层无单层上限。
   */
  layerShares?: Partial<Record<ContextLayerId, number>>;
  tokenEstimator?: {
    estimateText(text: string): number;
  };
  signal?: AbortSignal;
}

// ── 工具函数 ──

/** 从消息中提取默认检索查询（最近用户文本） */
export function extractLayerQuery(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
    }
  }
  return '';
}

/** 启用层是否产生非空正文 */
export function hasLayerText(content: LayerContent | null | undefined): content is LayerContent {
  return !!content && content.text.trim().length > 0;
}
