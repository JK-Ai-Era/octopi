/**
 * Autonomous Subsystem — ThinkExecutor
 *
 * 子系统的执行引擎，处理 code / llm / hybrid 三种实现。
 * 替代旧的 ExecutionMode。
 *
 * @module autonomous-subsystem/think/executor
 */

import { Agent } from '../../../loop/agent.js';
import type { AgentTool } from '../../../loop/types.js';
import type { ModelProvider } from '../../../core/interfaces/model-provider.js';
import type { ErrorStrategy } from '../../../core/interfaces/error-strategy.js';
import type { RegisteredTool } from '../../../core/types.js';
import { runAgentWithReliability } from '../../reliability/index.js';
import type { ReliabilityHarness } from '../../reliability/index.js';
import type {
  ThinkConfig,
  ThinkImplementation,
  SubsystemInput,
  SubsystemOutput,
  Signal,
  ActMode,
} from '../types.js';
import type { ModelResolver, ResolvedModelWithFallback } from './model-resolver.js';

// ── ThinkExecutor 配置 ──

export interface ThinkExecutorConfig {
  /** 模型解析器 */
  modelResolver: ModelResolver;
  /** 共享的 ModelProvider（实际的 LLM 调用能力） */
  modelProvider: ModelProvider;
  /** 共享的 ErrorStrategy */
  errorStrategy: ErrorStrategy;
}

/**
 * ThinkExecutor — 子系统执行引擎
 *
 * 职责：
 * 1. code 模式：直接调用 handler 函数
 * 2. llm 模式：构建 Agent + runAgentWithReliability，支持工具执行
 * 3. hybrid 模式：preProcess → llm → postProcess
 * 4. 模型分级解析 + fallback 降级
 * 5. LLM 输出解析（JSON 提取 + 结构校验）
 */
export class ThinkExecutor {
  private modelResolver: ModelResolver;
  private modelProvider: ModelProvider;
  private errorStrategy: ErrorStrategy;

  constructor(config: ThinkExecutorConfig) {
    this.modelResolver = config.modelResolver;
    this.modelProvider = config.modelProvider;
    this.errorStrategy = config.errorStrategy;
  }

  /**
   * 执行子系统思考
   *
   * @param think - Think 配置
   * @param input - 子系统输入
   * @param actMode - Act 模式（用于输出解析的上下文）
   * @param resolvedTools - 已解析的工具集
   * @returns 子系统输出
   */
  async execute(
    think: ThinkConfig,
    input: SubsystemInput,
    actMode: ActMode,
    resolvedTools?: Map<string, RegisteredTool>,
  ): Promise<{ output: SubsystemOutput; tokenUsage?: { prompt: number; completion: number; total: number } }> {
    switch (think.implementation) {
      case 'code':
        return this.executeCode(think, input);
      case 'llm':
        return this.executeLLM(think, input, actMode, resolvedTools);
      case 'hybrid':
        return this.executeHybrid(think, input, actMode, resolvedTools);
      default:
        throw new Error(`Unknown think.implementation: ${think.implementation}`);
    }
  }

  // ── Code 模式 ──

  private async executeCode(
    think: ThinkConfig,
    input: SubsystemInput,
  ): Promise<{ output: SubsystemOutput; tokenUsage?: undefined }> {
    if (!think.handler) {
      throw new Error('think.implementation "code" requires a handler');
    }
    const output = await think.handler(input);
    return { output };
  }

  // ── LLM 模式 ──

  private async executeLLM(
    think: ThinkConfig,
    input: SubsystemInput,
    actMode: ActMode,
    resolvedTools?: Map<string, RegisteredTool>,
  ): Promise<{ output: SubsystemOutput; tokenUsage?: { prompt: number; completion: number; total: number } }> {
    if (!think.systemPrompt) {
      throw new Error('think.implementation "llm" requires a systemPrompt');
    }

    // 解析模型
    const modelRef = think.model ?? 'standard';
    const resolved = this.modelResolver.resolve(modelRef);

    // 构建 Agent 工具集
    const agentTools = this.buildAgentTools(resolvedTools);

    // 创建 Agent 实例
    const agent = new Agent({
      model: this.modelProvider,
      systemPrompt: think.systemPrompt,
      tools: agentTools,
    });

    // 注入输入为用户消息
    const inputContent = JSON.stringify(input, null, 2);
    agent.context.messages.push({
      role: 'user',
      content: inputContent,
      timestamp: Date.now(),
    });

    // 构建可靠性配置（子系统级别的简化配置）
    const harness: ReliabilityHarness = {
      config: {
        planningRetry: { maxAttempts: 0, steerInstruction: '' },
        emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
        noopThreshold: 3,
        loopDetection: { enabled: false },
      },
      errorStrategy: this.errorStrategy,
    };

    // 执行 LLM 调用（带 fallback）
    let lastContent = '';
    let tokenUsage: { prompt: number; completion: number; total: number } | undefined;

    try {
      for await (const event of runAgentWithReliability(
        agent.context,
        { model: agent.model },
        harness,
      )) {
        if (event.type === 'assistant_message') {
          lastContent = typeof event.message.content === 'string' ? event.message.content : '';
        }
      }
    } catch (err) {
      // primary 失败，尝试 fallback
      if (resolved.fallback.length > 0 && this.shouldFallback(err)) {
        // fallback 的实现在后续迭代中完善
        // 当前先抛出错误
        throw err;
      }
      throw err;
    }

    // 解析 LLM 输出
    const output = this.parseLLMOutput(lastContent, actMode, input.pendingToolCall);
    return { output, tokenUsage };
  }

