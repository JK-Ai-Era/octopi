/**
 * Gateway — 核心守护进程
 *
 * 三层架构 Integration 层组件。
 * 职责：组装 Agent + 挂载协议适配器 + 管理生命周期。
 *
 * 架构：
 *   外部消息 → Channel Adapter → Gateway → SessionAwareRunner → AgentEngine → LLM
 *
 * 使用方式：
 * ```ts
 * const gateway = new Gateway({ agents: [myAgent] });
 * gateway.registerProvider(openaiProvider);
 * gateway.registerChannel(httpAdapter);
 * gateway.registerTool(myTool);
 * await gateway.start();
 * ```
 */

import type {
  AgentDefinition,
  ChannelAdapter,
  ChannelMessage,
  ChannelReply,
  GatewayConfig,
  LLMProvider,
  RegisteredTool,
  SessionMeta,
  AgentEvent,
  HookContext,
} from '../core/types.js';
import type { ModelProvider } from '../core/interfaces/model-provider.js';
import type { SessionStore, SessionData } from '../core/interfaces/session-store.js';
import { PluginManager } from '../plugins/manager.js';
import { AgentEngine } from '../core/engine.js';
import type { RunConfig } from '../core/engine.js';
import { DefaultEventBus } from '../core/event-bus.js';
import { DefaultSecurityGuard } from '../core/security-guard.js';
import { IterationBudget } from '../core/budget.js';
import { DefaultContextPipeline } from '../harness/context/pipeline.js';
import { SessionAwareRunner } from '../harness/runner.js';

// ================================================================
// LLMProvider → ModelProvider 适配器
// ================================================================

/**
 * 将旧 LLMProvider 适配为新 ModelProvider
 */
function adaptLLMProvider(provider: LLMProvider): ModelProvider {
  return {
    name: provider.name,
    chat: async (request) => {
      const response = await provider.complete({
        model: request.model ?? '',
        messages: request.messages as any,
        tools: request.tools as any,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      });
      return {
        content: response.content,
        toolCalls: response.toolCalls,
        usage: response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: response.model,
        finishReason: response.finishReason,
      };
    },
    stream: async function* (request) {
      if (provider.stream) {
        for await (const chunk of provider.stream({
          model: request.model ?? '',
          messages: request.messages as any,
          tools: request.tools as any,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        })) {
          if (chunk.content) {
            yield { type: 'content', content: chunk.content };
          }
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls) {
              yield {
                type: 'tool_call',
                toolCall: {
                  id: tc.id,
                  name: tc.name,
                  arguments: typeof tc.arguments === 'object' ? JSON.stringify(tc.arguments) : (tc.arguments as string ?? '{}'),
                },
              };
            }
          }
        }
        yield { type: 'done' };
      } else {
        const response = await provider.complete({
          model: request.model ?? '',
          messages: request.messages as any,
          tools: request.tools as any,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        });
        yield { type: 'content', content: response.content };
        if (response.toolCalls) {
          for (const tc of response.toolCalls) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: tc.id,
                name: tc.name,
                arguments: typeof tc.arguments === 'object' ? JSON.stringify(tc.arguments) : (tc.arguments as string ?? '{}'),
              },
            };
          }
        }
        yield { type: 'done', usage: response.usage };
      }
    },
    isAvailable: async () => {
      if (provider.healthCheck) return provider.healthCheck();
      return true;
    },
  };
}

// ================================================================
// 内存 Session 存储
// ================================================================

class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async load(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(sessionId: string, data: SessionData): Promise<void> {
    this.sessions.set(sessionId, data);
  }

  async list(_agentId: string): Promise<any[]> {
    return Array.from(this.sessions.values());
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }
}

// ================================================================
// Gateway
// ================================================================

/**
 * Gateway 实现
 *
 * 使用 AgentEngine + SessionAwareRunner 架构。
 */
