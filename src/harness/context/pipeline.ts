/**
 * DefaultContextPipeline — 默认上下文管道
 *
 * 采用阶段化管道模型：
 *   PersonaStage → SkillStage → HistoryStage → CompactStage → FilterStage
 *
 * 每个阶段可以独立替换或扩展。
 */

import type { Message } from '../../core/types.js';
import type {
  ContextPipeline,
  PipelineInput,
  PipelineOutput,
} from '../../core/interfaces/context-pipeline.js';
import type { LLMMessage, ToolDefinition } from '../../core/interfaces/model-provider.js';

// ── 阶段接口 ──

/** 阶段上下文（在管道中传递） */
export interface StageContext {
  /** 消息历史 */
  messages: Message[];
  /** 系统提示词（可能被阶段修改） */
  systemPrompt: string;
  /** 工具定义 */
  tools: ToolDefinition[];
  /** 最大 token 数 */
  maxTokens?: number;
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
      // 工具返回值是不可信的
      if (msg.role === 'tool' && msg.content) {
        ctx.untrustedRanges.push({
          start: offset,
          end: offset + msg.content.length,
          source: 'tool_output',
        });
      }

      // 带有 external 标记的消息也是不可信的
      if (msg.metadata?.external && msg.content) {
        ctx.untrustedRanges.push({
          start: offset,
          end: offset + msg.content.length,
          source: 'external_content',
        });
      }

      offset += msg.content?.length ?? 0;
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
      signal: input.signal,
      estimatedTokens: 0,
      untrustedRanges: [],
      extra: input.extra ?? {},
    };

    // 依次执行阶段
    for (const stage of this.stages) {
      if (ctx.signal?.aborted) break;
      ctx = await stage.process(ctx);
    }

    // 转换为 LLM 消息格式
    const llmMessages = this.buildLlmMessages(ctx);

    // 估算 token
    const estimatedTokens = this.estimateTokens(llmMessages);

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

    // 消息历史
    for (const msg of ctx.messages) {
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
          content: msg.content || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        // 普通消息
        result.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    return result;
  }

  /**
   * 估算 token 数（简单启发式）
   */
  private estimateTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 4); // 粗略估算
      }
    }
    return total;
  }
}
