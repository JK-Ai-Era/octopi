/**
 * AssembleManifest → ContextLayersSnapshot（Web/可观测 DTO）
 *
 * UI 只消费本快照，不在前端重算层状态。
 * 未注册 / 空 / 丢弃 / 失败 是四种不同事实。
 */

import type { AssembleManifest, ContextLayerId, LayerManifestEntry } from './layer-types.js';
import { LAYER_ORDER, LAYER_PRIORITY } from './layer-types.js';

/** 全量层 id（含 Information 之外的契约层；UI 始终展示这 7 行） */
export const ALL_LAYER_IDS: readonly ContextLayerId[] = [
  'wisdom',
  'persona',
  'skill',
  'knowledge',
  'cognition',
  'memory',
  'runtime',
] as const;

export type LayerUiStatus =
  | 'idle'
  | 'included'
  | 'empty'
  | 'dropped'
  | 'error'
  | 'unregistered';

export interface LayerRuntimeView {
  id: ContextLayerId;
  status: LayerUiStatus;
  included: boolean;
  tokens: number;
  budgetTokens: number;
  priority: number;
  order: number;
  droppable: boolean;
  reason?: string;
  dropped?: string;
  sources?: string[];
  /** 层正文截断预览 */
  preview?: string;
  /** 层正文全文（通常仅 REST；WS 事件会剥离） */
  content?: string;
}

export interface ContextLayersSnapshot {
  sessionId: string;
  assembledAt?: number;
  systemBudget: number;
  structureReserve?: number;
  usedTokens: number;
  shares: Partial<Record<ContextLayerId, number>>;
  query?: string;
  /** 恒为契约层顺序，便于 UI 直接渲染 */
  layers: LayerRuntimeView[];
  enabledLayerIds: ContextLayerId[];
  /** 装配失败回退字符串拼接时为 true */
  fallback?: boolean;
  fallbackError?: string;
}

/**
 * 将 manifest 映射为 UI 快照（始终 7 层；缺注册的层标 unregistered）
 *
 * @param params.manifest - Assembler 产出
 * @param params.enabledLayerIds - 本轮启用层；缺省用 manifest.layers 的 id
 * @param params.query - 检索查询（可选）
 * @param params.assembledAt - 时间戳（可选）
 * @param params.fallback - 是否走了 concat 回退
 * @returns ContextLayersSnapshot
 */
export function buildContextLayersSnapshot(params: {
  manifest: AssembleManifest;
  enabledLayerIds?: ContextLayerId[];
  query?: string;
  assembledAt?: number;
  fallback?: boolean;
  fallbackError?: string;
}): ContextLayersSnapshot {
  const { manifest } = params;
  const entryById = new Map<ContextLayerId, LayerManifestEntry>();
  for (const entry of manifest.layers) {
    entryById.set(entry.id, entry);
  }
  const enabled =
    params.enabledLayerIds ??
    manifest.layers.map((l) => l.id);
  const enabledSet = new Set(enabled);

  const layers: LayerRuntimeView[] = ALL_LAYER_IDS.map((id) => {
    const entry = entryById.get(id);
    const droppable =
      entry?.droppable ?? (id !== 'persona');
    const base = {
      id,
      priority: entry?.priority ?? LAYER_PRIORITY[id],
      order: entry?.order ?? LAYER_ORDER[id],
      droppable,
    };
    if (!entry && !enabledSet.has(id)) {
      return {
        ...base,
        status: 'unregistered' as const,
        included: false,
        tokens: 0,
        budgetTokens: 0,
        reason: 'not registered in production assembler',
      };
    }
    if (!entry) {
      return {
        ...base,
        status: 'idle' as const,
        included: false,
        tokens: 0,
        budgetTokens: 0,
      };
    }
    return {
      id,
      status: deriveLayerStatus(entry),
      included: entry.included,
      tokens: entry.tokens,
      budgetTokens: entry.budgetTokens ?? 0,
      priority: entry.priority,
      order: entry.order,
      droppable: entry.droppable ?? droppable,
      reason: entry.reason,
      dropped: entry.dropped,
      sources: entry.sources,
      preview: entry.preview,
      content: entry.content,
    };
  });

  return {
    sessionId: manifest.sessionId,
    assembledAt: params.assembledAt,
    systemBudget: manifest.systemBudget,
    structureReserve: manifest.structureReserve,
    usedTokens: manifest.usedTokens,
    shares: manifest.shares,
    query: params.query,
    layers,
    enabledLayerIds: ALL_LAYER_IDS.filter((id) => enabledSet.has(id)),
    fallback: params.fallback,
    fallbackError: params.fallbackError,
  };
}

/** 从 manifest 条目推导 UI 状态 */
export function deriveLayerStatus(entry: LayerManifestEntry): LayerUiStatus {
  if (entry.included) return 'included';
  const reason = entry.reason ?? '';
  if (/assemble failed/i.test(reason)) return 'error';
  if (reason === 'empty' || reason === '') return 'empty';
  if (/budget|truncated to empty|exhausted/i.test(reason)) return 'dropped';
  return 'empty';
}

/**
 * 构造「尚无装配」的空快照（UI 教学空态用）
 *
 * @param sessionId - 会话 id
 * @returns 七层均为 idle 的快照
 */
export function emptyContextLayersSnapshot(sessionId: string): ContextLayersSnapshot {
  return {
    sessionId,
    systemBudget: 0,
    usedTokens: 0,
    // 默认无 layerShares 硬顶；历史 LAYER_DEFAULT_SHARE 不再驱动装配
    shares: {},
    layers: ALL_LAYER_IDS.map((id) => ({
      id,
      status: 'idle' as const,
      included: false,
      tokens: 0,
      budgetTokens: 0,
      priority: LAYER_PRIORITY[id],
      order: LAYER_ORDER[id],
      droppable: id !== 'persona',
    })),
    enabledLayerIds: [],
  };
}
