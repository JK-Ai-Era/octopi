/**
 * Agent Loop — 核心执行循环
 *
 * 这是框架的"心脏"。参考 OpenClaw 的 agent-loop 设计，实现了完整的
 * 消息处理流程：
 *
 *   intake → context assemble → model infer → tool exec → streaming reply → persistence
 *
 * 核心特性：
 * - Session 级 write lock：同一 session 同时只有一个运行
 * - Context Engine 4 阶段生命周期
 * - Plugin hooks 全链路可拦截
 * - 事件流全链路可观测
 * - 最大迭代保护（防止无限工具调用循环）
 *
 * 执行流程：
 *
 *   1. 获取 session write lock
 *   2. Context Engine: ingest（记录消息）
 *   3. Plugin: before_agent_reply（可拦截返回合成回复）
 *   4. 核心循环（最多 N 次）：
 *      a. Context Engine: assemble（组装上下文）
 *      b. Plugin: before_model_resolve（可覆盖模型）
 *      c. Plugin: before_prompt_build（可注入上下文）
 *      d. LLM 调用
 *      e. 如果有 tool_calls → 执行工具 → 继续循环
 *      f. 如果是纯文本 → 完成
 *   5. Plugin: message_sending → 发送
 *   6. Context Engine: afterTurn
 *   7. 持久化 → 释放 lock
 */

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
 * Agent Loop 配置
 */
export interface AgentLoopConfig {
  /** 最大工具调用迭代次数（防止无限循环） */
  maxIterations?: number;
  /** Session 数据目录 */
  dataDir?: string;
}

/**
 * Agent Loop
 *
 * 核心执行引擎。接收一条渠道消息，经过完整的处理流程后返回 Agent 回复。
 *
 * 使用方式：
 * ```ts
 * const loop = new AgentLoop();
 * loop.registerProvider(myProvider);
 * loop.registerTool(myTool);
 *
 * const session = loop.resolveSession(agent, channelMsg, 'per-peer');
 * const reply = await loop.processMessage(agent, session, channelMsg);
 * ```
 */
export class AgentLoop {
  /** Session 管理器 */
  private sessions: SessionManager;
  /** 工具注册中心 */
  private toolRegistry = new ToolRegistry();
  /** LLM 路由器 */
  private llmRouter = new LLMRouter();
  /** 上下文引擎注册表 */
  private contextEngines = new Map<string, ContextEngine>();
  /** 插件管理器 */
  private pluginManager = new PluginManager();
  /** 事件监听器列表 */
  private listeners: AgentEventListener[] = [];
  /** 默认上下文引擎 */
  private defaultContextEngine: ContextEngine;
  /** 最大迭代次数 */
  private maxIterations: number;

  constructor(config?: AgentLoopConfig) {
    this.sessions = new SessionManager(config?.dataDir);
    this.defaultContextEngine = new LegacyContextEngine();
    this.contextEngines.set('legacy', this.defaultContextEngine);
    this.maxIterations = config?.maxIterations ?? 10;
  }

  // ================================================================
  // 注册接口
  // ================================================================

  /**
   * 注册工具（全局或 Agent 级）
   *
   * @param tool - 工具定义和处理函数
   * @param agentId - Agent ID（不传则为全局工具）
   */
  registerTool(tool: RegisteredTool, agentId?: string): void {
    this.toolRegistry.register(tool, agentId);
  }

  /**
   * 注册 LLM Provider
   */
  registerProvider(provider: LLMProvider): void {
    this.llmRouter.register(provider);
  }

  /**
   * 注册上下文引擎
   */
  registerContextEngine(engine: ContextEngine): void {
    this.contextEngines.set(engine.info.id, engine);
  }

  /**
   * 注册插件
   */
  registerPlugin(plugin: Plugin): void {
    this.pluginManager.register(plugin);
  }

  /**
   * 注册事件监听器
   *
   * 事件类型见 AgentEvent。监听器不应抛出异常（会被 catch 忽略）。
   */
  on(listener: AgentEventListener): void {
    this.listeners.push(listener);
  }

  // ================================================================
  // Session 生命周期
  // ================================================================

  /**
   * 获取或创建 session（OpenClaw 的路由逻辑）
   *
   * 根据 dmScope 决定如何路由：
   * - main: 所有消息共享一个 session
   * - per-peer: 每个发送者一个 session
   * - per-channel-peer: 每个渠道+发送者一个 session
   *
   * @param agent - Agent 定义
   * @param channelMessage - 渠道消息
   * @param dmScope - DM 作用域
   * @returns session 元数据
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

  /**
   * 构建对等方标识
   *
   * 根据 dmScope 将渠道消息映射为唯一的对等方标识。
   * 这个标识决定了 session 的复用策略。
   */
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

  // ================================================================
  // 核心执行
  // ================================================================

