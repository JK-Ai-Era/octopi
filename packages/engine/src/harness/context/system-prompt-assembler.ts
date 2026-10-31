/**
 * SystemPromptAssembler — Runner 每轮 system prompt 装配端口
 *
 * 全局宪法 preamble 固定在最前；层契约见 harness/context。
 */

import type { Message } from '@octopi-agent/core/types.js';
import type { AssembleManifest } from './layer-types.js';
import { DefaultContextAssembler } from './assembler.js';
import type { DefaultContextAssemblerConfig } from './assembler.js';
import {
  CognitionLayer,
  KnowledgeLayer,
  MemoryLayer,
  PersonaLayer,
  RuntimeLayer,
  SkillLayer,
  WisdomLayer,
} from './layers.js';
import type { ContextAssembler, ContextLayer } from './layer-types.js';
import { extractLayerQuery } from './layer-types.js';
import type { ConceptGraphStore, MemoryStore, WisdomStore } from '../memory/types.js';
import type { KnowledgeCatalogProvider } from '../knowledge/catalog-types.js';
import { loadConstitution, type ConstitutionConfig } from './constitution/load-constitution.js';
import { TOOL_PURPOSE_SYSTEM_NOTE } from '../agent/tool-purpose.js';

export interface SystemPromptAssembleInput {
  sessionId: string;
  agentId?: string;
  messages: Message[];
  persona: string;
  /**
   * 运行时注入（**兼容旧契约**：datetime + 稳定锚点 + tasks/guidance 的合并形态）。
   * 提供 `volatileContext` / `runtimeAnchors` 时本字段被忽略；
   * 仅有本字段时整体按**易变**处理进快照（E8：来历不明的动态注入不得进 system 前缀）。
   */
  injectedContext?: string;
  /**
   * 易变注入份（datetime / session tasks / guidance 等）——宪法 E8：
   * 进本轮易变快照（消息尾部），**不进 system prompt**。优先于 `injectedContext`。
   */
  volatileContext?: string;
  /**
   * 稳定运行时锚点（workspace/roots/effectMode/root_instructions）——
   * 留 system prompt（缓存稳定前缀）。
   */
  runtimeAnchors?: string;
  /** 显式配置的上下文窗口；未知时省略 */
  contextWindow?: number;
  /**
   * 检索主题线索（会话任务标题/当前步骤）。
   * 与最近用户消息一起构成 Memory/Cognition 层 query。
   */
  topicHints?: string;
  signal?: AbortSignal;
}

export interface SystemPromptAssembleOutput {
  systemPrompt: string;
  /**
   * 易变快照正文（E8，placement='snapshot' 的层）。
   * 由调用方经本轮消息尾部的 content 插槽送达；无易变层时缺省。
   */
  runtimeSnapshot?: string;
  manifest?: AssembleManifest;
  /**
   * true = 未按 contextWindow 比例做层预算（窗口未知）。
   * 层内容仍会装配（不硬裁）；**不要**据此丢弃 systemPrompt。
   */
  skippedBudget?: boolean;
}

const DEFAULT_SYSTEM_BUDGET_RATIO = 0.22;

/**
 * Turn 信封阅读规则（缓存稳定固定块；永远拼进 system）。
 * 与 `turn-envelope.ts` 语法一一对应。
 */
export const TURN_SEMANTICS_MD = `## Turns (authoritative)

- A **turn** is one \`<turn_start id="tN">\` user message plus every assistant/tool
  message up to its matching \`<turn_end id="tN"/>\`.
- \`<turn_context>\` is **turn-scoped condition** (time, tasks, retrieval picks).
  It is NOT global memory. It expires outside that turn.
- Older turns stay in the transcript frozen. For current work:
  use the latest \`<turn_context>\`; older picks are historical snapshots only;
  the transcript wins over any stale pick.
- Never edit or delete \`<turn_start>\` / \`<turn_end>\` / past tool results.
- If a tool needs old ephemeral detail, re-read the source (session log / files);
  do not assume old picks are still true.`;

/**
 * 缓存稳定固定块（永远拼进 system）：Turn 信封阅读规则置首，purpose 全局说明随后。
 * purpose 详版+示例在此只写一次（方案 S）——schema 侧只留 TOOL_PURPOSE_PARAM 极短 stub。
 */
function withFixedProtocolBlocks(systemPrompt: string): string {
  const body = systemPrompt.trim();
  const head = `${TURN_SEMANTICS_MD}\n\n---\n\n${TOOL_PURPOSE_SYSTEM_NOTE}`;
  return body ? `${head}\n\n---\n\n${body}` : head;
}

