/**
 * DefaultContextPipeline — 默认上下文管道
 *
 * 阶段化管道模型：
 *   PersonaStage → SkillStage → TaskStage → KnowledgeStage → HistoryStage → CompactStage → FilterStage
 *
 * 每个阶段可以独立替换或扩展。
 */

import type { Message, SkillManager, ContentBlock } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';
import type {
  ContextPipeline,
  PipelineInput,
  PipelineOutput,
} from '../../core/interfaces/context-pipeline.js';
import type { LLMMessage, ToolDefinition } from '../../core/interfaces/model-provider.js';
import { estimateTokens } from '../../core/token-estimator.js';

// ── 阶段接口 ──

/** 阶段上下文（在管道中传递） */
export interface StageContext {
  /** 消息历史 */
  messages: Message[];
  /** 系统提示词（可能被阶段修改） */
  systemPrompt: string;
  /** 工具定义 */
  tools: ToolDefinition[];
  /** 最大 token 数（请求参数） */
  maxTokens?: number;
  /** 模型上下文窗口大小（能力声明） */
  contextWindow?: number;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 估算的 token 数 */
  estimatedTokens: number;
  /** 不可信内容范围 */
  untrustedRanges: Array<{ start: number; end: number; source: string }>;
  /** 扩展数据 */
  extra: Record<string, unknown>;
}

/** 上下文阶段接口 */
export interface ContextStage {
  readonly name: string;
  /** 标记该 stage 是否可选。可选 stage 失败时不阻塞 pipeline，返回原始上下文 */
  readonly optional?: boolean;
  process(ctx: StageContext): Promise<StageContext>;
}

// ── 内置阶段 ──

/**
 * PersonaStage — 注入 persona（system prompt）
 */
export class PersonaStage implements ContextStage {
  readonly name = 'persona';

  async process(ctx: StageContext): Promise<StageContext> {
    // systemPrompt 已经在 PipelineInput 中，这里不需要额外操作
    // 但可以添加元数据标记
    return ctx;
  }
}

/**
 * HistoryStage — 组装消息历史
 *
 * 将内部 Message 格式转换为 LLM Message 格式。
 */
export class HistoryStage implements ContextStage {
  readonly name = 'history';

  async process(ctx: StageContext): Promise<StageContext> {
    // 转换在管道输出时进行，这里不需要额外操作
    return ctx;
  }
}

/**
 * SkillStage — 注入 Skill 上下文
 *
 * 将可用 Skill 列表注入 system prompt，让 LLM 知道有哪些工具可用。
 */
export class SkillStage implements ContextStage {
  readonly name = 'skill';
  private skillManager: SkillManager;

  constructor(skillManager: SkillManager) {
    this.skillManager = skillManager;
  }

  async process(ctx: StageContext): Promise<StageContext> {
    const skillPrompt = this.skillManager.formatForPrompt();
    if (skillPrompt) {
      ctx.systemPrompt = ctx.systemPrompt + '\n\n' + skillPrompt;
    }
    return ctx;
  }
}

/**
 * CompactStage — 上下文压缩
 *
 * 当 token 超限时，自动截断或摘要早期消息。
 * 优先使用 maxTokens（请求参数），其次使用 contextWindow（能力声明）。
 */
export class CompactStage implements ContextStage {
  readonly name = 'compact';

  async process(ctx: StageContext): Promise<StageContext> {
    // 确定有效 token 上限：min(maxTokens, contextWindow)，忽略 undefined
    const effectiveLimit = ctx.maxTokens !== undefined && ctx.contextWindow !== undefined
      ? Math.min(ctx.maxTokens, ctx.contextWindow)
      : ctx.maxTokens ?? ctx.contextWindow;

    if (!effectiveLimit) return ctx;

    const currentTokens = estimateTokens(ctx.messages);
    if (currentTokens <= effectiveLimit) return ctx;

    // 策略：保留系统提示 + 最近 N 条消息，截断早期消息
    // 简单实现：移除早期消息直到 token 降到阈值以下
    const threshold = Math.floor(effectiveLimit * 0.8); // 留 20% 余量
    const messages = [...ctx.messages];

    // 保留最后 4 条消息
    const keepCount = Math.min(4, messages.length);
    const keepMessages = messages.slice(-keepCount);
    const earlyMessages = messages.slice(0, -keepCount);

    // 从早期消息中截断
    let estimatedEarly = estimateTokens(earlyMessages);
    const targetEarly = threshold - estimateTokens(keepMessages);

    if (estimatedEarly > targetEarly && earlyMessages.length > 0) {
      // 移除最早的消息
      const removeCount = Math.min(earlyMessages.length, Math.ceil(earlyMessages.length * 0.5));
      const removed = earlyMessages.splice(0, removeCount);
      estimatedEarly = estimateTokens(earlyMessages);

      // 在被移除消息的位置插入摘要提示
      if (removed.length > 0) {
        earlyMessages.unshift({
          role: 'system',
          content: `[上下文压缩：已省略 ${removed.length} 条早期消息]`,
          timestamp: Date.now(),
        });
      }
    }

    ctx.messages = [...earlyMessages, ...keepMessages];
    return ctx;
  }
}

