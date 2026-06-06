/**
 * Agent Runner — 核心执行引擎
 *
 * @deprecated 使用 LegacyAgentRunner 代替。此类保留用于向后兼容，内部不再维护。
 * LegacyAgentRunner 委托给新架构的 AgentEngine，提供相同的公共 API。
 *
 * ```ts
 * // 旧方式（deprecated）:
 * import { AgentRunner } from 'octopi';
 *
 * // 新方式:
 * import { LegacyAgentRunner } from 'octopi/harness';
 * ```
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
  HookContext,
} from '../core/types.js';
import { SessionManager } from './session-manager.js';
import { ToolRegistry } from '../tools/registry.js';
import { LLMRouter } from '../providers/router.js';
import { LegacyContextEngine } from '../context/engine.js';
import { PluginManager } from '../plugins/manager.js';
import { DefaultSkillManager } from '../skills/manager.js';
import type { SkillManager } from '../core/types.js';
import { runAgentLoop } from '../loop/run-agent-loop.js';
import type { AgentLoopConfig } from '../core/types.js';

/**
 * Agent Runner 配置
 */
export interface AgentRunnerConfig {
  /** 最大工具调用迭代次数（防止无限循环） */
  maxIterations?: number;
  /** Session 数据目录 */
  dataDir?: string;
}

/**
 * Agent Runner
 *
 * 核心执行引擎。接收一条渠道消息，经过完整的处理流程后返回 Agent 回复。
 *
 * 使用方式：
 * ```ts
 * const runner = new AgentRunner();
 * runner.registerProvider(myProvider);
 * runner.registerTool(myTool);
 *
 * const session = runner.resolveSession(agent, channelMsg, 'per-peer');
 * const reply = await runner.processMessage(agent, session, channelMsg);
 * ```
 */
export class AgentRunner {
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
  /** Skill 管理器 */
  private skillManager: SkillManager;

  constructor(config?: AgentRunnerConfig) {
    this.sessions = new SessionManager(config?.dataDir);
    this.defaultContextEngine = new LegacyContextEngine();
    this.contextEngines.set('legacy', this.defaultContextEngine);
    this.maxIterations = config?.maxIterations ?? 10;
    this.skillManager = new DefaultSkillManager();
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
   * 获取插件管理器
   *
   * 使用 pluginManager.discover() 加载 plugins。
   */
  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  // registerSkill 已移除 — 两阶段加载不需要预注册，discover() 自动扫描

  /**
   * 扫描目录发现所有 Skill
   *
   * 期望目录结构：
   *   directory/
   *   ├── skill-a/SKILL.md
   *   ├── skill-b/SKILL.md
   *   └── skill-c/SKILL.md
   *
   * @param directory - Skill 目录路径
   */
  async discoverSkills(directory: string): Promise<void> {
    await this.skillManager.discover(directory);
  }

  /**
   * 获取 Skill 管理器（供外部查询和管理）
   */
  getSkillManager(): SkillManager {
    return this.skillManager;
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

      // ── Step 4.5: Skill 描述注入 ──
      // 所有 Skill 的 name+description 始终在 system prompt 里
      // 不写入 session 持久化（避免重复注入），只在本轮 assemble 时使用
      const skillPromptFragment = this.skillManager.formatForPrompt();

      // ── Step 5: 调用 runAgentLoop（核心循环由 loop 引擎处理） ──
      const provider = this.llmRouter.getProvider(agent.model.provider);
      if (!provider) {
        throw new Error(`LLM provider "${agent.model.provider}" not found.`);
      }

      // 构建 AgentLoopConfig
      const loopConfig: AgentLoopConfig = {
        provider,
        agentId: agent.id,
        workspace: agent.workspace, // ← 传递工作目录
        systemPrompt: typeof agent.persona === 'object' ? agent.persona.systemPrompt : undefined,
        contextEngine,
        toolRegistry: {
          getDefinitions: () => this.toolRegistry.getDefinitionsForLLM(agent.id),
          execute: async (name: string, args: unknown, ctx: unknown) => {
            const tool = this.toolRegistry.get(name, agent.id);
            if (!tool) {
              return { error: `Tool "${name}" not found.` }; // 新类型定义
            }
            try {
              const result = await tool.handler(args as Record<string, unknown>, ctx as any); // 类型断言
              return { result }; // 新类型定义
            } catch (err) {
              return { error: err instanceof Error ? err.message : 'Tool execution failed.' }; // 新类型定义
            }
          },
        },
        messageConverter: {
          toLlm: (msgs: Message[]) => msgs.map(m => ({ role: m.role, content: m.content ?? '' })),
          fromLlm: (msg: any) => msg,
        },
        pluginManager: this.pluginManager,
        skillManager: this.skillManager,
        defaultModel: agent.model.model,
        maxTurns: this.maxIterations,
        iterationBudget: this.maxIterations * 3,
        maxConsecutiveErrors: 3,
        retry: { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 10000 },
        onEvent: (event) => this.emit(event),
      };


      // ── Step 6: 执行 runAgentLoop ──
      const messages = this.sessions.getMessages(session.id);
      const messagesLengthBefore = messages.length; // 记录初始长度，用于同步新增消息
      let finalAssistantMessage: Message | null = null;

      for await (const event of runAgentLoop(loopConfig, messages)) {
        // 转发事件
        await this.emit(event);

        // 捕获最终的 assistant message（纯文本回复）
        if (event.type === 'llm_response' && !event.toolCalls) {
          finalAssistantMessage = {
            role: 'assistant',
            content: event.content,
            timestamp: Date.now(),
          };
        }
      }

      // ── Step 6.5: 持久化 loop 中新增的消息（tool 调用/结果等） ──
      // runAgentLoop 直接修改了 messages 数组，但绕过了 addMessage 的持久化
      // 需要手动同步新增消息到 JSONL
      const newMessages = messages.slice(messagesLengthBefore);
      if (newMessages.length > 0) {
        this.sessions.persistMessages(session.id, newMessages);
      }

      // ── Step 7: 处理最终回复 ──
      if (!finalAssistantMessage) {
        session.status = 'error';
        const errorMessage: Message = {
          role: 'assistant',
          content: '[Octopi] Agent Loop 异常终止，未生成回复。',
          timestamp: Date.now(),
        };
        this.sessions.addMessage(session.id, errorMessage);
        session.updatedAt = Date.now();
        return errorMessage;
      }

      this.sessions.addMessage(session.id, finalAssistantMessage);
      session.status = 'idle';
      session.updatedAt = Date.now();

      // ── Step 8: Context Engine — afterTurn ──
      const turn: Turn = {
        id: randomUUID(),
        input: messages,
        output: finalAssistantMessage,
        usage: undefined,
        durationMs: 0,
        model: agent.model.model,
        timestamp: Date.now(),
      };
      await contextEngine.afterTurn({ sessionId: session.id, turn });

      return finalAssistantMessage;
    } finally {
      // ── Step 9: 释放 session write lock ──
      releaseLock();
    }
  }
  // 内部方法
  // ================================================================