export function createDefaultSystemPromptAssembler(options?: {
  assembler?: ContextAssembler;
  assemblerConfig?: DefaultContextAssemblerConfig;
  systemBudgetRatio?: number;
  /** 显式 system 预算 token；与 contextWindow 无关（窗口未知时仍可用） */
  systemBudgetTokens?: number;
  /**
   * 易变快照组（placement='snapshot'）的 token 预算（E8）。
   * 缺省不设上限（与历史行为一致）；部署调参经 `contextAssembler.snapshotBudgetTokens`。
   */
  snapshotBudgetTokens?: number;
  getSkillPromptText?: () => Promise<string> | string;
  memoryStore?: MemoryStore;
  /** Knowledge Tier 0 catalog（有哪些源）；内容命中不进 system */
  knowledgeCatalog?: KnowledgeCatalogProvider;
  wisdomStore?: WisdomStore;
  /** Wisdom 注入条数硬顶 */
  wisdomCoreMaxItems?: number;
  wisdomScenarioMaxItems?: number;
  /** trial 可见性（wisdom.injection.trialVisible；缺省 true——trial 的意义就是被试用） */
  wisdomIncludeTrial?: boolean;
  cognitionStore?: ConceptGraphStore;
  memoryLimit?: number;
  knowledgeMaxEntries?: number;
  knowledgeGroupByScope?: boolean;
  knowledgeShowProgress?: 'off' | 'bucket' | 'exact';
  cognitionDepth?: number;
  /** 全局宪法；提供则 preamble 固定最前 */
  constitution?: ConstitutionConfig | string | null;
  /** 直接注入宪法正文（覆盖 constitution 配置） */
  constitutionText?: string;
}): {
  assemble: (input: SystemPromptAssembleInput) => Promise<SystemPromptAssembleOutput>;
  clearSession: (sessionId: string) => void;
} {
  let preamble = options?.constitutionText ?? '';
  if (!preamble && options?.constitution !== undefined && options?.constitution !== null) {
    if (typeof options.constitution === 'string') {
      preamble = options.constitution;
    } else {
      preamble = loadConstitution(options.constitution).text;
    }
  } else if (!preamble && options?.constitution === undefined && options?.constitutionText === undefined) {
    // Builder 未显式配置时仍装配产品默认宪法（product）
    try {
      preamble = loadConstitution({ mode: 'product' }).text;
    } catch {
      preamble = '';
    }
  }

  const assembler =
    options?.assembler ??
    new DefaultContextAssembler({
      ...options?.assemblerConfig,
      constitutionPreamble: options?.assemblerConfig?.constitutionPreamble ?? preamble,
    });

  // 若外部传入 assembler 且无 preamble，每轮 params 注入
  const passPreamblePerAssemble = Boolean(
    options?.assembler && !(options.assemblerConfig?.constitutionPreamble ?? preamble),
  );

  const ratio = options?.systemBudgetRatio ?? DEFAULT_SYSTEM_BUDGET_RATIO;
  const getSkillPromptText = options?.getSkillPromptText;
  const wisdomStore = options?.wisdomStore;
  const cognitionStore = options?.cognitionStore;
  const resolvedPreamble = options?.assemblerConfig?.constitutionPreamble ?? preamble;

  return {
    clearSession(sessionId: string) {
      const maybe = assembler as Partial<DefaultContextAssembler>;
      if (typeof maybe.clearSession === 'function') {
        maybe.clearSession(sessionId);
      }
    },
    async assemble(input) {
      const hasPersona = Boolean((input.persona ?? '').trim());
      const hasInjected = Boolean(
        (input.injectedContext ?? '').trim() || (input.runtimeAnchors ?? '').trim(),
      );
      let hasSkill = false;
      if (getSkillPromptText) {
        hasSkill = Boolean((await getSkillPromptText()).trim());
      }
      const hasRetrieval = Boolean(
        options?.memoryStore ||
          options?.knowledgeCatalog ||
          wisdomStore ||
          cognitionStore,
      );
      const hasPreamble = Boolean(resolvedPreamble.trim());
      if (!hasPersona && !hasInjected && !hasSkill && !hasRetrieval && !hasPreamble) {
        return { systemPrompt: withFixedProtocolBlocks('') };
      }

      // contextWindow 未知且未配置 systemBudgetTokens：
      // **跳过按窗口比例的预算**，但仍装配层（不按 token 硬裁，保留完整层内容）
      const absoluteBudget = options?.systemBudgetTokens;
      const window = input.contextWindow;
      const windowKnown = window != null && window > 0;
      const skippedBudget = !windowKnown && !(absoluteBudget != null && absoluteBudget > 0);
      const systemBudget = absoluteBudget != null && absoluteBudget > 0
        ? absoluteBudget
        : windowKnown
          ? Math.max(2000, Math.floor(window! * ratio))
          : // 无窗口：给足层内容空间，等价于“不做窗口比例压缩”
            Number.MAX_SAFE_INTEGER;

      const layers: ContextLayer[] = [
        new PersonaLayer({
          getText: () => input.persona ?? '',
          sources: ['persona'],
        }),
      ];
      if (getSkillPromptText) {
        layers.push(new SkillLayer({ getPromptText: getSkillPromptText }));
      }
      if (wisdomStore) {
        layers.push(
          new WisdomLayer({
            select: async (query) => {
              const picks = await wisdomStore.selectForInjection({
                text: query,
                coreMaxItems: options?.wisdomCoreMaxItems,
                scenarioMaxItems: options?.wisdomScenarioMaxItems,
                includeTrial: options?.wisdomIncludeTrial,
              });
              return picks.map((p) => ({ entry: p.entry, bucket: p.bucket }));
            },
            onInjected: (ids) => wisdomStore.touchApplied(ids),
          }),
        );
      }
      if (options?.knowledgeCatalog) {
        layers.push(
          new KnowledgeLayer({
            getCatalog: options.knowledgeCatalog,
            maxEntries: options.knowledgeMaxEntries,
            groupByScope: options.knowledgeGroupByScope,
            showProgress: options.knowledgeShowProgress,
          }),
        );
      }
      if (cognitionStore) {
        layers.push(
          new CognitionLayer({
            store: cognitionStore,
            depth: options?.cognitionDepth,
          }),
        );
      }
      if (options?.memoryStore) {
        layers.push(
          new MemoryLayer({
            store: options.memoryStore,
            limit: options.memoryLimit,
          }),
        );
      }
      // E8 双实例：稳定锚点（workspace/root_instructions）留 system；易变注入（datetime/tasks）进快照。
      // volatileContext 优先（新契约）；仅 injectedContext 时整体按易变处理（E8 缺省）
      layers.push(
        new RuntimeLayer({
          getText: () => input.runtimeAnchors ?? '',
        }),
      );
      layers.push(
        new RuntimeLayer({
          getText: () => input.volatileContext ?? input.injectedContext ?? '',
          placement: 'snapshot',
        }),
      );

      // E8 双组装配：稳定层 → system prompt（含宪法 preamble）；易变层 → 本轮快照
      const systemLayers = layers.filter((l) => (l.placement ?? 'system') !== 'snapshot');
      const snapshotLayers = layers.filter((l) => l.placement === 'snapshot');
      const layerQuery = extractLayerQuery(input.messages, { topicHints: input.topicHints });

      const result = await assembler.assemble({
        sessionId: input.sessionId,
        agentId: input.agentId,
        messages: input.messages,
        systemBudget,
        layers: systemLayers,
        signal: input.signal,
        query: layerQuery,
        constitutionPreamble: passPreamblePerAssemble || resolvedPreamble ? resolvedPreamble : undefined,
      });

      let runtimeSnapshot: string | undefined;
      let manifest = result.manifest;
      if (snapshotLayers.length > 0) {
        const snapBudget =
          options?.snapshotBudgetTokens != null && options.snapshotBudgetTokens > 0
            ? options.snapshotBudgetTokens
            : Number.MAX_SAFE_INTEGER;
        const snap = await assembler.assemble({
          sessionId: input.sessionId,
          agentId: input.agentId,
          messages: input.messages,
          systemBudget: snapBudget,
          layers: snapshotLayers,
          signal: input.signal,
          query: layerQuery,
          constitutionPreamble: '',
        });
        runtimeSnapshot = snap.systemPrompt.trim() || undefined;
        manifest = {
          ...result.manifest,
          usedSnapshotTokens: snap.manifest.usedTokens > 0 ? snap.manifest.usedTokens : undefined,
          layers: [
            ...result.manifest.layers.map((e) => ({ ...e, placement: e.placement ?? ('system' as const) })),
            ...snap.manifest.layers.map((e) => ({ ...e, placement: 'snapshot' as const })),
          ],
        };
      }

      return {
        systemPrompt: withFixedProtocolBlocks(result.systemPrompt),
        runtimeSnapshot,
        manifest,
        skippedBudget,
      };
    },
  };
}
