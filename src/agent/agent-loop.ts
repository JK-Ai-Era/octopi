import { randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  AgentEvent,
  AgentEventListener,
  ChannelMessage,
  ContextEngine,
  LLMProvider,
  LLMRequest,
  Message,
  RegisteredTool,
  SessionMeta,
  ToolCall,
  ToolResult,
  Turn,
  Plugin,
  PluginHooks,
  HookContext,
} from '../core/types.js';
import { SessionManager } from './session-manager.js';
import { ToolRegistry } from '../tools/registry.js';
import { LLMRouter } from '../providers/router.js';
import { LegacyContextEngine } from '../context/engine.js';
import { PluginManager } from '../plugins/hooks.js';

/**
 * Agent Loop — 核心执行循环
 *
 * 参考 OpenClaw 的 agent-loop 设计：
 * intake → context assemble → model infer → tool exec → streaming reply → persistence
 *
 * 特点：
 * - Session 级 write lock（一个 session 同时只有一个运行）
 * - Context Engine 4 阶段生命周期
 * - Plugin hooks 全链路可拦截
 * - 事件流全链路可观测
 */
export class AgentLoop {
  private sessions: SessionManager;
  private toolRegistry = new ToolRegistry();
  private llmRouter = new LLMRouter();
  private contextEngines = new Map<string, ContextEngine>();
  private pluginManager = new PluginManager();
  private listeners: AgentEventListener[] = [];
  private defaultContextEngine: ContextEngine;

  constructor() {
    this.sessions = new SessionManager();
    this.defaultContextEngine = new LegacyContextEngine();
    this.contextEngines.set('legacy', this.defaultContextEngine);
  }

  // ---- 注册 ----

  registerTool(tool: RegisteredTool, agentId?: string): void {
    this.toolRegistry.register(tool, agentId);
  }

  registerProvider(provider: LLMProvider): void {
    this.llmRouter.register(provider);
  }

  registerContextEngine(engine: ContextEngine): void {
    this.contextEngines.set(engine.info.id, engine);
  }

  registerPlugin(plugin: Plugin): void {
    this.pluginManager.register(plugin);
  }

  on(listener: AgentEventListener): void {
    this.listeners.push(listener);
  }

  // ---- Session 生命周期 ----

  /**
   * 获取或创建 session（OpenClaw 的路由逻辑）
   */
  resolveSession(
    agent: AgentDefinition,
    channelMessage: ChannelMessage,
    dmScope: string = 'main',
  ): SessionMeta {
    const peerKey = this.buildPeerKey(channelMessage, dmScope);
    let session = this.sessions.findActive(agent.id, peerKey);

    if (!session) {
      session = this.sessions.create({
        agentId: agent.id,
        channelId: channelMessage.channel,
        peerId: peerKey,
      });
    }

    return session;
  }

  private buildPeerKey(msg: ChannelMessage, dmScope: string): string {
    switch (dmScope) {
      case 'per-peer':
        return msg.senderId;
      case 'per-channel-peer':
        return `${msg.channel}:${msg.senderId}`;
      case 'per-account-channel-peer':
        return `${msg.metadata?.accountId ?? 'default'}:${msg.channel}:${msg.senderId}`;
      default:
        return 'main';
    }
  }

  // ---- 核心执行 ----