  // ── Hybrid 模式 ──

  private async executeHybrid(
    think: ThinkConfig,
    input: SubsystemInput,
    actMode: ActMode,
    resolvedTools?: Map<string, RegisteredTool>,
  ): Promise<{ output: SubsystemOutput; tokenUsage?: { prompt: number; completion: number; total: number } }> {
    // preProcess
    let processedInput = input;
    if (think.preProcess) {
      processedInput = await think.preProcess(input);
    }

    // LLM 执行
    const result = await this.executeLLM(think, processedInput, actMode, resolvedTools);

    // postProcess
    if (think.postProcess) {
      const postProcessed = await this.postProcess(think.postProcess, result.output);
      return { output: postProcessed, tokenUsage: result.tokenUsage };
    }

    return result;
  }

  private async postProcess(
    postProcess: (output: SubsystemOutput) => Promise<SubsystemOutput>,
    output: SubsystemOutput,
  ): Promise<SubsystemOutput> {
    try {
      return await postProcess(output);
    } catch {
      // postProcess 失败，返回原始输出
      return output;
    }
  }

  // ── 工具构建 ──

  /**
   * 将 RegisteredTool 转换为 AgentTool（LLM 可调用的工具）
   */
  private buildAgentTools(tools?: Map<string, RegisteredTool>): AgentTool[] {
    if (!tools || tools.size === 0) return [];

    return Array.from(tools.values()).map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      parameters: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(t.definition.parameters).map(([key, param]) => [
            key,
            { type: param.type, description: param.description, ...(param.enum && { enum: param.enum }) },
          ]),
        ),
        required: Object.entries(t.definition.parameters)
          .filter(([, param]) => param.required)
          .map(([key]) => key),
      },
      execute: t.handler
        ? async (toolCallId: string, args: unknown) => {
            try {
              const result = await t.handler!(args as Record<string, unknown>, { toolCallId } as any);
              return {
                toolCallId,
                name: t.definition.name,
                content: typeof result === 'string' ? result : JSON.stringify(result),
                isError: false,
              };
            } catch (err) {
              return {
                toolCallId,
                name: t.definition.name,
                content: err instanceof Error ? err.message : String(err),
                isError: true,
              };
            }
          }
        : async (toolCallId: string) => ({
            toolCallId,
            name: t.definition.name,
            content: 'Tool has no handler',
            isError: true,
          }),
    }));
  }

  // ── LLM 输出解析 ──

  /**
   * 解析 LLM 的文本输出为 SubsystemOutput
   *
   * 尝试从 LLM 输出中提取 JSON，校验 action 枚举值。
   */
  private parseLLMOutput(
    content: string,
    actMode: ActMode,
    pendingToolCall?: { name: string; arguments: Record<string, unknown> },
  ): SubsystemOutput {
    const jsonStr = this.extractFirstJsonObject(content);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        return this.validateOutput(parsed, actMode);
      } catch {
        // JSON 解析失败，走兜底
      }
    }

    // 兜底
    return this.buildFallbackOutput(actMode, content);
  }

  /**
   * 从文本中提取第一个完整的 JSON 对象
   */
  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * 校验 LLM 输出为有效的 SubsystemOutput
   */
  private validateOutput(parsed: Record<string, unknown>, actMode: ActMode): SubsystemOutput {
    const signals: Signal[] = [];

    // 解析信号
    if (Array.isArray(parsed.signals)) {
      for (const s of parsed.signals) {
        if (this.isValidSignalAction(s.action)) {
          signals.push({
            action: s.action,
            reason: typeof s.reason === 'string' ? s.reason : '',
            confidence: typeof s.confidence === 'number' ? s.confidence : undefined,
            data: s.data,
          });
        } else {
          // 非法 action 值，降级为 no-op
          signals.push({
            action: 'no-op',
            reason: `Invalid action "${s.action}", degraded to no-op`,
            confidence: 0,
          });
        }
      }
    }

    // 单信号格式（兼容 { action, reason, confidence, data }）
    if (signals.length === 0 && this.isValidSignalAction(parsed.action)) {
      signals.push({
        action: parsed.action as Signal['action'],
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
        data: parsed.data as Record<string, unknown> | undefined,
      });
    }

    return { signals };
  }

  private isValidSignalAction(action: unknown): action is Signal['action'] {
    return typeof action === 'string' && ['allow', 'block', 'degrade', 'suggest', 'replace', 'alert', 'escalate', 'no-op'].includes(action);
  }

  /**
   * 兜底输出（LLM 输出无法解析时）
   */
  private buildFallbackOutput(actMode: ActMode, content: string): SubsystemOutput {
    if (actMode === 'block') {
      // block 模式下，无法解析 → allow（安全默认：系统运行优先）
      return {
        signals: [{
          action: 'allow',
          reason: 'LLM output could not be parsed, defaulting to allow',
          confidence: 0,
        }],
      };
    }

    // 其他模式，将原始内容作为 suggest 信号
    return {
      signals: [{
        action: 'suggest',
        reason: content,
        confidence: 0,
      }],
    };
  }

  // ── Fallback 判断 ──

  /**
   * 判断错误是否应该触发 fallback
   */
  private shouldFallback(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      // rate_limit / timeout / server_error → fallback
      if (msg.includes('rate') || msg.includes('limit') || msg.includes('429')) return true;
      if (msg.includes('timeout') || msg.includes('timed out')) return true;
      if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('server')) return true;
    }
    // auth_error / 参数错误 → 不 fallback
    return false;
  }
}