  /**
   * 将内部 Message[] 转换为 LLM API 所需的消息格式
   *
   * 剥离 source/timestamp/toolResults 等内部字段，
   * 为 tool 消息补充 tool_call_id 和 name。
   */
  private prepareLlmMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      const llmMsg: Record<string, unknown> = {
        role: msg.role,
        content: msg.content ?? '',
      };

      // assistant 消息保留 tool_calls
      if (msg.role === 'assistant' && msg.tool_calls) {
        llmMsg.tool_calls = msg.tool_calls;
      }

      // tool 消息：确保有 tool_call_id 和 name
      if (msg.role === 'tool') {
        if (msg.tool_call_id) llmMsg.tool_call_id = msg.tool_call_id;
        else if (msg.toolResults && Array.isArray(msg.toolResults) && msg.toolResults[0]) {
          llmMsg.tool_call_id = msg.toolResults[0].toolCallId;
          llmMsg.name = msg.toolResults[0].name;
        }
        if (msg.name) llmMsg.name = msg.name;
      }

      return llmMsg;
    });
  }

  /**
   * 解析 Agent 使用的上下文引擎
   */
  private resolveContextEngine(agent: AgentDefinition): ContextEngine {
    if (agent.contextEngine) {
      const engine = this.contextEngines.get(agent.contextEngine);
      if (engine) return engine;
      console.warn(`[AgentRunner] Context engine "${agent.contextEngine}" not found, using legacy`);
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
          console.log(`[AgentRunner] Tool "${call.name}" blocked by plugin`);
          return {
            toolCallId: call.id,
            name: call.name,
            result: null,
            error: 'Blocked by plugin',
          };
        }

        await this.emit({ type: 'tool_call_start', toolCallId: call.id, toolName: call.name, arguments: JSON.stringify(call.arguments) });
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

          await this.emit({ type: 'tool_call_result', toolCallId: call.id, toolName: call.name, result: typeof toolResult.result === 'string' ? toolResult.result : JSON.stringify(toolResult.result), durationMs: toolResult.durationMs });
          return toolResult;
        } catch (error) {
          const toolResult: ToolResult = {
            toolCallId: call.id,
            name: call.name,
            result: null,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startTime,
          };
          await this.emit({ type: 'tool_call_error', toolCallId: call.id, toolName: call.name, error: toolResult.error ?? 'Unknown error' });
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
