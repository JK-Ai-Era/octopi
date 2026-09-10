/**
 * KnowledgeContextEngine — 基于 ContextEngine 的知识注入引擎
 *
 * 将 KnowledgeStore 检索结果注入到 system prompt，然后委托给内部 ContextEngine 完成组装。
 */

import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleParams,
  AssembleResult,
  CompactParams,
  CompactResult,
  AfterTurnParams,
  IngestParams,
} from '../../../core/interfaces/context-engine.js';
import type { KnowledgeStore } from './types.js';
import { getTextContent } from '../../../core/types.js';

export interface KnowledgeContextEngineConfig {
  /** 知识存储 */
  store: KnowledgeStore;
  /** 内部 context engine，默认 DefaultContextEngine */
  delegate: ContextEngine;
  /** 检索数量限制 */
  limit?: number;
  /** 最小置信度 */
  minConfidence?: number;
}

export class KnowledgeContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: 'knowledge',
    name: 'Knowledge Context Engine',
    ownsCompaction: false,
  };

  private readonly store: KnowledgeStore;
  private readonly delegate: ContextEngine;
  private readonly limit: number;
  private readonly minConfidence: number;

  constructor(config: KnowledgeContextEngineConfig) {
    this.store = config.store;
    this.delegate = config.delegate;
    this.limit = config.limit ?? 5;
    this.minConfidence = config.minConfidence ?? 0.3;
  }

  async assemble(params: AssembleParams): Promise<AssembleResult> {
    const lastUserMsg = [...params.messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      return this.delegate.assemble(params);
    }

    const entries = await this.store.retrieve(getTextContent(lastUserMsg.content), {
      limit: this.limit,
      minConfidence: this.minConfidence,
      updateAccess: true,
    });

    if (entries.length === 0) {
      return this.delegate.assemble(params);
    }

    const knowledgeText = entries
      .map((e) => `[${e.type}] ${e.content} (置信度: ${e.confidence})`)
      .join('\n');

    return this.delegate.assemble({
      ...params,
      systemPrompt: `${params.systemPrompt}\n\n## 相关知识\n${knowledgeText}`,
    });
  }

  async compact(params: CompactParams): Promise<CompactResult> {
    return this.delegate.compact(params);
  }

  async afterTurn(params: AfterTurnParams): Promise<void> {
    await this.delegate.afterTurn(params);
  }

  async ingest(params: IngestParams): Promise<void> {
    await this.delegate.ingest(params);
  }
}
