/**
 * SystemPromptAssembler — Runner 每轮 system prompt 装配端口
 *
 * 全局宪法 preamble 固定在最前；层契约见 harness/context。
 */

import type { Message } from '../../core/types.js';
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
import type { ConceptGraphStore, MemoryStore, WisdomStore } from '../memory/types.js';
import type { KnowledgeStore } from './knowledge/types.js';
import { loadConstitution, type ConstitutionConfig } from './constitution/load-constitution.js';

export interface SystemPromptAssembleInput {
  sessionId: string;
  agentId?: string;
  messages: Message[];
  persona: string;
  injectedContext?: string;
  /** 显式配置的上下文窗口；未知时省略 */
  contextWindow?: number;
  signal?: AbortSignal;
}

export interface SystemPromptAssembleOutput {
  systemPrompt: string;
  manifest?: AssembleManifest;
  /**
   * true = 未按 contextWindow 比例做层预算（窗口未知）。
   * 层内容仍会装配（不硬裁）；**不要**据此丢弃 systemPrompt。
   */
  skippedBudget?: boolean;
}

const DEFAULT_SYSTEM_BUDGET_RATIO = 0.22;

export function createDefaultSystemPromptAssembler(options?: {
  assembler?: ContextAssembler;
  assemblerConfig?: DefaultContextAssemblerConfig;
  systemBudgetRatio?: number;
  /** 显式 system 预算 token；与 contextWindow 无关（窗口未知时仍可用） */
  systemBudgetTokens?: number;
  getSkillPromptText?: () => Promise<string> | string;
  memoryStore?: MemoryStore;
  knowledgeStore?: KnowledgeStore;
  wisdomStore?: WisdomStore;
  cognitionStore?: ConceptGraphStore;
  memoryLimit?: number;
  knowledgeLimit?: number;
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
      const hasInjected = Boolean((input.injectedContext ?? '').trim());
      let hasSkill = false;
      if (getSkillPromptText) {
        hasSkill = Boolean((await getSkillPromptText()).trim());
      }
      const hasRetrieval = Boolean(
        options?.memoryStore ||
          options?.knowledgeStore ||
          wisdomStore ||
          cognitionStore,
      );
      const hasPreamble = Boolean(resolvedPreamble.trim());
      if (!hasPersona && !hasInjected && !hasSkill && !hasRetrieval && !hasPreamble) {
        return { systemPrompt: '' };
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
        layers.push(new WisdomLayer({ getEntries: () => wisdomStore.getAll() }));
      }
      if (options?.knowledgeStore) {
        layers.push(
          new KnowledgeLayer({
            store: options.knowledgeStore,
            limit: options.knowledgeLimit,
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
      layers.push(
        new RuntimeLayer({
          getText: () => input.injectedContext ?? '',
        }),
      );

      const result = await assembler.assemble({
        sessionId: input.sessionId,
        agentId: input.agentId,
        messages: input.messages,
        systemBudget,
        layers,
        signal: input.signal,
        constitutionPreamble: passPreamblePerAssemble || resolvedPreamble ? resolvedPreamble : undefined,
      });

      return { systemPrompt: result.systemPrompt, manifest: result.manifest, skippedBudget };
    },
  };
}
