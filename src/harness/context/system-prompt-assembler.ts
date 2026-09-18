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
  contextWindow?: number;
  signal?: AbortSignal;
}

export interface SystemPromptAssembleOutput {
  systemPrompt: string;
  manifest?: AssembleManifest;
}

const DEFAULT_SYSTEM_BUDGET_RATIO = 0.22;
const DEFAULT_CONTEXT_WINDOW = 128_000;

export function createDefaultSystemPromptAssembler(options?: {
  assembler?: ContextAssembler;
  assemblerConfig?: DefaultContextAssemblerConfig;
  systemBudgetRatio?: number;
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
      const window = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const systemBudget = Math.max(2000, Math.floor(window * ratio));

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

      const result = await assembler.assemble({
        sessionId: input.sessionId,
        agentId: input.agentId,
        messages: input.messages,
        systemBudget,
        layers,
        signal: input.signal,
        constitutionPreamble: passPreamblePerAssemble || resolvedPreamble ? resolvedPreamble : undefined,
      });

      return { systemPrompt: result.systemPrompt, manifest: result.manifest };
    },
  };
}
