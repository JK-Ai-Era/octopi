/**
 * SystemPromptAssembler — Runner 每轮 system prompt 装配端口
 *
 * 将「persona + 动态注入 + （可选）其他层」收成 ContextLayer 契约装配，
 * 产出最终 systemPrompt。由 Builder 注入 SessionAwareRunner。
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

export interface SystemPromptAssembleInput {
  sessionId: string;
  agentId?: string;
  /** 当前消息（含本轮用户输入） */
  messages: Message[];
  /** 纯 persona（resolver 结果，不含 injected） */
  persona: string;
  /** 本轮动态注入（session tasks / guidance 等） */
  injectedContext?: string;
  /** 上下文窗口，用于推 system 预算 */
  contextWindow?: number;
  signal?: AbortSignal;
}

export interface SystemPromptAssembleOutput {
  systemPrompt: string;
  manifest?: AssembleManifest;
}

/** system prompt 默认占窗口比例（其余留给消息与输出） */
const DEFAULT_SYSTEM_BUDGET_RATIO = 0.22;
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 创建默认 system prompt 装配器
 *
 * 启用层：persona（保底）+ skill 索引（可选）+ wisdom/cognition/knowledge/memory 召回（可选）+ runtime。
 */
export function createDefaultSystemPromptAssembler(options?: {
  assembler?: ContextAssembler;
  /** 未传 assembler 时用于构造 DefaultContextAssembler */
  assemblerConfig?: DefaultContextAssemblerConfig;
  systemBudgetRatio?: number;
  /** Skill 索引正文（SkillManager.formatForPrompt）；空则不注册 skill 层 */
  getSkillPromptText?: () => Promise<string> | string;
  /** 记忆存储；提供则注册 MemoryLayer */
  memoryStore?: MemoryStore;
  /** 知识存储；提供则注册 KnowledgeLayer */
  knowledgeStore?: KnowledgeStore;
  /** 智慧存储；提供则注册 WisdomLayer */
  wisdomStore?: WisdomStore;
  /** 认知图谱；提供则注册 CognitionLayer */
  cognitionStore?: ConceptGraphStore;
  memoryLimit?: number;
  knowledgeLimit?: number;
  cognitionDepth?: number;
}): {
  assemble: (input: SystemPromptAssembleInput) => Promise<SystemPromptAssembleOutput>;
  /** 会话结束/重置时清理层指纹缓存 */
  clearSession: (sessionId: string) => void;
} {
  const assembler =
    options?.assembler ?? new DefaultContextAssembler(options?.assemblerConfig);
  const ratio = options?.systemBudgetRatio ?? DEFAULT_SYSTEM_BUDGET_RATIO;
  const getSkillPromptText = options?.getSkillPromptText;
  const wisdomStore = options?.wisdomStore;
  const cognitionStore = options?.cognitionStore;

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
        layers.push(
          new WisdomLayer({
            getEntries: () => wisdomStore.getAll(),
          }),
        );
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
      // 检索/半静态层每轮可能非空，不能仅凭「当前无文本」短路
      const hasRetrieval = Boolean(
        options?.memoryStore ||
          options?.knowledgeStore ||
          wisdomStore ||
          cognitionStore,
      );
      if (!hasPersona && !hasInjected && !hasSkill && !hasRetrieval) {
        return { systemPrompt: '' };
      }

      const result = await assembler.assemble({
        sessionId: input.sessionId,
        agentId: input.agentId,
        messages: input.messages,
        systemBudget,
        layers,
        signal: input.signal,
      });

      return { systemPrompt: result.systemPrompt, manifest: result.manifest };
    },
  };
}
