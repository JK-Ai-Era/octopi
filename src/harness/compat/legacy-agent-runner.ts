/**
 * LegacyAgentRunner — v0.1.x AgentRunner 的新架构实现
 *
 * 保留所有旧的公共 API，内部委托给 AgentEngine + SessionAwareRunner。
 *
 * 迁移映射：
 * - processMessage() → SessionAwareRunner.handle()
 * - resolveSession() → 保留（Session 路由逻辑不变）
 * - registerProvider() → 存储 provider，构建 ModelProvider 适配器
 * - registerTool() → 存储 tool，注入到 AgentEngine
 * - PluginManager hooks → 通过 PluginAdapter 桥接到回调槽
 *
 * 设计要点：
 * - 旧的 ChannelMessage/ChannelReply 格式不变
 * - 旧的 AgentDefinition 不变
 * - 旧的事件系统通过 EventBus 桥接
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  Message,
  ChannelMessage,
  SessionMeta,
  LLMProvider,
  RegisteredTool,
  Turn,
  HookContext,
  AgentEvent,
  AgentEventListener,
  ToolExecutionContext,
} from '../../core/types.js';
import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '../../core/interfaces/model-provider.js';
import type {
  ToolExecutor,
  ExecutionContext,
} from '../../core/interfaces/tool-executor.js';
import type {
  SessionStore,
  SessionData,
} from '../../core/interfaces/session-store.js';
import type {
  EventBus,
} from '../../core/event-bus.js';

import { AgentEngine } from '../../core/engine.js';
import { DefaultEventBus } from '../../core/event-bus.js';
import { DefaultSecurityGuard } from '../../core/security-guard.js';
import { IterationBudget } from '../../core/budget.js';
import { DefaultContextPipeline } from '../context/pipeline.js';
import { SessionAwareRunner } from '../runner.js';
import { adaptPluginHooks, AsyncHookAdapter } from './plugin-adapter.js';

// 旧模块
import { SessionManager } from '../../agent/session-manager.js';
import { LegacyContextEngine } from '../../context/engine.js';
import { ToolRegistry } from '../../tools/registry.js';
import { LLMRouter } from '../../providers/router.js';
import { PluginManager } from '../../plugins/manager.js';
import { DefaultSkillManager } from '../../skills/manager.js';

/** 配置 */
export interface LegacyAgentRunnerConfig {
  maxIterations?: number;
  dataDir?: string;
}

/**
 * LegacyAgentRunner — 兼容 v0.1.x API 的新架构实现
 */
export class LegacyAgentRunner {
  // ── 旧组件（保留兼容） ──
  private sessions: SessionManager;
  private toolRegistry = new ToolRegistry();
  private llmRouter = new LLMRouter();
  private pluginManager = new PluginManager();
  private skillManager = new DefaultSkillManager();
  private listeners: AgentEventListener[] = [];
  private maxIterations: number;

  // ── 新组件 ──
  private eventBus: EventBus;
  private providers = new Map<string, LLMProvider>();

  constructor(config?: LegacyAgentRunnerConfig) {
    this.sessions = new SessionManager(config?.dataDir);
    this.maxIterations = config?.maxIterations ?? 10;
    this.eventBus = new DefaultEventBus();
  }

  // ================================================================
  // 旧公共 API（完全兼容）
  // ================================================================

  /**
   * 注册工具（全局或 Agent 级）
   */
  registerTool(tool: RegisteredTool, agentId?: string): void {
    this.toolRegistry.register(tool, agentId);
  }

  /**
   * 注册 LLM Provider
   */
  registerProvider(provider: LLMProvider): void {
    this.llmRouter.register(provider);
    this.providers.set(provider.name, provider);
  }