/**
 * FilterStage — 标记不可信内容
 *
 * 扫描消息历史中的工具返回值和外部内容，
 * 标记为不可信范围，供 SecurityGuard 使用。
 */
export class FilterStage implements ContextStage {
  readonly name = 'filter';

  async process(ctx: StageContext): Promise<StageContext> {
    let offset = 0;

    for (const msg of ctx.messages) {
      const textContent = getTextContent(msg.content);

      // 工具返回值是不可信的
      if (msg.role === 'tool' && textContent) {
        ctx.untrustedRanges.push({
          start: offset,
          end: offset + textContent.length,
          source: 'tool_output',
        });
      }

      // 带有 external 标记的消息也是不可信的
      if (msg.metadata?.external && textContent) {
        ctx.untrustedRanges.push({
          start: offset,
          end: offset + textContent.length,
          source: 'external_content',
        });
      }

      offset += textContent.length;
    }

    return ctx;
  }
}

// ── 管道实现 ──

/**
 * DefaultContextPipeline
 */
export class DefaultContextPipeline implements ContextPipeline {
  private stages: ContextStage[];

  constructor(stages?: ContextStage[]) {
    this.stages = stages ?? [
      new PersonaStage(),
      new HistoryStage(),
      new FilterStage(),
    ];
  }

  async process(messages: Message[], input: PipelineInput): Promise<PipelineOutput> {
    // 构建阶段上下文
    let ctx: StageContext = {
      messages,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      maxTokens: input.maxTokens,
      contextWindow: input.contextWindow,
      signal: input.signal,
      estimatedTokens: 0,
      untrustedRanges: [],
      extra: input.extra ?? {},
    };

    // 依次执行阶段
    for (const stage of this.stages) {
      if (ctx.signal?.aborted) break;
      try {
        ctx = await stage.process(ctx);
      } catch (err) {
        if (stage.optional) {
          // 可选 stage 失败：记录事件但不阻塞 pipeline
          // 调用方可以通过 EventBus 监听此事件
          const error = err instanceof Error ? err.message : String(err);
          ctx.extra[`stage_${stage.name}_error`] = error;
        } else {
          throw err;
        }
      }
    }

    // 转换为 LLM 消息格式
    const llmMessages = this.buildLlmMessages(ctx);

    // 估算 token
    const estimatedTokens = estimateTokens(llmMessages);

    return {
      messages: llmMessages,
      estimatedTokens,
      untrustedRanges: ctx.untrustedRanges.length > 0 ? ctx.untrustedRanges : undefined,
      systemPrompt: ctx.systemPrompt,
    };
  }

  /**
   * 构建 LLM 消息格式
   */
  private buildLlmMessages(ctx: StageContext): LLMMessage[] {
    const result: LLMMessage[] = [];

    // 系统提示词
    if (ctx.systemPrompt) {
      result.push({ role: 'system', content: ctx.systemPrompt });
    }

    // 消息历史（先清理无效消息，避免干扰 LLM）
    const cleanMessages = this.sanitizeMessages(ctx.messages);
    for (const msg of cleanMessages) {
      if (msg.role === 'tool') {
        // 工具结果消息
        for (const tr of msg.toolResults ?? []) {
          result.push({
            role: 'tool',
            content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
            tool_call_id: tr.toolCallId,
            name: tr.name,
          });
        }
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // 带工具调用的 assistant 消息
        result.push({
          role: 'assistant',
          content: getTextContent(msg.content) || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else if (Array.isArray(msg.content)) {
        // 多模态消息：转换为 LLM 内容块格式
        const llmContent = msg.content.map((block: ContentBlock) => {
          if (block.type === 'text') {
            return { type: 'text', text: block.text };
          }
          if (block.type === 'image') {
            const source: Record<string, unknown> = { type: 'image' };
            if (block.url) source.source = { type: 'url', url: block.url };
            else if (block.data) source.source = { type: 'base64', media_type: block.mimeType ?? 'image/png', data: block.data };
            return source;
          }
          if (block.type === 'audio') {
            return { type: 'input_audio', input_audio: { data: block.data ?? '', format: block.mimeType?.split('/')[1] ?? 'mp3' } };
          }
          // 其他类型转为文本描述
          return { type: 'text', text: `[${block.type} content]` };
        });
        result.push({
          role: msg.role,
          content: llmContent as Array<{ type: string; [key: string]: unknown }>,
        });
      } else {
        // 普通文本消息
        result.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    return result;
  }

  /**
   * 清理消息历史
   *
   * 过滤掉可能干扰 LLM 的无效消息：
   * - 空 assistant 消息（无内容、无 toolCalls）
   * - 空 tool 消息（无 toolResults）
   */
  private sanitizeMessages(messages: Message[]): Message[] {
    return messages.filter((msg) => {
      // assistant 消息：必须有内容或有 toolCalls
      if (msg.role === 'assistant') {
        const hasContent = Array.isArray(msg.content)
          ? msg.content.length > 0
          : !!msg.content;
        if (!hasContent && (!msg.toolCalls || msg.toolCalls.length === 0)) {
          return false;
        }
      }
      // tool 消息：必须有 toolResults
      if (msg.role === 'tool') {
        if (!msg.toolResults || msg.toolResults.length === 0) {
          return false;
        }
      }
      return true;
    });
  }

}
