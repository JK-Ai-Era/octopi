import { randomUUID } from 'node:crypto';
import type {
  AgentConfig,
  AgentEvent,
  AgentEventListener,
  AgentHarness,
  LLMProvider,
  LLMRequest,
  Message,
  RegisteredTool,
  Session,
  ToolCall,
  ToolResult,
  Turn,
} from './types.js';
import { SessionManager } from './session-manager.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { LLMRouter } from '../providers/llm-router.js';
import { ContextManager } from '../memory/context-manager.js';

/**
 * Agent Harness 核心实现
 *
 * 职责：
 * - 编排 LLM ↔ Tool 的循环
 * - 管理 session 生命周期
 * - 事件分发
 */
export class Agent implements AgentHarness {
  private sessions = new SessionManager();
  private toolRegistry = new ToolRegistry();
  private llmRouter = new LLMRouter();
  private contextManager = new ContextManager();
  private listeners: AgentEventListener[] = [];

  // ---- 注册 ----

  registerTool(tool: RegisteredTool): void {
    this.toolRegistry.register(tool);
  }

  registerProvider(provider: LLMProvider): void {
    this.llmRouter.register(provider);
  }

  on(listener: AgentEventListener): void {
    this.listeners.push(listener);
  }

  // ---- Session 生命周期 ----

  async createSession(config: AgentConfig): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      agentId: config.persona.name,
      status: 'idle',
      turns: [],
      context: {
        systemPrompt: config.persona.systemPrompt,
        messages: [],
        estimatedTokens: 0,
        maxTokens: config.maxTokens ?? 32768,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.add(session);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = 'idle';
    await this.emit({ type: 'session_end' });
    this.sessions.remove(sessionId);
  }

  // ---- 核心循环 ----

  async send(sessionId: string, message: Message): Promise<Message> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // 1. 将用户消息加入上下文
    session.context.messages.push(message);
    session.status = 'thinking';

    // 2. 循环：LLM → 可能有 tool call → 再 LLM → 直到纯文本回复
    const maxIterations = 10; // 防止无限循环
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      const turnId = randomUUID();
      await this.emit({ type: 'turn_start', turnId });

      // 2a. 构建 LLM 请求
      const llmRequest = this.buildLLMRequest(session);
      await this.emit({ type: 'llm_request', request: llmRequest });

      // 2b. 调用 LLM
      const startTime = Date.now();
      const provider = this.llmRouter.resolve(session);
      const llmResponse = await provider.complete(llmRequest);
      await this.emit({ type: 'llm_response', response: llmResponse });

      // 2c. 构建 assistant 消息
      const assistantMessage: Message = {
        role: 'assistant',
        content: llmResponse.content,
        toolCalls: llmResponse.toolCalls,
        timestamp: Date.now(),
      };

      // 记录 turn
      const turn: Turn = {
        id: turnId,
        input: [...session.context.messages],
        output: assistantMessage,
        usage: llmResponse.usage,
        durationMs: Date.now() - startTime,
        model: llmResponse.model,
        timestamp: Date.now(),
      };
      session.turns.push(turn);

      // 2d. 如果没有 tool call，返回结果
      if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
        session.context.messages.push(assistantMessage);
        session.status = 'idle';
        await this.emit({ type: 'turn_end', turn });
        session.updatedAt = Date.now();
        return assistantMessage;
      }

      // 2e. 有 tool call → 执行工具
      session.status = 'executing';
      session.context.messages.push(assistantMessage);

      const toolResults = await this.executeToolCalls(
        llmResponse.toolCalls,
        session,
      );

      // 2f. 将 tool results 作为 tool 消息加入上下文
      const toolMessage: Message = {
        role: 'tool',
        content: JSON.stringify(toolResults),
        toolResults,
        timestamp: Date.now(),
      };
      session.context.messages.push(toolMessage);

      await this.emit({ type: 'turn_end', turn });
      // 继续循环，让 LLM 看到 tool 结果
    }

    // 超过最大迭代
    session.status = 'error';
    const errorMessage: Message = {
      role: 'assistant',
      content: '[Agent Harness] 达到最大迭代次数限制，任务可能未完成。',
      timestamp: Date.now(),
    };
    session.context.messages.push(errorMessage);
    session.updatedAt = Date.now();
    return errorMessage;
  }

  // ---- 内部方法 ----

  private buildLLMRequest(session: Session): LLMRequest {
    const tools = this.toolRegistry.getDefinitionsForLLM();
    return {
      model: session.context.systemPrompt ? 'default' : 'default', // 由 provider 路由决定
      messages: this.contextManager.buildMessages(session.context),
      tools: tools.length > 0 ? tools : undefined,
      temperature: 0.7,
      maxTokens: 4096,
    };
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    session: Session,
  ): Promise<ToolResult[]> {
    const context = {
      sessionId: session.id,
      agentId: session.agentId,
      messages: session.context.messages,
    };

    // 并行执行所有 tool call
    const results = await Promise.allSettled(
      toolCalls.map(async (call) => {
        await this.emit({ type: 'tool_call', call });
        const startTime = Date.now();

        try {
          const result = await this.toolRegistry.execute(
            call.name,
            call.arguments,
            context,
          );
          const toolResult: ToolResult = {
            toolCallId: call.id,
            name: call.name,
            result,
            durationMs: Date.now() - startTime,
          };
          await this.emit({ type: 'tool_result', result: toolResult });
          return toolResult;
        } catch (error) {
          const toolResult: ToolResult = {
            toolCallId: call.id,
            name: call.name,
            result: null,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startTime,
          };
          await this.emit({ type: 'tool_result', result: toolResult });
          return toolResult;
        }
      }),
    );

    return results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            toolCallId: 'unknown',
            name: 'unknown',
            result: null,
            error: 'Execution failed',
          },
    );
  }

  private async emit(event: AgentEvent): Promise<void> {
    await Promise.allSettled(
      this.listeners.map((listener) => {
        try {
          return listener(event);
        } catch {
          // 事件监听器不应影响主流程
        }
      }),
    );
  }

  async close(): Promise<void> {
    // 清理资源
    this.listeners = [];
  }
}
