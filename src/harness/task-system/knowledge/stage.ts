/**
 * KnowledgeStage — 上下文管道的知识注入阶段
 *
 * 从 KnowledgeStore 检索相关知识，注入到 system prompt。
 */

// ContextStage/StageContext types (pipeline.js 已移除，本地定义)
import type { Message } from '../../../core/types.js';

export interface StageContext {
  messages: Message[];
  systemPrompt: string;
  [key: string]: unknown;
}

export interface ContextStage {
  readonly name: string;
  process(ctx: StageContext): Promise<StageContext>;
}
import type { KnowledgeStore } from './types.js';
import { getTextContent } from '../../../core/types.js';

export interface KnowledgeStageConfig {
  /** 知识存储 */
  store: KnowledgeStore;
  /** 检索数量限制 */
  limit?: number;
  /** 最小置信度 */
  minConfidence?: number;
}

/**
 * 知识注入阶段
 *
 * 从用户的最后一条消息中提取关键词，检索相关知识，注入上下文。
 */
export class KnowledgeStage implements ContextStage {
  readonly name = 'knowledge';
  private _store: KnowledgeStore;
  private _limit: number;
  private _minConfidence: number;

  constructor(config: KnowledgeStageConfig) {
    this._store = config.store;
    this._limit = config.limit ?? 5;
    this._minConfidence = config.minConfidence ?? 0.3;
  }

  async process(ctx: StageContext): Promise<StageContext> {
    // 从最后一条用户消息提取查询
    const lastUserMsg = [...ctx.messages]
      .reverse()
      .find(m => m.role === 'user');

    if (!lastUserMsg) return ctx;

    // 检索相关知识
    const entries = await this._store.retrieve(getTextContent(lastUserMsg.content), {
      limit: this._limit,
      minConfidence: this._minConfidence,
      updateAccess: true,
    });

    if (entries.length === 0) return ctx;

    // 格式化知识注入
    const knowledgeText = entries
      .map(e => `[${e.type}] ${e.content} (置信度: ${e.confidence})`)
      .join('\n');

    return {
      ...ctx,
      systemPrompt: ctx.systemPrompt + `\n\n## 相关知识\n${knowledgeText}`,
    };
  }
}