  /**
   * 注册事件监听器
   */
  addEventListener(listener: AgentEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * 解析 Session
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

  /**
   * 获取 Session 消息列表
   */
  getMessages(sessionId: string): Message[] {
    return this.sessions.getMessages(sessionId);
  }

  /**
   * 处理消息（核心入口）
   *
   * v0.1.x API 保留。内部委托给新架构。
   */
  async processMessage(
    agent: AgentDefinition,
    session: SessionMeta,
    channelMessage: ChannelMessage,
  ): Promise<Message> {
    // ── Step 1: 获取 session write lock ──
    const releaseLock = await this.sessions.acquireLock(session.id);

    try {
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

      // ── Step 3: 旧 Context Engine ingest（保留兼容） ──
      // 新架构不需要 ingest，但旧的 ContextEngine 插件可能依赖它
      // 暂时保留

      // ── Step 4: 加入 session 消息列表 ──
      this.sessions.addMessage(session.id, userMessage);

      // ── Step 5: Plugin hooks（通过 AsyncHookAdapter） ──
      const hookCtx: HookContext = {
        sessionId: session.id,
        agentId: agent.id,
      };
      const asyncHooks = new AsyncHookAdapter(this.pluginManager, hookCtx);

      // before_agent_reply: 合成回复检查
      const syntheticReply = await asyncHooks.onBeforeAgentReply(
        this.sessions.getMessages(session.id),
      );
      if (syntheticReply) {
        return syntheticReply as Message;
      }

      // before_model_resolve: 模型覆盖
      const modelOverride = await asyncHooks.onBeforeModelResolve(
        agent.persona.systemPrompt,
        agent.model.model,
      );
      const effectiveModel = modelOverride?.model ?? agent.model.model;

      // before_prompt_build: 上下文注入
      const promptInjection = await asyncHooks.onBeforePromptBuild(
        this.sessions.getMessages(session.id),
      );
      const effectiveSystemPrompt = promptInjection?.prependContext
        ? agent.persona.systemPrompt + '\n\n' + promptInjection.prependContext
        : agent.persona.systemPrompt;

      // ── Step 6: 构建新架构组件 ──
      const engine = this.buildEngine(agent);

      // ── Step 7: 运行 AgentEngine ──
      const messages = this.sessions.getMessages(session.id);
      const messagesLengthBefore = messages.length;
      let finalAssistantMessage: Message | null = null;

      for await (const event of engine.run(messages, {
        systemPrompt: effectiveSystemPrompt,
        agentId: agent.id,
        sessionId: session.id,
        model: effectiveModel,
        temperature: agent.model.temperature,
      })) {
        // 转发事件
        await this.emit(event as any);

        // 捕获最终的 assistant message
        if (event.type === 'turn.end' && event.data?.content) {
          finalAssistantMessage = {
            role: 'assistant',
            content: event.data.content as string,
            timestamp: Date.now(),
          };
        }
      }

      // ── Step 8: 持久化新增消息 ──
      const newMessages = messages.slice(messagesLengthBefore);
      if (newMessages.length > 0) {
        this.sessions.persistMessages(session.id, newMessages);
      }

      // ── Step 9: 处理最终回复 ──
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

      return finalAssistantMessage;
    } finally {
      releaseLock();
    }
  }

  // ================================================================
  // 内部方法
  // ================================================================

  /**
   * 为 Agent 构建 AgentEngine
   */
  private buildEngine(agent: AgentDefinition): AgentEngine {
    // ── ModelProvider 适配 ──
    const llmProvider = this.llmRouter.getProvider(agent.model.provider);
    if (!llmProvider) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }
    const modelProvider = this.adaptLLMProvider(llmProvider, agent.model.model);

    // ── ToolExecutor 适配 ──
    const toolExecutor = this.adaptToolRegistry(agent.id);

    // ── 工具映射 ──
    const tools = new Map<string, RegisteredTool>();
    const toolDefs = this.toolRegistry.listForAgent(agent.id);
    for (const def of toolDefs) {
      const tool = this.toolRegistry.get(def.name, agent.id);
      if (tool) tools.set(def.name, tool);
    }

    // ── 创建 Core 组件 ──
    const events = this.eventBus;
    const security = new DefaultSecurityGuard(events);
    const budget = new IterationBudget(events, {
      maxIterations: this.maxIterations,
      maxToolCalls: this.maxIterations * 3,
      maxTokens: 200_000,
      maxWallClockMs: 600_000,
    });
    const context = new DefaultContextPipeline();
    const errorStrategy = {
      onModelError: (error: any, attempt: number) => {
        if (error.reason === 'rate_limit' && attempt < 3) return { action: 'retry' as const, delayMs: (attempt + 1) * 1000 };
        if (error.reason === 'timeout' && attempt < 2) return { action: 'retry' as const, delayMs: 500 };
        return { action: 'abort' as const, reason: error.message };
      },
      onToolError: () => ({ action: 'skip' as const, reason: 'Tool failed' }),
      onContextOverflow: () => ({ action: 'compact' as const }),
      onSecurityViolation: (v: any) => ({ action: 'block' as const, reason: v.description }),
    };

    // ── 创建 AgentEngine ──
    const engine = new AgentEngine({
      model: modelProvider,
      tools,
      executor: toolExecutor,
      context,
      events,
      security,
      budget,
      errorStrategy,
    });

    // ── 注入 Plugin hooks ──
    adaptPluginHooks(engine, this.pluginManager, {
      sessionId: '',
      agentId: agent.id,
    });

    // ── afterTurn: 记录 turn ──
    engine.afterTurn = (turn: Turn) => {
      // 旧系统的 afterTurn 逻辑
    };

    return engine;
  }

