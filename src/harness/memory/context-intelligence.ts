/**
 * ContextIntelligence — 七层智能组装
 *
 * 纯组装层：不产生任何内容，只决定每层放多少、放什么位置。
 *
 * 组装顺序（system prompt 中的位置，从前往后）：
 * 1. Wisdom — 思维范式（最靠前，权重最高）
 * 2. Persona — 身份定义、人格特质
 * 3. Skill — 当前任务匹配的技能（条件加载）
 * 4. Knowledge — 当前话题检索到的外部知识
 * 5. Cognition — 当前话题相关的概念网络
 * 6. Memory — 相关记忆召回
 */

import type { MemoryEntry } from './types.js';
import type { WisdomEntry } from './wisdom-types.js';
import type { ConceptGraph } from './cognition-types.js';
import type { Message } from '../../core/types/messages.js';
import { getTextContent } from '../../core/types/messages.js';

/** ContextIntelligence 配置 */
export interface ContextIntelligenceConfig {
  /** 是否启用认知图谱 */
  enableCognition?: boolean;
  /** 记忆注入的最大条数 */
  maxMemoryEntries?: number;
  /** 知识注入的最大条数 */
  maxKnowledgeEntries?: number;
  /** 认知图谱查询深度 */
  cognitionDepth?: number;
}

/** 组装结果 */
export interface AssembledContext {
  /** 组装好的 system prompt */
  systemPrompt: string;
  /** 各层注入的内容量（用于调试和监控） */
  layers: {
    wisdom: number;
    persona: number;
    skills: number;
    knowledge: number;
    cognition: number;
    memory: number;
  };
}

export class ContextIntelligence {
  private config: ContextIntelligenceConfig;

  constructor(config: ContextIntelligenceConfig = {}) {
    this.config = {
      maxMemoryEntries: config.maxMemoryEntries ?? 5,
      maxKnowledgeEntries: config.maxKnowledgeEntries ?? 5,
      cognitionDepth: config.cognitionDepth ?? 1,
      ...config,
    };
  }

  /**
   * 组装七层智能上下文
   *
   * @param persona — 已加载的人格内容
   * @param wisdom — 智慧条目
   * @param skills — 当前匹配的技能内容
   * @param knowledge — 检索到的知识
   * @param cognition — 相关认知图谱
   * @param memory — 相关记忆
   * @param messages — 当前对话消息（用于提取查询上下文）
   */
  assemble(
    persona: string,
    wisdom: WisdomEntry[],
    skills: string[],
    knowledge: string[],
    cognition: ConceptGraph | null,
    memory: MemoryEntry[],
    messages: Message[],
  ): AssembledContext {
    const parts: string[] = [];

    // 1. Wisdom — 最靠前
    if (wisdom.length > 0) {
      parts.push('# 思维框架\n\n' + wisdom.map(w => w.content).join('\n\n'));
    }

    // 2. Persona
    if (persona) {
      parts.push(persona);
    }

    // 3. Skills
    if (skills.length > 0) {
      parts.push('# 当前技能\n\n' + skills.join('\n\n'));
    }

    // 4. Knowledge
    if (knowledge.length > 0) {
      parts.push('# 相关知识\n\n' + knowledge.join('\n'));
    }

    // 5. Cognition
    if (cognition && cognition.nodes.length > 0) {
      const conceptText = this.formatConceptGraph(cognition);
      parts.push('# 相关概念\n\n' + conceptText);
    }

    // 6. Memory
    if (memory.length > 0) {
      const memoryText = memory
        .map(m => `- [${m.type}] ${m.content}`)
        .join('\n');
      parts.push('# 相关记忆\n\n' + memoryText);
    }

    return {
      systemPrompt: parts.join('\n\n---\n\n'),
      layers: {
        wisdom: wisdom.length,
        persona: persona ? 1 : 0,
        skills: skills.length,
        knowledge: knowledge.length,
        cognition: cognition?.nodes.length ?? 0,
        memory: memory.length,
      },
    };
  }

  /**
   * 从消息中提取查询上下文
   */
  extractQueryContext(messages: Message[]): string {
    // 取最后 3 条用户消息
    const userMessages = messages
      .filter(m => m.role === 'user')
      .slice(-3);
    return userMessages.map(m => getTextContent(m.content)).join(' ');
  }

  private formatConceptGraph(graph: ConceptGraph): string {
    const lines: string[] = [];
    for (const edge of graph.edges) {
      const source = graph.nodes.find(n => n.id === edge.sourceId);
      const target = graph.nodes.find(n => n.id === edge.targetId);
      if (source && target) {
        const desc = edge.description ? ` (${edge.description})` : '';
        lines.push(`- ${source.name} —[${edge.relationType}]→ ${target.name}${desc}`);
      }
    }
    return lines.join('\n') || '（无相关概念）';
  }
}