  /**
   * 处理一条消息（完整的 Agent Loop）
   *
   * OpenClaw 流程：
   * 1. 获取 session write lock
   * 2. Context Engine: ingest
   * 3. Plugin: before_agent_reply（可拦截）
   * 4. 循环：assemble → LLM → tool exec → 直到纯文本回复
   * 5. Plugin: message_sending → 发送
   * 6. Context Engine: afterTurn
   * 7. 持久化 → 释放 lock
   */
  async processMessage(
    agent: AgentDefinition,
    session: SessionMeta,
    channelMessage: ChannelMessage,
  ): Promise<Message> {
    // 1. 获取 session write lock
    const releaseLock = await this.sessions.acquireLock(session.id);

    try {
      const contextEngine = this.resolveContextEngine(agent);

      // 构建用户消息
      const userMessage: Message = {
        role: 'user',
        content: channelMessage.content,
        source: {
          channel: channelMessage.channel,
          senderId: channelMessage.senderId,
          senderName: channelMessage.senderName,
          messageId: channelMessage.id,
          conversationId: channelMessage.conversationId,
        },
        timestamp: channelMessage.timestamp,
      };

      // 2. Context Engine: ingest
      await contextEngine.ingest({
        sessionId: session.id,
        message: userMessage,
      });

      // 加入 session 消息列表
      this.sessions.addMessage(session.id, userMessage);

      // 3. Plugin: before_agent_reply（可以拦截返回合成回复）
      const hookCtx: HookContext = {
        sessionId: session.id,
        agentId: agent.id,
      };
      const syntheticReply = await this.pluginManager.runHook(
        'before_agent_reply',
        { ...hookCtx, messages: this.sessions.getMessages(session.id) },
        null,
      );
      if (syntheticReply) {
        return syntheticReply;
      }

      // 4. 核心循环：assemble → LLM → tool exec
      const maxIterations = 10;
      let iteration = 0;

      while (iteration < maxIterations) {
        iteration++;
        const turnId = randomUUID();
        await this.emit({ type: 'turn_start', turnId, sessionId: session.id });

        // 4a. Context Engine: assemble
        const availableTools = this.toolRegistry.listForAgent(agent.id).map((t) => t.name);
        const assembleResult = await contextEngine.assemble({
          sessionId: session.id,
          messages: this.sessions.getMessages(session.id),
          tokenBudget: agent.model.maxTokens ?? 32768,
          availableTools,
        });

        // 4b. Plugin: before_model_resolve（可以覆盖模型）
        const modelOverride = await this.pluginManager.runHook(
          'before_model_resolve',
          hookCtx,
          null,
        );

        // 4c. Plugin: before_prompt_build（可以注入上下文）
        const promptInjection = await this.pluginManager.runHook(
          'before_prompt_build',
          { ...hookCtx, messages: this.sessions.getMessages(session.id) },
          null,
        );

        // 组装最终的 LLM 请求
        const finalMessages = [...assembleResult.messages];
        if (promptInjection?.prependContext) {
          // 在最后一条 user 消息前插入
          const lastUserIdx = finalMessages.findLastIndex((m) => m.role === 'user');
          if (lastUserIdx >= 0) {
            finalMessages.splice(lastUserIdx, 0, {
              role: 'system',
              content: promptInjection.prependContext,
            });
          }
        }

        const llmRequest: LLMRequest = {
          model: modelOverride?.model ?? agent.model.model,
          messages: finalMessages,
          tools: this.toolRegistry.getDefinitionsForLLM(agent.id),
          temperature: agent.model.temperature ?? 0.7,
          maxTokens: agent.model.maxTokens ?? 4096,
        };

        await this.emit({ type: 'llm_request', request: llmRequest });

        // 4d. LLM 调用
        const providerName = modelOverride?.provider ?? agent.model.provider;
        const provider = this.llmRouter.getProvider(providerName);
        if (!provider) throw new Error(`LLM provider "${providerName}" not found`);

        const startTime = Date.now();
        const llmResponse = await provider.complete(llmRequest);
        await this.emit({ type: 'llm_response', response: llmResponse });

        // 构建 assistant 消息
        const assistantMessage: Message = {
          role: 'assistant',
          content: llmResponse.content,
          toolCalls: llmResponse.toolCalls,
          timestamp: Date.now(),
        };

        // 记录 turn
        const turn: Turn = {
          id: turnId,
          input: this.sessions.getMessages(session.id),
          output: assistantMessage,
          usage: llmResponse.usage,
          durationMs: Date.now() - startTime,
          model: llmResponse.model,
          timestamp: Date.now(),
        };

        // 没有 tool call → 完成
        if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
          this.sessions.addMessage(session.id, assistantMessage);
          this.sessions.addTurn(session.id, turn);
          session.status = 'idle';
          session.updatedAt = Date.now();

          await this.emit({ type: 'turn_end', turn });

          // Context Engine: afterTurn
          await contextEngine.afterTurn({
            sessionId: session.id,
            turn,
          });

          return assistantMessage;
        }

        // 4e. 有 tool call → 执行工具
        session.status = 'processing';
        this.sessions.addMessage(session.id, assistantMessage);
        this.sessions.addTurn(session.id, turn);

        const toolResults = await this.executeToolCalls(
          llmResponse.toolCalls,
          session,
          agent.id,
        );

        // tool results 作为 tool 消息
        const toolMessage: Message = {
          role: 'tool',
          content: JSON.stringify(toolResults),
          toolResults,
          timestamp: Date.now(),
        };
        this.sessions.addMessage(session.id, toolMessage);

        await this.emit({ type: 'turn_end', turn });
        // 继续循环
      }

      // 超过最大迭代
      session.status = 'error';
      const errorMessage: Message = {
        role: 'assistant',
        content: '[Agent Harness] 达到最大迭代次数限制',
        timestamp: Date.now(),
      };
      this.sessions.addMessage(session.id, errorMessage);
      session.updatedAt = Date.now();
      return errorMessage;
    } finally {
      // 7. 释放 session write lock
      releaseLock();
    }
  }

  // ---- 内部方法 ----

  private resolveContextEngine(agent: AgentDefinition): ContextEngine {
    if (agent.contextEngine) {
      const engine = this.contextEngines.get(agent.contextEngine);
      if (engine) return engine;
    }
    return this.defaultContextEngine;
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    session: SessionMeta,
    agentId: string,
  ): Promise<ToolResult[]> {
    const hookCtx: HookContext = {
      sessionId: session.id,
      agentId,
    };

    const results = await Promise.allSettled(
      toolCalls.map(async (call) => {
        // Plugin: before_tool_call
        const blockResult = await this.pluginManager.runHook(
          'before_tool_call',
          { ...hookCtx, call },
          null,
        );
        if (blockResult?.block) {
          return {
            toolCallId: call.id,
            name: call.name,
            result: null,
            error: 'Blocked by plugin',
          };
        }

        await this.emit({ type: 'tool_call', call });
        const startTime = Date.now();

        try {
          const context = {
            sessionId: session.id,
            agentId,
            messages: this.sessions.getMessages(session.id),
          };
          const result = await this.toolRegistry.execute(call.name, call.arguments, context);
          const toolResult: ToolResult = {
            toolCallId: call.id,
            name: call.name,
            result,
            durationMs: Date.now() - startTime,
          };

          // Plugin: after_tool_call
          await this.pluginManager.runHook(
            'after_tool_call',
            { ...hookCtx, call, result: toolResult },
            undefined,
          );

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
        : { toolCallId: 'unknown', name: 'unknown', result: null, error: 'Execution failed' },
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
    this.listeners = [];
  }
}
