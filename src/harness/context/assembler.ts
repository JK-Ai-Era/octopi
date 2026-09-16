/**
 * DefaultContextAssembler — 按层契约组装 system prompt
 *
 * 职责边界：
 * - 读入 ContextLayer[]，按 order 排序
 * - 在启用层之间按 defaultShare 归一化分配 token 预算
 * - 并行 assemble，按 priority 从高到低纳入，超预算时丢弃/截断低优先层
 * - 产出 SystemAssembleResult（systemPrompt + AssembleManifest）
 *
 * 不做的事：
 * - 不管理消息窗口（ContextEngine / DefaultContextEngine）
 * - 不实现检索/打分（那是各层自己的事）
 */

import type { Message } from '../../core/types.js';
import type {
  AssembleManifest,
  ContextAssembleParams,
  ContextAssembler,
  ContextLayer,
  ContextLayerId,
  LayerAssembleContext,
  LayerContent,
  LayerManifestEntry,
  SystemAssembleResult,
} from './layer-types.js';
import { extractLayerQuery, hasLayerText, LAYER_ORDER } from './layer-types.js';
import { HeuristicTokenEstimator } from './token-estimator.js';

/** 层间分隔（与 PersonaSource 保持一致） */
const LAYER_SEPARATOR = '\n\n---\n\n';

/** fingerprint 缓存上限（防 daemon 长驻泄漏） */
const MAX_FINGERPRINT_SESSIONS = 256;

/**
 * droppable 层「塞进剩余预算」的最小可用 token 地板
 * 再小则截断后几乎无信息量，直接丢弃更干净。
 */
const MIN_REMAINING_TOKENS = 40;

/**
 * 用统一 TokenEstimator 将文本截到 maxTokens 内
 *（二分字符长度；避免层内 chars/token 启发式与装配预算不一致）
 */
