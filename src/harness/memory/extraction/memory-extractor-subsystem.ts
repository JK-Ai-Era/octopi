/**
 * Memory Extraction — memory-extractor 子系统规格（骨架）
 *
 * 说明：
 * - 这是一个“自治子系统”的注册规格定义
 * - Sense：监听 session 生命周期事件（通用），并由 condition 过滤 `recent + pending`
 * - Think：code handler，调用 SessionExtractor 生成 MemoryCandidate
 * - Act：inject + target=memory-store（语义动作，入库由 handler 完成）
 * - Signal：发布 memory.extracted（通用信号）
 *
 * 本模块不包含具体业务策略，只负责规格拼装与默认 handler。
 *
 * @module harness/memory/extraction/memory-extractor-subsystem
 */

import type { SubsystemSpec } from '../../autonomous-subsystem/types.js';
import type { MemoryStore } from '../types.js';
import { SessionExtractor, type SessionExtractBundle } from './session-extractor.js';
import { MemoryDeduplicator, type MemoryDeduplicatorOptions } from './memory-deduplicator.js';
import { defaultThresholdPolicy, type ThresholdPolicy } from './threshold-policy.js';
import type { ThresholdPolicyInput } from './threshold-policy.js';

// ── Options ──

export interface MemoryExtractorSubsystemOptions {
  /** 子系统 ID（默认 memory.extractor） */
  id?: string;
  /** 记忆存储实现 */
  memoryStore: MemoryStore;
  /** 去重与升级配置（可选） */
  deduplicator?: MemoryDeduplicatorOptions;
  /** 最低置信度阈值（静态兜底，默认 0.6） */
  minConfidence?: number;
  /** 最低重要性阈值（静态兜底，默认 0.6） */
  minImportance?: number;
  /** 动态阈值策略（可选，默认按 failureRate/majorErrors/eventCount 调整） */
  thresholdPolicy?: ThresholdPolicy;
  /** Agent profile 名称（可传入给阈值策略做多场景复用） */
  agentProfile?: string;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

/**
 * 创建 memory-extractor 子系统规格
 *
 * @param options - 配置项
 * @returns SubsystemSpec + 默认 think handler（供 SubsystemRuntime.register 使用）
 */
export function createMemoryExtractorSubsystem(options: MemoryExtractorSubsystemOptions) {
  const id = options.id ?? 'memory.extractor';
  const extractor = new SessionExtractor();
  const deduper = new MemoryDeduplicator(options.memoryStore, options.deduplicator);

  const spec: SubsystemSpec = {
    id,
    name: 'Memory Extractor',
    description: '从主会话生命周期事件中提取结构化记忆候选（自治子系统）',
    sense: {
      // 通用感知源：事件驱动
      source: 'eventBus',
      filter: {
        // 监听通用事件：包含 session 生命周期与 extractor bundle ready
        events: ['session.lifecycle.updated', 'memory.extractor.bundle.ready'],
        // 语言无关的声明式条件：优先匹配 recent + pending；当 bundle 事件到达时也允许触发
        condition: "(sessionLifecycle === 'recent' && extractionStatus === 'pending') || (eventData?.bundle != null)",
      },
      isolation: 'structured',
    },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async (input) => {
        // 从 payload 中获取结构化 bundle（由上游采集器提供）
        // 兼容两条注入路径：SubsystemInput.payload 或 SenseContext.eventData（bridge 会发射 bundle.ready）
        const payloadBundle = (input.payload?.sessionExtractBundle ?? undefined) as SessionExtractBundle | undefined;
        const bundle = (payloadBundle ?? {
          sessionId: input.sessionMetadata?.sessionId ?? 'unknown',
          agentId: input.sessionMetadata?.agentId ?? 'unknown',
          startAt: Date.now(),
          events: [],
          condensedTurns: [],
          runSummary: { totalTurns: 0, totalToolCalls: 0, failureRate: 0, majorErrors: [], resolvedErrors: [] },
        }) as SessionExtractBundle;

        const candidates = extractor.extract(bundle);
        const deduped = await deduper.filterAndUpgrade(candidates);
        const policyInput: ThresholdPolicyInput & { agentProfile?: string } = { runSummary: bundle.runSummary, eventCount: bundle.events.length, agentProfile: options.agentProfile };
        const dynamic = (options.thresholdPolicy ?? defaultThresholdPolicy)(policyInput);
        const minConf = dynamic.minConfidence ?? options.minConfidence ?? 0.6;
        const minImp = dynamic.minImportance ?? options.minImportance ?? 0.6;
        const accepted = deduped.filter((c) => c.confidence >= minConf && c.importance >= minImp);
        const gated = deduped.length - accepted.length;

        // 入库（Act 语义：inject to memory-store）
        for (const c of accepted) {
          await options.memoryStore.store({
            type: c.type,
            content: c.content,
            source: c.source,
            confidence: c.confidence,
            importance: c.importance,
            tags: c.tags,
          });
        }

        // 返回信号（通用）
        return {
          act: {
            mode: 'inject',
            status: 'success',
            target: 'memory-store',
            messages: [
              {
                role: 'system',
                content: `memory.extracted accepted=${accepted.length} candidates=${candidates.length}`,
              },
            ],
          },
          signals: [
            {
              action: 'suggest',
              reason: `Memory extraction completed (accepted=${accepted.length}, candidates=${candidates.length})`,
              confidence: 0.9,
              data: {
                extractedCount: accepted.length,
                rawCandidateCount: candidates.length,
                dedupedCount: deduped.length,
                gatedCount: gated,
                bundleSessionId: bundle.sessionId,
              },
            },
          ],
        };
      },
    },
    act: {
      mode: 'inject',
    },
    signal: {
      severity: 'info',
      channel: ['context', 'event'],
    },
    boundary: {
      visibility: 'structured',
      authority: 'act',
      security: 'trusted',
    },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    lifecycle: {
      maxConcurrent: 1,
    },
  };

  return {
    id,
    spec,
    enabled: options.enabled ?? true,
  };
}