  /**
   * 处理一条消息（完整的 Agent Loop）
   *
   * 这是框架的核心方法。接收一条渠道消息，经过完整的处理流程后返回 Agent 回复。
   *
   * @param agent - Agent 定义
   * @param session - Session 元数据
   * @param channelMessage - 渠道消息
   * @returns Agent 的回复消息
   */
  async processMessage(
    agent: AgentDefinition,
    session: SessionMeta,
    channelMessage: ChannelMessage,
  ): Promise<Message> {
    // ── Step 1: 获取 session write lock ──
    // 保证同一 session 同时只有一个 Agent Loop 在运行
    const releaseLock = await this.sessions.acquireLock(session.id);

    try {
      const contextEngine = this.resolveContextEngine(agent);

      // ── Step 2: 构建用户消息 ──
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

      // ── Step 3: Context Engine — ingest ──
      // 通知上下文引擎有新消息到达
      await contextEngine.ingest({
        sessionId: session.id,
        message: userMessage,
      });

      // 加入 session 消息列表（内存 + JSONL）
      this.sessions.addMessage(session.id, userMessage);

      // ── Step 4: Plugin — before_agent_reply ──
      // 某些 plugin 可能返回合成回复（如缓存命中、规则引擎）
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

      // ── Step 5: 核心循环 ──
      // assemble → LLM → tool exec → 直到纯文本回复
      let iteration = 0;

      while (iteration < this.maxIterations) {
        iteration++;
        const turnId = randomUUID();
        await this.emit({ type: 'turn_start', turnId, sessionId: session.id });

        // 5a. Context Engine — assemble
        // 组装发送给 LLM 的消息列表（裁剪、注入系统提示词等）
        const availableTools = this.toolRegistry.listForAgent(agent.id).map((t) => t.name);
        const assembleResult = await contextEngine.assemble({
          sessionId: session.id,
          messages: this.sessions.getMessages(session.id),
          tokenBudget: agent.model.maxTokens ?? 32768,
          availableTools,
        });

        // 5b. Plugin — before_model_resolve
        // 可以覆盖模型选择（如 A/B 测试、fallback）
        const modelOverride = await this.pluginManager.runHook<{ model?: string; provider?: string } | null>(
          'before_model_resolve',
          hookCtx,
          null,
        );

        // 5c. Plugin — before_prompt_build
        // 可以注入额外上下文（如 RAG 结果、用户画像）
        const promptInjection = await this.pluginManager.runHook<{ prependContext?: string } | null>(
          'before_prompt_build',
          { ...hookCtx, messages: this.sessions.getMessages(session.id) },
          null,
        );

        // 组装最终的 LLM 请求
        const finalMessages = [...assembleResult.messages];
        if (promptInjection?.prependContext) {
          // 在最后一条 user 消息前插入额外上下文
          const lastUserIdx = finalMessages.map((m) => m.role).lastIndexOf('user');
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

        // 5d. LLM 调用
        const providerName = modelOverride?.provider ?? agent.model.provider;
        const provider = this.llmRouter.getProvider(providerName);
        if (!provider) {
          throw new Error(`LLM provider "${providerName}" not found.`);
        }

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

        // ── 没有 tool call → 完成 ──
        if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
          this.sessions.addMessage(session.id, assistantMessage);
          this.sessions.addTurn(session.id, turn);
          session.status = 'idle';
          session.updatedAt = Date.now();

          await this.emit({ type: 'turn_end', turn });

          // Context Engine — afterTurn
          await contextEngine.afterTurn({
            sessionId: session.id,
            turn,
          });

          return assistantMessage;
        }

        // ── 有 tool call → 执行工具 ──
        session.status = 'processing';
        this.sessions.addMessage(session.id, assistantMessage);
        this.sessions.addTurn(session.id, turn);

        const toolResults = await this.executeToolCalls(
          llmResponse.toolCalls,
          session,
          agent.id,
        );

        // tool results 作为 tool 消息加入上下文
        const toolMessage: Message = {
          role: 'tool',
          content: JSON.stringify(toolResults),
          toolResults,
          timestamp: Date.now(),
        };
        this.sessions.addMessage(session.id, toolMessage);

        await this.emit({ type: 'turn_end', turn });
        // 继续循环，让 LLM 看到 tool results 后生成最终回复
      }

      // ── 超过最大迭代次数 ──
      session.status = 'error';
      const errorMessage: Message = {
        role: 'assistant',
        content: '[Octopi] 达到最大迭代次数限制，停止执行。请检查是否有无限工具调用循环。',
        timestamp: Date.now(),
      };
      this.sessions.addMessage(session.id, errorMessage);
      session.updatedAt = Date.now();
      return errorMessage;
    } finally {
      // ── Step 6: 释放 session write lock ──
      releaseLock();
    }
  }

  // ================================================================
  // 内部方法
  // ================================================================

  /**
   * 解析 Agent 使用的上下文引擎
   */
  private resolveContextEngine(agent: AgentDefinition): ContextEngine {
    if (agent.contextEngine) {
      const engine = this.contextEngines.get(agent.contextEngine);
      if (engine) return engine;
      console.warn(`[AgentLoop] Context engine "${agent.contextEngine}" not found, using legacy`);
    }
    return this.defaultContextEngine;
  }

  /**
   * 执行工具调用
   *
   * 并行执行所有 tool calls，每个都经过 plugin hook 拦截检查。
   * 单个工具执行失败不会影响其他工具。
   */
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
        // Plugin — before_tool_call（可拦截阻止执行）
        const blockResult = await this.pluginManager.runHook<{ block?: boolean } | null>(
          'before_tool_call',
          { ...hookCtx, call },
          null,
        );
        if (blockResult?.block) {
          console.log(`[AgentLoop] Tool "${call.name}" blocked by plugin`);
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

          // Plugin — after_tool_call
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

    // 将 Promise.allSettled 的结果转换为 ToolResult[]
    return results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { toolCallId: 'unknown', name: 'unknown', result: null, error: 'Execution failed' },
    );
  }

  /**
   * 发射事件
   *
   * 通知所有监听器。单个监听器的异常不会影响其他监听器或主流程。
   */
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

  /**
   * 关闭 Agent Loop，清理资源
   */
  async close(): Promise<void> {
    this.listeners = [];
  }

  /**
   * 获取 Session 管理器（供 Gateway 使用）
   */
  getSessionManager(): SessionManager {
    return this.sessions;
  }

  /**
   * 获取 LLM 路由器（供 Gateway 使用）
   */
  getLLMRouter(): LLMRouter {
    return this.llmRouter;
  }
}