export class Gateway {
  /** 已注册的 Agent */
  private agents = new Map<string, AgentDefinition>();
  /** 已注册的 Channel Adapter */
  private channels = new Map<string, ChannelAdapter>();
  /** Plugin Manager */
  private pluginManager: PluginManager;
  /** Session Store */
  private store: SessionStore;
  /** Gateway 配置 */
  private config: GatewayConfig;
  /** DM 作用域 */
  private dmScope: string;
  /** 是否已启动 */
  private started = false;
  /** 事件监听器 */
  private listeners: Array<(event: AgentEvent) => void> = [];
  /** Provider（旧接口，用于兼容） */
  private providers = new Map<string, LLMProvider>();
  /** 工具 */
  private tools: RegisteredTool[] = [];

  constructor(config: GatewayConfig) {
    this.config = config;
    this.dmScope = config.session?.dmScope ?? 'main';
    this.pluginManager = new PluginManager();
    this.store = new InMemorySessionStore();

    // 注册配置中定义的 agents
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }
  }

  // ================================================================
  // 生命周期
  // ================================================================

  async start(): Promise<void> {
    if (this.started) {
      console.warn('[Gateway] Already started');
      return;
    }

    console.log('[Gateway] Starting...');
    console.log(`[Gateway] Agents: ${Array.from(this.agents.keys()).join(', ') || '(none)'}`);
    console.log(`[Gateway] Channels: ${Array.from(this.channels.keys()).join(', ') || '(none)'}`);

    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Starting channel: ${name}`);
      await adapter.start(async (msg) => {
        await this.handleInboundMessage(msg);
      });
    }

    this.started = true;
    console.log(`[Gateway] Ready. ${this.agents.size} agent(s), ${this.channels.size} channel(s)`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    console.log('[Gateway] Stopping...');
    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Stopping channel: ${name}`);
      await adapter.stop();
    }

    await this.pluginManager.onGatewayStop();
    this.started = false;
    console.log('[Gateway] Stopped.');
  }

  // ================================================================
  // 注册接口
  // ================================================================

  registerAgent(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
    console.log(`[Gateway] Registered agent: ${agent.id}`);
  }

  registerChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter);
    console.log(`[Gateway] Registered channel: ${adapter.name}`);
  }

  registerTool(tool: RegisteredTool, agentId?: string): void {
    this.tools.push(tool);
  }

  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    console.log(`[Gateway] Registered provider: ${provider.name}`);
  }

  on(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  // ================================================================
  // 核心消息处理
  // ================================================================

  async send(message: ChannelMessage): Promise<void> {
    await this.handleInboundMessage(message);
  }

  getSession(sessionId: string): SessionMeta | undefined {
    // 简化的 session 查询（通过 store）
    return undefined;
  }

  // ================================================================
  // 内部
  // ================================================================

  private async handleInboundMessage(msg: ChannelMessage): Promise<void> {
    console.log(`[Gateway] Inbound message from ${msg.channel}:${msg.senderId} — "${msg.content.substring(0, 50)}..."`);

    // 1. 找到 agent
    const agent = this.resolveAgent(msg);
    if (!agent) {
      console.warn(`[Gateway] No agent resolved for message from ${msg.channel}:${msg.senderId}`);
      return;
    }

    // 2. Plugin: message_received
    const sessionKey = this.buildSessionKey(agent, msg);
    await this.pluginManager.runAllHooks(
      'message_received',
      { sessionId: sessionKey, agentId: agent.id, message: msg },
    );

    // 3. 构建 AgentEngine + SessionAwareRunner
    const { engine, runner } = await this.buildAgent(agent);

    // 4. 构建用户消息
    const userMessage = {
      role: 'user' as const,
      content: msg.content,
      source: {
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        messageId: msg.id,
        conversationId: msg.conversationId,
      },
      timestamp: msg.timestamp,
    };

    // 5. 运行 AgentEngine
    const runConfig: RunConfig = {
      agentId: agent.id,
      sessionId: sessionKey,
      model: agent.model.model,
      systemPrompt: typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '',
    };

    let finalContent = '';

    try {
      for await (const event of runner.handle(sessionKey, userMessage, runConfig)) {
        // 转发事件给监听器
        this.emitEvent(event as any);

        // 捕获最终回复
        if (event.type === 'turn.end' && event.data?.content) {
          finalContent = event.data.content as string;
        }
      }
    } catch (error) {
      console.error(`[Gateway] Error processing message:`, error);
      finalContent = `[Gateway Error] ${error instanceof Error ? error.message : String(error)}`;
    }

    // 6. Plugin: message_sending
    const hookCtx: HookContext = { sessionId: sessionKey, agentId: agent.id };
    const channelReply: ChannelReply = {
      channel: msg.channel,
      conversationId: msg.conversationId,
      content: finalContent,
      replyToId: msg.id,
    };

    const sendBlock = await this.pluginManager.runHook<{ cancel?: boolean } | null>(
      'message_sending',
      { ...hookCtx, reply: channelReply },
      null,
    );

    if (sendBlock?.cancel) {
      console.log(`[Gateway] Reply cancelled by plugin`);
      return;
    }

    // 7. 发送回复
    const adapter = this.channels.get(msg.channel);
    if (adapter && channelReply.content) {
      await adapter.send(channelReply);
      await this.pluginManager.runAllHooks('message_sent', { ...hookCtx, reply: channelReply });
    }
  }

  /**
   * 为 Agent 构建 AgentEngine + SessionAwareRunner
   */
  private async buildAgent(agent: AgentDefinition): Promise<{
    engine: AgentEngine;
    runner: SessionAwareRunner;
  }> {
    // 获取 provider
    const llmProvider = this.providers.get(agent.model.provider);
    if (!llmProvider) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }
    const modelProvider = adaptLLMProvider(llmProvider);

    // 创建 Core 组件
    const events = new DefaultEventBus();
    const security = new DefaultSecurityGuard(events);
    const budget = new IterationBudget(events, {
      maxIterations: 10,
      maxToolCalls: 30,
      maxTokens: 200_000,
      maxWallClockMs: 600_000,
    });

    // 创建工具映射
    const tools = new Map<string, RegisteredTool>();
    for (const tool of this.tools) {
      tools.set(tool.definition.name, tool);
    }

    // 创建 AgentEngine
    const engine = new AgentEngine({
      model: modelProvider,
      tools,
      executor: {
        execute: async (call, ctx) => {
          const tool = tools.get(call.name);
          if (!tool) throw new Error(`Tool "${call.name}" not found`);
          const result = await tool.handler(call.arguments as Record<string, unknown>, {
            sessionId: ctx.callerId ?? 'unknown',
            agentId: agent.id,
            messages: [],
          });
          return { toolCallId: call.id, name: call.name, result };
        },
      },
      context: new DefaultContextPipeline(),
      events,
      security,
      budget,
      errorStrategy: {
        onModelError: (error, attempt) => {
          if (error.reason === 'rate_limit' && attempt < 3) {
            return { action: 'retry', delayMs: (attempt + 1) * 1000 };
          }
          return { action: 'abort', reason: error.message };
        },
        onToolError: () => ({ action: 'skip', reason: 'Tool failed' }),
        onContextOverflow: () => ({ action: 'compact' }),
        onSecurityViolation: (v) => ({ action: 'block', reason: v.description }),
      },
    });

    // 加载 persona
    let systemPrompt = '';
    if (typeof agent.persona === 'object' && agent.persona?.systemPrompt) {
      systemPrompt = agent.persona.systemPrompt;
    }
    (engine as any).__systemPrompt = systemPrompt;

    // 创建 SessionAwareRunner
    const runner = new SessionAwareRunner(engine, this.store);

    return { engine, runner };
  }

  private resolveAgent(msg: ChannelMessage): AgentDefinition | undefined {
    for (const agent of this.agents.values()) {
      if (agent.channelBindings) {
        const binding = agent.channelBindings[msg.channel];
        if (binding) {
          if (binding === '*' || binding === `user:${msg.senderId}`) {
            return agent;
          }
        }
      }
    }
    return this.agents.values().next().value;
  }

  private buildSessionKey(agent: AgentDefinition, msg: ChannelMessage): string {
    switch (this.dmScope) {
      case 'per-peer':
        return `${agent.id}:${msg.senderId}`;
      case 'per-channel-peer':
        return `${agent.id}:${msg.channel}:${msg.senderId}`;
      default:
        return `${agent.id}:main`;
    }
  }

  private emitEvent(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener 错误不应中断流程
      }
    }
  }
}