export function truncateTextToTokens(
  text: string,
  maxTokens: number,
  estimator: { estimateText(text: string): number },
): { text: string; dropped?: string } {
  if (maxTokens <= 0) return { text: '', dropped: 'zero budget' };
  if (estimator.estimateText(text) <= maxTokens) return { text };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimator.estimateText(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return {
    text: text.slice(0, lo),
    dropped: `truncated to ${lo} chars (~${maxTokens} tokens)`,
  };
}

export interface DefaultContextAssemblerConfig {
  /** 总预算中预留给分隔符/结构的 token，默认 50 */
  structureReserve?: number;
  /** 单层文本硬上限占其份额的比例（>1 表示允许略超），默认 1.0 */
  layerOverflowRatio?: number;
}

export class DefaultContextAssembler implements ContextAssembler {
  private readonly structureReserve: number;
  private readonly layerOverflowRatio: number;
  /** sessionId → layerId → fingerprint，用于跳过未变更层的重复 assemble */
  private readonly fingerprints = new Map<string, Map<ContextLayerId, string | null>>();

  constructor(config?: DefaultContextAssemblerConfig) {
    this.structureReserve = config?.structureReserve ?? 50;
    this.layerOverflowRatio = config?.layerOverflowRatio ?? 1.0;
  }

  async assemble(params: ContextAssembleParams): Promise<SystemAssembleResult> {
    const {
      sessionId,
      agentId,
      messages,
      systemBudget,
      layers,
      signal,
    } = params;

    const estimator = params.tokenEstimator ?? new HeuristicTokenEstimator();
    const query = params.query ?? extractLayerQuery(messages);
    const ordered = [...layers].sort((a, b) => a.order - b.order);

    if (ordered.length === 0 || systemBudget <= 0) {
      return {
        systemPrompt: '',
        manifest: {
          sessionId,
          systemBudget,
          usedTokens: 0,
          shares: {},
          layers: [],
        },
      };
    }

    const contentBudget = Math.max(0, systemBudget - this.structureReserve);
    const shares = normalizeShares(ordered);
    const budgets = allocateBudgets(ordered, shares, contentBudget);

    // 并行 assemble（层之间无依赖）
    const assembled = await Promise.all(
      ordered.map(async (layer) => {
        const budget = budgets.get(layer.id) ?? 0;
        const ctx: LayerAssembleContext = {
          sessionId,
          agentId,
          messages,
          query,
          tokenBudget: budget,
          systemBudget,
          signal,
        };

        // 指纹未变则视为「本层无新内容」的轻量跳过：
        // 当前实现仍每轮调用 assemble（层可能依赖 query），
        // 指纹仅写入 manifest 供观测；缓存复用留给后续层实现。
        const fp = layer.fingerprint ? await layer.fingerprint(ctx) : null;
        this.rememberFingerprint(sessionId, layer.id, fp);

        let content: LayerContent | null = null;
        try {
          content = await layer.assemble(ctx);
        } catch (err) {
          // 单层失败不拖垮整体装配
          return {
            layer,
            budget,
            content: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        // 用统一估算器校准层自报 token
        if (content && hasLayerText(content)) {
          content = {
            ...content,
            tokens: estimator.estimateText(content.text),
          };
        }

        return { layer, budget, content, error: undefined as string | undefined };
      }),
    );

    // 按 priority 从高到低纳入，直到预算耗尽
    const byPriority = [...assembled].sort(
      (a, b) => b.layer.priority - a.layer.priority || a.layer.order - b.layer.order,
    );

    const accepted = new Map<ContextLayerId, { content: LayerContent; layer: ContextLayer }>();
    const rejections = new Map<ContextLayerId, string>();
    let used = 0;

    for (const item of byPriority) {
      const { layer, error, budget } = item;
      let content = item.content;

      if (error) {
        rejections.set(layer.id, `assemble failed: ${error}`);
        continue;
      }
      if (!hasLayerText(content)) {
        rejections.set(layer.id, 'empty');
        continue;
      }

      const maxTokens = Math.floor(budget * this.layerOverflowRatio);
      if (content.tokens > maxTokens) {
        // 统一用 estimator 截断到份额内，而不是直接整层丢弃
        const cut = truncateTextToTokens(content.text, maxTokens, estimator);
        if (!cut.text.trim()) {
          rejections.set(layer.id, `over budget (${content.tokens} > ${maxTokens}) and truncated to empty`);
          continue;
        }
        content = {
          ...content,
          text: cut.text,
          tokens: estimator.estimateText(cut.text),
          dropped: content.dropped ?? cut.dropped,
        };
      }

      // 总预算：droppable 层装不下则丢；不可丢弃层保留截断后结果（manifest 记告警）
      if (used + content.tokens > contentBudget) {
        if (!layer.droppable) {
          accepted.set(layer.id, { content, layer });
          used += content.tokens;
          rejections.set(layer.id, `system budget exhausted but kept (droppable=false)`);
          continue;
        }
        const remaining = contentBudget - used;
        if (remaining >= MIN_REMAINING_TOKENS) {
          const cut = truncateTextToTokens(content.text, remaining, estimator);
          if (cut.text.trim()) {
            content = {
              ...content,
              text: cut.text,
              tokens: estimator.estimateText(cut.text),
              dropped: content.dropped ?? cut.dropped,
            };
            accepted.set(layer.id, { content, layer });
            used += content.tokens;
            continue;
          }
        }
        rejections.set(layer.id, `system budget exhausted (used=${used}, need=${content.tokens})`);
        continue;
      }

      accepted.set(layer.id, { content, layer });
      used += content.tokens;
    }

    // 按 order 拼接
    const parts: string[] = [];
    for (const layer of ordered) {
      const hit = accepted.get(layer.id);
      if (hit && hasLayerText(hit.content)) {
        parts.push(hit.content.text.trim());
      }
    }
    const systemPrompt = parts.join(LAYER_SEPARATOR);

    const manifestLayers: LayerManifestEntry[] = ordered.map((layer) => {
      const hit = accepted.get(layer.id);
      const reason = rejections.get(layer.id);
      const item = assembled.find((a) => a.layer.id === layer.id);
      return {
        id: layer.id,
        included: !!hit,
        tokens: hit?.content.tokens ?? 0,
        priority: layer.priority,
        order: layer.order,
        // included=true 时 reason 表示告警（如 over budget but kept）
        reason,
        dropped: hit?.content.dropped ?? item?.content?.dropped,
        sources: hit?.content.sources ?? item?.content?.sources,
      };
    });

    const manifest: AssembleManifest = {
      sessionId,
      systemBudget,
      usedTokens: used,
      shares,
      layers: manifestLayers,
    };

    return { systemPrompt, manifest };
  }

  private rememberFingerprint(sessionId: string, layerId: ContextLayerId, fp: string | null): void {
    if (!this.fingerprints.has(sessionId) && this.fingerprints.size >= MAX_FINGERPRINT_SESSIONS) {
      // 简单 FIFO：丢掉最早插入的 session
      const oldest = this.fingerprints.keys().next().value;
      if (oldest !== undefined) this.fingerprints.delete(oldest);
    }
    let m = this.fingerprints.get(sessionId);
    if (!m) {
      m = new Map();
      this.fingerprints.set(sessionId, m);
    }
    m.set(layerId, fp);
  }

  /** 会话结束时清理指纹缓存 */
  clearSession(sessionId: string): void {
    this.fingerprints.delete(sessionId);
  }

  /** 读取某层最近指纹（调试/测试用） */
  getFingerprint(sessionId: string, layerId: ContextLayerId): string | null | undefined {
    return this.fingerprints.get(sessionId)?.get(layerId);
  }
}

/** 份额归一化：只在非零份额层之间分配 1.0 */
function normalizeShares(layers: ContextLayer[]): Partial<Record<ContextLayerId, number>> {
  const total = layers.reduce((s, l) => s + Math.max(0, l.defaultShare), 0);
  const shares: Partial<Record<ContextLayerId, number>> = {};
  if (total <= 0) {
    const even = 1 / Math.max(1, layers.length);
    for (const l of layers) shares[l.id] = even;
    return shares;
  }
  for (const l of layers) {
    shares[l.id] = Math.max(0, l.defaultShare) / total;
  }
  return shares;
}

function allocateBudgets(
  layers: ContextLayer[],
  shares: Partial<Record<ContextLayerId, number>>,
  contentBudget: number,
): Map<ContextLayerId, number> {
  const map = new Map<ContextLayerId, number>();
  for (const l of layers) {
    const share = shares[l.id] ?? 0;
    map.set(l.id, Math.floor(contentBudget * share));
  }
  return map;
}

/** 默认层顺序常量导出，便于测试断言 */
export const DEFAULT_LAYER_ORDERS = LAYER_ORDER;