  /**
   * LLMProvider → ModelProvider 适配器
   */
  private adaptLLMProvider(provider: LLMProvider, defaultModel: string): ModelProvider {
    return {
      name: provider.name,
      chat: async (request: LLMRequest): Promise<LLMResponse> => {
        const response = await provider.complete({
          model: request.model ?? defaultModel,
          messages: request.messages as any,
          tools: request.tools as any,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        });
        return {
          content: response.content,
          toolCalls: response.toolCalls,
          usage: response.usage,
          model: response.model,
          finishReason: response.finishReason,
        };
      },
      stream: async function* (request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
        if (provider.stream) {
          for await (const chunk of provider.stream({
            model: request.model ?? defaultModel,
            messages: request.messages as any,
            tools: request.tools as any,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
          })) {
            yield {
              type: 'content',
              content: chunk.content,
            };
            if (chunk.toolCalls) {
              for (const tc of chunk.toolCalls) {
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: tc.id,
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                };
              }
            }
          }
          yield { type: 'done' };
        } else {
          // 回退到同步调用
          const response = await provider.complete({
            model: request.model ?? defaultModel,
            messages: request.messages as any,
            tools: request.tools as any,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
          });
          yield { type: 'content', content: response.content };
          yield { type: 'done', usage: response.usage };
        }
      },
      isAvailable: async () => {
        if (provider.healthCheck) return provider.healthCheck();
        return true;
      },
    };
  }

  /**
   * ToolRegistry → ToolExecutor 适配器
   */
  private adaptToolRegistry(agentId: string): ToolExecutor {
    return {
      execute: async (call: any, ctx: ExecutionContext): Promise<any> => {
        const tool = this.toolRegistry.get(call.name, agentId);
        if (!tool) {
          throw new Error(`Tool "${call.name}" not found`);
        }
        const toolCtx: ToolExecutionContext = {
          sessionId: (ctx as any).sessionId ?? 'unknown',
          agentId,
          messages: [],
          abortSignal: (ctx as any).signal,
        };
        return tool.handler(call.arguments, toolCtx);
      },
    };
  }

  /**
   * 发射事件
   */
  private async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch {
        // listener 错误不应中断流程
      }
    }
  }
}
