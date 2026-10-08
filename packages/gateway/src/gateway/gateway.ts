/**
 * Gateway ?核心守护进程
 *
 * 三层架构 Integration 层组?
 * 职责：组?Agent + 挂载适配?+ 管理生命周期?
 *
 * 架构?
 *   外部消息 ?Channel Adapter ?Gateway ?SessionAwareRunner ?Agent ?LLM
 *
 * 使用方式?
 * ```ts
 * const gateway = new Gateway({ agents: [myAgent] });
 * gateway.registerProvider(openaiProvider);
 * gateway.registerChannel(httpAdapter);
 * gateway.registerTool(myTool);
 * await gateway.start();
 * ```
 */

import type { RegisteredTool, SessionMeta } from '@octopi-agent/core/types.js';
import type { AgentDefinition, ModelConfig } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { ChannelAdapter, ChannelMessage, ChannelReply } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';
import type { GatewayConfig } from '../types/gateway-config.js';

import type { HookContext } from '@octopi-agent/engine/harness/shared/types/hook-context.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import {
  buildContextLayersSnapshot,
  type ContextLayersSnapshot,
} from '@octopi-agent/engine/harness/context/layer-snapshot.js';
import type {
  AssembleManifest,
  ContextLayerId,
} from '@octopi-agent/engine/harness/context/layer-types.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Observer } from '@octopi-agent/core/interfaces/observer.js';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { applyUserTitle, maybeUpdateSessionTitle } from './session-title.js';
import type { StreamingChannelAdapter } from '../protocols/http.js';
import type { Message } from '@octopi-agent/core/types.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CircuitBreaker } from '@octopi-agent/engine/harness/run/reliability/circuit-breaker.js';
import { wrapProviderWithCircuitBreaker } from '@octopi-agent/engine/harness/run/reliability/provider-wrapper.js';
import { resolveModel, resolveModelRef, resolveCatalogEntry, parseModelRef } from '@octopi-agent/engine/harness/run/model/index.js';
import { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager.js';
import { CommandRouter } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/router.js';
import {
  createBuiltinCommands,
  createClientCatalogCommand,
  issuesFromRegistry,
  skillCommandsFromManager,
  loadUserCommandDefs,
  pluginCommandsFromManager,
  type BuiltinHost,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/index.js';
import type { CommandCatalogItem, SessionOp, SessionReadView } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/commands/types.js';
import { IssueRegistry } from '@octopi-agent/engine/harness/observability/diagnostics/registry.js';
import type { SystemIssue } from '@octopi-agent/engine/harness/observability/diagnostics/types.js';

import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import { AgentRuntime, SessionRunnerDispatcher, ExplicitRouter } from '@octopi-agent/engine/harness/activation/index.js';
import { dispatchChannelMessage } from '@octopi-agent/engine/integration/agent-runtime/channel-message-source.js';
import { SessionAclService } from '@octopi-agent/engine/harness/governance/session-acl/service.js';
import { InProcessSessionLock } from '@octopi-agent/engine/harness/run/concurrency/session-lease.js';
import { ObserverHub } from '@octopi-agent/engine/harness/observability/observer/hub.js';
import type {
  RunMessagesSnapshot,
  RunObservatorySnapshot,
} from '@octopi-agent/engine/harness/observability/observer/types.js';

// Web REST 骨架?Gateway 扩展类型
// ================================================================

/** Pending approval 请求载荷 */
export interface PendingApprovalRequest {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  riskDescription: string;
  actionDescription: string;
}

/** Pending approval 视图 */
export interface PendingApprovalView {
  id: string;
  sessionId: string;
  agentId: string;
  request: PendingApprovalRequest;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  updatedAt?: number;
  decidedAt?: number;
  decisionReason?: string;
}

/** ask_user 待答视图 */
export interface PendingQuestionView {
  id: string;
  sessionId: string;
  agentId: string;
  question: string;
  options?: string[];
  status: 'pending' | 'answered' | 'cancelled';
  createdAt: number;
  updatedAt?: number;
  decidedAt?: number;
  answer?: string;
}

/**
 * cancel 时回给等待方的哨?
 * 工具侧识?abort ，不得把空串当用户回?
 */
export const ASK_USER_CANCELLED = '__ask_user_cancelled__';

/** WebUI 模型条目（与 harness/run/model ModelCatalogEntry 对齐?*/
export interface ModelCatalogItem {
  id: string;
  provider: string;
  model: string;
  /** ?null（未知，不猜测） */
  contextWindow: number | null;
  maxOutputTokens?: number;
  known: boolean;
  source: string;
}

/** Agent 模型 */
export interface AgentModelSummary {
  agentId: string;
  /** agent 配置的默认模?id（`provider/model`?*/
  defaultModelId: string;
}

/** WebUI 模型 */
export interface ModelCatalog {
  models: ModelCatalogItem[];
  agents: AgentModelSummary[];
  /** models.level 分级名（mini/standard/pro 等） */
  levels?: Record<string, { primary: string; fallback?: string[] }>;
}

/** session 模型选择结果 */
export interface SessionModelView {
  sessionId: string;
  agentId: string;
  /** 当前生效模型 id；null 表示沿用 agent  */
  modelId: string | null;
  defaultModelId: string;
  /** 当前生效模型的能力快照（UI 止再猜窗口） */
  resolved?: ModelCatalogItem;
}

// ================================================================
//  Session Store（OCTOPI_HOME/sessions?
// ================================================================

/**
 * 无显?store 时，?OCTOPI_HOME/sessions 创建持久?JSONL store?
 * 改回 SqliteSessionStore（已删除 arch/session-history-search.md?
 */
async function createDefaultStore(_agents: AgentDefinition[]): Promise<SessionStore<SessionData>> {
  const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
  const { join } = await import('node:path');
  const { JsonlSessionStore } = await import('@octopi-agent/engine/integration/storage/jsonl.js');
  return new JsonlSessionStore({
    sessionsDir: join(getOctopiHome(), 'sessions'),
  });
}

export class Gateway {
  /** 已注册的 Agent */
  private agents = new Map<string, AgentDefinition>();
  /** 已注册的 Channel Adapter */
  private channels = new Map<string, ChannelAdapter>();
  /** Plugin Manager */
  private pluginManager: PluginManager;
  /** Session Store */
  private store!: SessionStore<SessionData>;
  /** Gateway 配置 */
  private config: GatewayConfig;
  /** DM 作用?*/
  private dmScope: string;
  /** 已启?*/
  private started = false;
  /** 事件监听?*/
  private listeners: Array<(event: AgentEvent) => void> = [];
  /** Provider */
  private providers = new Map<string, ModelProvider>();
  /** 工具 */
  private tools: RegisteredTool[] = [];
  /** Agent 缓存（避免每条消建） */
  private agentCache = new Map<string, {
    agent: import('@octopi-agent/engine/harness/run/agent/index.js').Agent;
    runner: SessionAwareRunner;
    contextEngine?: import('@octopi-agent/engine/harness/context/types.js').ContextEngine;
    contextHealth?: (agentId?: string) => Promise<import('@octopi-agent/engine/harness/context/layer-health.js').ContextLayerHealth>;
  }>();
  /** 流式 adapter 引用（用于广件） */
  private streamingAdapters: StreamingChannelAdapter[] = [];
  /** 每个 provider 的熔 */
  private circuitBreakers = new Map<string, CircuitBreaker>();
  /**  store 的异步初始化 Promise（未传入 store 时） */
  private _defaultStorePromise?: Promise<SessionStore<SessionData>>;
  /** Web Runtime pending approvals */
  private pendingApprovals = new Map<string, PendingApprovalView>();
  /** ask_user 待答（UI 答完 resolve 等待工具?*/
  private pendingQuestions = new Map<string, PendingQuestionView>();
  private questionResolvers = new Map<string, (answer: string) => void>();
  /** 会话近一次七配快照（?content，仅 REST）；FIFO 防泄?*/
  private lastContextLayers = new Map<string, ContextLayersSnapshot>();
  private static readonly MAX_CONTEXT_LAYERS_SESSIONS = 256;
  /** 产品 Observer 通道（Run 现场?*/
  private observerHub: ObserverHub;
  /** models.level ??WebUI 模型展示分级?*/
  private modelLevels?: Record<string, { primary: string; fallback?: string[] }>;
  /** 主（arch/agent-runtime.md）；消息?dispatch */
  private runtime: AgentRuntime;
  private gatewayBus: DefaultEventBus;
  /** Session ACL（E6）；缺省内置?*/
  private sessionAcl: SessionAclService;
  /** 进程内共?Session Lease（E1/E2）：?Runner 注入同一实例 */
  private sessionLease: import('@octopi-agent/engine/harness/run/concurrency/session-lease.js').InProcessSessionLock;
  /** 会话标题更新去重（同 session 并发只跑一次） */
  private titleUpdatePromises = new Map<string, Promise<void>>();
  /** 进行中又有新触发时的 trailing 标记 */
  private titleUpdatePending = new Set<string>();
  /** Knowledge Service（manageLocal + Client）；Promise 缓存防并发双启动 */
  private knowledgeRuntimePromise?: Promise<
    import('./knowledge-runtime.js').GatewayKnowledgeRuntime
  >;
  /** start() 完成后的 runtime 实例，供 /health 同步读取 */
  private knowledgeRuntimeRef?: import('./knowledge-runtime.js').GatewayKnowledgeRuntime;
  /** 启动过程状态：ref 未就绪时用，避免 /health 把 starting 误报成 disabled */
  private knowledgeBootState: 'idle' | 'starting' | 'failed' = 'idle';
  /** 产品?*/
  private issueRegistry: IssueRegistry;
  /** 会话?/xxx 命令调用?*/
  private commandRouter: CommandRouter;
  /** user/skill 命令载（载，不依?buildAgent?*/
  private commandSourcesReady = false;

  constructor(config: GatewayConfig, store?: SessionStore<SessionData>) {
    this.config = config;
    this.dmScope = config.session?.dmScope ?? 'main';
    this.pluginManager = new PluginManager();
    this.sessionAcl = new SessionAclService(config.sessionAcl);
    this.sessionLease = new InProcessSessionLock();
    this.issueRegistry = new IssueRegistry();
    this.commandRouter = this.createCommandRouter();
    // Gateway EventBus：RuntimeEvents 进可观测总线，并?Gateway listeners（不变量 #6?
    this.gatewayBus = new DefaultEventBus();
    this.observerHub = new ObserverHub(config.observer);
    this.runtime = new AgentRuntime({
      router: new ExplicitRouter(),
      events: this.gatewayBus,
      defaultCoalesceMs: config.agentRuntime?.coalesceWindowMs,
      coalesceBufferLimit: config.agentRuntime?.coalesceBufferLimit,
      admission: {
        expectedMaxConcurrentRuns: config.agentRuntime?.expectedMaxConcurrentRuns,
      },
    });
    this.gatewayBus.onAll((event) => {
      this.emitEvent(event);
      if (event.type === 'context.layers.assembled' && event.sessionId) {
        this.rememberContextLayers(event.sessionId, event);
      }
      // Observer 通道：Runner ?emit 时直?Hub（避免与 bus  timeline/lifecycle?
      // Gateway 留产?Context Map；不再二?ingestEvent
      // 件（turn.end / engine.*）改?processMessage.onEvent ?sessionKey 广播?
      // 这里跳过，避免双投；其余非流式事件仍?bus?
      if (
        event.sessionId &&
        event.type !== 'llm_stream_delta' &&
        !Gateway.isTerminalWsEvent(event.type)
      ) {
        // WS 不广正文全文（content）；?UI ?REST 拉取
        const out =
          event.type === 'context.layers.assembled'
            ? stripLayerContentFromEvent(event)
            : event;
        for (const adapter of this.streamingAdapters) {
          adapter.broadcastEvent(event.sessionId, out as never);
        }
      }
    });
    if (store) {
      this.store = store;
    } else {
      // 延迟化：时解析默认持久化 store
      this._defaultStorePromise = createDefaultStore(config.agents);
    }

    // Issue ?WS 广播
    this.issueRegistry.subscribe((ev) => this.broadcastIssue(ev));

    // 注册配置义的 agents
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }

    this.modelLevels = config.levels;
  }

  /** 设置 models.level 映射（daemon 时注入） */
  setModelLevels(levels: Record<string, { primary: string; fallback?: string[] }> | undefined): void {
    this.modelLevels = levels;
  }

  /** 主（Schedule/Escalate ?Source 挂载 */
  getAgentRuntime(): AgentRuntime {
    return this.runtime;
  }

  /**
   * 按配?Runtime Sources（Schedule / Escalate?
   * 应在 start() 之前调用；与 gatewayBus 同源?
   */
  async configureAgentRuntime(cfg: {
    schedule?: Array<{
      agentId: string;
      sessionId?: string;
      intervalMs?: number;
      cron?: string;
      content: string;
      coalesceKey?: string;
      runOnStart?: boolean;
    }>;
    escalate?: { defaultAgentId?: string; eventType?: string | string[] };
    /** 挂载 AgentSignalSource Agent 通知?*/
    agentSignal?: boolean;
  }): Promise<void> {
    if (cfg.schedule && cfg.schedule.length > 0) {
      const { ScheduleSource } = await import('@octopi-agent/engine/harness/activation/sources/schedule.js');
      this.runtime.addSource(
        new ScheduleSource({
          jobs: cfg.schedule.map((job) => ({
            agentId: job.agentId,
            sessionId: job.sessionId,
            intervalMs: job.intervalMs,
            cron: job.cron,
            coalesceKey: job.coalesceKey,
            runOnStart: job.runOnStart,
            payload: { kind: 'system_note', content: job.content },
            metadata: { source: 'config.schedule' },
          })),
        }),
      );
      console.log(`[Gateway] AgentRuntime ScheduleSource: ${cfg.schedule.length} job(s)`);
    }
    if (cfg.escalate) {
      const { EscalateBridge } = await import(
        '@octopi-agent/engine/harness/activation/sources/escalate-bridge.js'
      );
      this.runtime.addSource(
        new EscalateBridge({
          events: this.gatewayBus,
          defaultAgentId: cfg.escalate.defaultAgentId,
          eventType: cfg.escalate.eventType,
        }),
      );
      console.log(
        `[Gateway] AgentRuntime EscalateBridge (defaultAgentId=${cfg.escalate.defaultAgentId ?? 'n/a'})`,
      );
    }
    if (cfg.agentSignal) {
      const { AgentSignalSource } = await import(
        '@octopi-agent/engine/harness/activation/sources/agent-signal.js'
      );
      this.runtime.addSource(new AgentSignalSource({ events: this.gatewayBus }));
      console.log('[Gateway] AgentRuntime AgentSignalSource');
    }
  }

  // ================================================================
  // 生命周期
  // ================================================================


  /**
   *  store 已就解析 store 的异步初始化?
   */
  private async ensureStore(): Promise<void> {
    if (this._defaultStorePromise) {
      this.store = await this._defaultStorePromise;
      this._defaultStorePromise = undefined;
    }
  }

  async start(): Promise<void> {
    await this.ensureStore();

    if (this.started) {
      console.warn('[Gateway] Already started');
      return;
    }

    console.log('[Gateway] Starting...');
    console.log(`[Gateway] Agents: ${Array.from(this.agents.keys()).join(', ') || '(none)'}`);
    console.log(`[Gateway] Channels: ${Array.from(this.channels.keys()).join(', ') || '(none)'}`);

    // Knowledge 与 channel 并行拉起：HTTP 就绪时 /health 不必再读到启动窗口
    const knowledgeBoot = this.bootKnowledgeRuntime();

    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Starting channel: ${name}`);
      await adapter.start(async (msg) => {
        await this.handleInboundMessage(msg);
      });
    }

    // Plugin 已注册命令合?+ user/skill 命令装载（必须在收消?
    try {
      this.registerPluginCommands();
    } catch (err) {
      console.warn(`[Gateway] plugin command register failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.ensureCommandSources();

    await this.runtime.start();
    // Ready 前必须拿到 Knowledge 终态，保证启动日志与 /health 一致
    await knowledgeBoot;
    this.started = true;
    console.log(`[Gateway] Ready. ${this.agents.size} agent(s), ${this.channels.size} channel(s)`);
  }

  /** 拉起 Knowledge Service（manageLocal / 远程）；失败只降级，不拖死 Gateway */
  private async bootKnowledgeRuntime(): Promise<void> {
    try {
      const krt = await this.getKnowledgeRuntime();
      console.log(`[Gateway] knowledge runtime: ${krt.state}`);
    } catch (kErr) {
      this.knowledgeBootState = 'failed';
      console.warn(
        `[Gateway] knowledge runtime start failed: ${kErr instanceof Error ? kErr.message : String(kErr)}`,
      );
    }
  }

  /**
   * Knowledge 运行时同步状态快照（供 /health）。不编造 ready。
   *
   * @returns starting=启动中；disabled=未启用/未拉起；ready/degraded 来自 runtime 实测
   */
  getKnowledgeState(): import('./knowledge-runtime.js').KnowledgeRuntimeState | 'starting' {
    if (this.knowledgeRuntimeRef) return this.knowledgeRuntimeRef.state;
    if (this.knowledgeBootState === 'starting') return 'starting';
    if (this.knowledgeBootState === 'failed') return 'degraded';
    return 'disabled';
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    console.log('[Gateway] Stopping...');
    // 先断 SSE，再关 Knowledge Service（server.close 会等长连接排空）
    try {
      this.knowledgeProgressForward?.();
      this.knowledgeProgressForward = undefined;
      const kn = await this.knowledgeRuntimePromise?.catch(
        () => null as import('./knowledge-runtime.js').GatewayKnowledgeRuntime | null,
      );
      this.knowledgeRuntimePromise = undefined;
      this.knowledgeRuntimeRef = undefined;
      this.knowledgeBootState = 'idle';
      if (kn) {
        await kn.stop();
      }
    } catch (kStopErr) {
      console.warn(
        `[Gateway] knowledge stop failed: ${kStopErr instanceof Error ? kStopErr.message : String(kStopErr)}`,
      );
    }
    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Stopping channel: ${name}`);
      await adapter.stop();
    }

    // 释放 Runner 后台 timer（BackfillTrigger / HealthProbe / SubsystemRuntime?
    for (const cached of this.agentCache.values()) {
      try {
        cached.runner.dispose();
      } catch {
        // stop  fail-open，不阻断关闭
      }
    }
    this.agentCache.clear();

    await this.runtime.stop();
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
    // 测是否支持流式广?
    if ('broadcastEvent' in adapter && typeof adapter.broadcastEvent === 'function') {
      this.streamingAdapters.push(adapter as StreamingChannelAdapter);
    }
    // 注册回调
    if ('onAbort' in adapter) {
      (adapter as any).onAbort = (sessionId: string) => this.abortSession(sessionId);
    }
    // 注册欢迎消息扩展（agent 信息 + 命令 + open issues?
    if ('onWelcome' in adapter) {
      (adapter as any).onWelcome = () => {
        const agents = Array.from(this.agents.entries()).map(([id, agent]) => ({
          id,
          model: agent.model,
        }));
        return {
          agents,
          commands: this.getCommandCatalog(),
          issues: this.listSystemIssues('open'),
        };
      };
    }
    console.log(`[Gateway] Registered channel: ${adapter.name}`);
  }

  registerTool(tool: RegisteredTool, agentId?: string): void {
    this.tools.push(tool);
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
    console.log(`[Gateway] Registered provider: ${provider.name}`);
  }

  on(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  /**
   * 指定 session 在运行的 agent
   * 归属：Runtime 持有 AbortController；Gateway （arch/agent-runtime.md §8.1?
   */
  abortSession(sessionId: string): void {
    this.cancelPendingQuestions(sessionId);
    for (const agentId of this.agents.keys()) {
      this.runtime.abort(agentId, sessionId);
    }
  }

  // ================================================================
  // Commands / System Issues（arch/slash-commands.md · arch/system-issues.md?
  // ================================================================

  getIssueRegistry(): IssueRegistry {
    return this.issueRegistry;
  }

  getCommandRouter(): CommandRouter {
    return this.commandRouter;
  }

  getCommandCatalog(): CommandCatalogItem[] {
    return this.commandRouter.listCatalog();
  }

  listSystemIssues(status?: SystemIssue['status']): SystemIssue[] {
    return this.issueRegistry.list(status ? { status } : undefined);
  }

  private createCommandRouter(): CommandRouter {
    const issueRegistry = this.issueRegistry;
    const host: BuiltinHost = {
      hasActiveRun: (sessionId, agentId) => this.runtime.hasActiveRun(agentId, sessionId),
      currentModel: (sessionId, agentId) => {
        // 仅能读缓存；完整值走 view（execute 入参?
        void agentId;
        void sessionId;
        return undefined;
      },
      listModels: () =>
        this.getModelCatalog().models.map((m) => ({
          id: `${m.provider}/${m.model}`,
          description: m.known ? m.source : undefined,
        })),
      listIssues: issuesFromRegistry(issueRegistry),
      listCatalogNames: () =>
        this.commandRouter.listDefinitions().map((d) => ({
          name: d.name,
          description: d.description,
          usage: d.usage,
          source: d.source,
        })),
    };

    const router = new CommandRouter({ issueRegistry });
    for (const def of createBuiltinCommands(host)) {
      router.register(def, 'builtin');
    }
    router.register(createClientCatalogCommand(), 'builtin:client');
    return router;
  }

  /** Skill command 桥接（启?/ buildAgent 发现 skill 后调冲突?Issue?*/
  registerSkillCommands(skills: import('@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/types.js').SkillManager): void {
    const defs = skillCommandsFromManager(skills, (id) => skills.load(id));
    // ref = skillId：同 skill 重载 upsert；不?skill ?command 名可冲突
    for (const skill of skills.list()) {
      if (!skill.command) continue;
      const def = defs.find((d) => d.name === skill.command);
      if (def) {
        this.commandRouter.register(def, `skill:${skill.id}`);
      }
    }
  }

  /** 用户 commands/*.md（agent.home/commands?*/
  registerUserCommands(agentId: string, directory: string): void {
    const loaded = loadUserCommandDefs(directory);
    for (const { definition, ref } of loaded) {
      this.commandRouter.register(definition, ref);
    }
    if (loaded.length) {
      console.log(
        `[Gateway] user commands for ${agentId}: ${loaded.map((x) => '/' + x.definition.name).join(', ')}`,
      );
    }
  }

  /**
   * 时注册各 agent ?user/skill 命令?
   * 必须在命决前完成?/help ?Loop 前看不到义命?
   */
  async ensureCommandSources(): Promise<void> {
    if (this.commandSourcesReady) return;
    this.commandSourcesReady = true;
    for (const agent of this.agents.values()) {
      if (!agent.home) continue;
      try {
        this.registerUserCommands(agent.id, join(agent.home, 'commands'));
      } catch (err) {
        console.warn(
          `[Gateway] user command load failed for agent "${agent.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const skillDir =
        agent.skillDirectory ?? join(agent.home, 'skills');
      try {
        if (existsSync(skillDir)) {
          const { DefaultSkillManager } = await import(
            '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/manager.js'
          );
          const skillManager = new DefaultSkillManager();
          await skillManager.discover(skillDir);
          this.registerSkillCommands(skillManager);
        }
      } catch (err) {
        console.warn(
          `[Gateway] skill command load failed for agent "${agent.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Plugin registerCommand ?Router（plugin load 后调 */
  registerPluginCommands(): void {
    for (const def of pluginCommandsFromManager(this.pluginManager)) {
      const r = this.commandRouter.register(def, `plugin:${def.name}`);
      if (!r.ok) {
        this.issueRegistry.report({
          id: `commands:command.conflict:${def.name}`,
          domain: 'commands',
          code: 'command.conflict',
          severity: 'warning',
          title: `命令 /${def.name} 冲突`,
          detail: `plugin 命令注册冲突（${r.reason}）`,
          refs: [{ label: `plugin: ${def.name}`, pluginId: def.name }],
        });
      }
    }
  }

  private buildSessionReadView(sessionId: string, agentId: string): SessionReadView {
    return {
      sessionId,
      agentId,
      hasActiveRun: this.runtime.hasActiveRun(agentId, sessionId),
    };
  }

  private async applySessionOps(
    sessionId: string,
    agentId: string,
    ops: SessionOp[] | undefined,
    result: { newSessionId?: string; display?: { type: 'text' | 'markdown' | 'json'; text: string }; status?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!ops?.length) return { ok: true };
    for (const op of ops) {
      try {
        switch (op.op) {
          case 'abort_run':
            this.runtime.abort(agentId, sessionId);
            this.abortSession(sessionId);
            break;
          case 'new_session': {
            // 敛：把当前会话标 recent 并带 sessionText，供补录触发（不切换?
            try {
              const old = await this.store.load(sessionId);
              if (old) {
                const sessionText = (old.messages ?? [])
                  .filter((m) => {
                    const kind = m.metadata?.kind;
                    return kind !== 'command' && kind !== 'command_result';
                  })
                  .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')}`)
                  .join('\n')
                  .slice(0, 8000);
                const now = Date.now();
                old.lifecycle = { lifecycle: 'recent', endedAt: now };
                old.meta.updatedAt = now;
                await this.store.save(sessionId, old);
                this.gatewayBus.emit({
                  type: 'session.lifecycle.updated',
                  timestamp: now,
                  agentId,
                  sessionId,
                  data: {
                    lifecycle: 'recent',
                    lastInteractionAt: old.meta.lastInteractionAt,
                    sessionText,
                    reason: 'new_session',
                  },
                });
              }
            } catch {
              // 切换会话不因补录失败而中?
            }
            const meta = await this.createSession({ agentId });
            result.newSessionId = meta.id;
            break;
          }
          case 'set_model':
            await this.setSessionModel(sessionId, op.model, agentId);
            break;
          case 'compact':
            await this.compactSession(sessionId, agentId);
            break;
          case 'set_preferred_agent':
            // reserved；V1 不落?
            break;
          default:
            break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ?op 失败：收?error，仍继续后续 op / 避免 UI 
        result.status = 'error';
        result.display = {
          type: 'text',
          text: `命令已接收，但执行副作用失败?{msg}`,
        };
        return { ok: false, error: msg };
      }
    }
    return { ok: true };
  }

  private async appendCommandDiscourse(
    sessionId: string,
    agentId: string,
    raw: string,
    displayText: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const session = await this.store.load(sessionId);
      if (!session) return;
      const now = Date.now();
      session.messages.push({
        role: 'user',
        content: raw,
        timestamp: now,
        agentId,
        metadata: { kind: 'command', ...extra },
      });
      session.messages.push({
        role: 'assistant',
        content: displayText,
        timestamp: now + 1,
        agentId,
        metadata: { kind: 'command_result', ...extra },
      });
      session.meta.updatedAt = now;
      session.meta.lastInteractionAt = now;
      await this.store.save(sessionId, session);
    } catch {
      // 留痕失败不阻令结果回放（Discourse 投影建）
    }
  }

  private broadcastCommandResult(sessionId: string, payload: Record<string, unknown>): void {
    const event = {
      type: 'command.result',
      sessionId,
      timestamp: Date.now(),
      data: payload,
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(sessionId, event);
    }
  }

  /**
   * control 命令合成 turn.end Web/TUI ?streaming 并展?display ?
   * 命令不进 Loop，不会由 Runner 产出 turn.end?
   * **不带 error:true**oop ?turn.end+error 表示重试/waiting，会把命令结果打回运?
   * type=text）转 Markdown 行；markdown 原样?
   */
  private broadcastCommandTurnEnd(
    sessionId: string,
    content: string,
    displayType: 'text' | 'markdown' | 'json' = 'text',
  ): void {
    const raw = content ?? '';
    const text = displayType === 'text' ? raw.split('\n').join('  \n') : raw;
    const event = {
      type: 'turn.end',
      sessionId,
      timestamp: Date.now(),
      data: {
        content: text,
        phase: 'final',
        hasToolCalls: false,
        fromCommand: true,
      },
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(sessionId, event);
    }
  }

  private broadcastIssue(ev: { type: string; issue?: SystemIssue; id?: string; status?: string }): void {
    const event = {
      type: ev.type === 'resolved' ? 'system.issue.resolved' : 'system.issue',
      sessionId: '*',
      timestamp: Date.now(),
      data: ev.type === 'resolved' ? { id: ev.id, status: ev.status } : { issue: ev.issue },
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      // 系统级问题：广播给全?WS 会话
      adapter.broadcastEvent('*', event);
    }
  }

  // ================================================================
  // Web Runtime: read/write surface for REST skeleton
  // ================================================================

  getRegisteredAgents(): Array<{ id: string; model: ModelConfig }> {
    return Array.from(this.agents.entries()).map(([id, agent]) => ({ id, model: agent.model }));
  }

  /**
   * WebUI 模型
   *
   * @returns 已注?provider 的全部模?+ agent 模型 + level 映射
   */
  getModelCatalog(): ModelCatalog {
    const seen = new Map<string, ModelCatalogItem>();
    const models: ModelCatalogItem[] = [];

    const push = (entry: ModelCatalogItem, opts?: { preferAgentExplicit?: boolean }) => {
      const prev = seen.get(entry.id);
      if (prev) {
        // agent 模型的配口优先（?session model 视图致）
        if (opts?.preferAgentExplicit && entry.known && entry.contextWindow != null) {
          seen.set(entry.id, entry);
          const idx = models.findIndex(m => m.id === entry.id);
          if (idx >= 0) models[idx] = entry;
        }
        return;
      }
      seen.set(entry.id, entry);
      models.push(entry);
    };

    const catalogOf = (
      providerName: string,
      modelName: string,
      explicit?: { contextWindow?: number; maxOutputTokens?: number },
    ): ModelCatalogItem => {
      const e = resolveCatalogEntry({
        providerName,
        modelName,
        providers: this.providers,
        explicit,
      });
      return {
        id: e.id,
        provider: e.provider,
        model: e.model,
        contextWindow: e.contextWindow,
        maxOutputTokens: e.maxOutputTokens,
        known: e.known,
        source: e.source,
      };
    };

    for (const [providerName, provider] of this.providers) {
      // provider.models 串模型（无能力字段）；必须入 catalog，窗口可?null
      const declaredNames = provider.models ?? [];
      const names = new Set<string>([
        ...declaredNames,
        ...(provider.defaultModel ? [provider.defaultModel] : []),
      ]);
      for (const name of names) {
        push(catalogOf(providerName, name));
      }
      for (const info of provider.getModelInfos()) {
        push(catalogOf(providerName, info.name, {
          contextWindow: info.contextWindow,
          maxOutputTokens: info.maxOutputTokens,
        }));
      }
    }

    const agents: AgentModelSummary[] = [];
    for (const [id, agent] of this.agents) {
      const defaultModelId = `${agent.model.provider}/${agent.model.model}`;
      // agent 配置?explicit 窗口优先?provider 无能力条?
      push(catalogOf(agent.model.provider, agent.model.model, {
        contextWindow: agent.model.contextWindow,
        maxOutputTokens: agent.model.maxTokens,
      }), { preferAgentExplicit: true });
      agents.push({ agentId: id, defaultModelId });
    }

    models.sort((a, b) => a.id.localeCompare(b.id));
    return {
      models,
      agents,
      ...(this.modelLevels ? { levels: this.modelLevels } : {}),
    };
  }

  /**
   *  session 当前模型选择
   *
   * @param sessionId - 会话 id
   * @param agentId - ?agent 过滤
   * @returns 模型视图；session 不存在时返回 null
   */
  async getSessionModel(sessionId: string, _agentId?: string): Promise<SessionModelView | null> {
    const session = await this.store.load(sessionId);
    if (!session) return null;
    return this.buildSessionModelView(session);
  }

  private buildSessionModelView(session: SessionData): SessionModelView {
    const agent = this.agents.get(session.agentId);
    const defaultModelId = agent
      ? `${agent.model.provider}/${agent.model.model}`
      : '';
    const modelId = this.readSessionModelId(session.metadata);
    const effectiveId = modelId ?? defaultModelId;
    const resolved = effectiveId
      ? this.catalogItemForRef(effectiveId, agent)
      : undefined;
    return {
      sessionId: session.id,
      agentId: session.agentId,
      modelId,
      defaultModelId,
      resolved,
    };
  }

  private catalogItemForRef(
    modelRef: string,
    agent: AgentDefinition | undefined,
  ): ModelCatalogItem | undefined {
    const parsed = parseModelRef(modelRef, agent?.model.provider);
    const providerName = parsed.provider ?? agent?.model.provider;
    if (!providerName) return undefined;
    const isDefault = agent
      ? modelRef === `${agent.model.provider}/${agent.model.model}`
      || parsed.model === agent.model.model
      : false;
    const e = resolveCatalogEntry({
      providerName,
      modelName: parsed.model,
      providers: this.providers,
      explicit: isDefault
        ? {
            contextWindow: agent?.model.contextWindow,
            maxOutputTokens: agent?.model.maxTokens,
          }
        : undefined,
    });
    return {
      id: e.id,
      provider: e.provider,
      model: e.model,
      contextWindow: e.contextWindow,
      maxOutputTokens: e.maxOutputTokens,
      known: e.known,
      source: e.source,
    };
  }

  /**
   * 设置 session 级模
   *
   * @param sessionId - 会话 id
   * @param modelRef - `provider/model`、裸模型名或 null（恢?agent ?
   * @param agentId - ?agent
   * @returns 更新后的模型视图
   */
  async setSessionModel(
    sessionId: string,
    modelRef: string | null,
    _agentId?: string,
  ): Promise<SessionModelView> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const agent = this.agents.get(session.agentId);
    const defaultProvider = agent?.model.provider;
    const defaultModelId = agent
      ? `${agent.model.provider}/${agent.model.model}`
      : '';

    if (modelRef === null || modelRef === '') {
      delete session.metadata.model;
    } else {
      const parsed = parseModelRef(modelRef, defaultProvider);
      const providerName = parsed.provider ?? defaultProvider;
      if (!providerName) {
        throw new Error(`Cannot resolve provider for model "${modelRef}"`);
      }
      const provider = this.providers.get(providerName);
      if (!provider) {
        throw new Error(`LLM provider "${providerName}" not found`);
      }
      // 规范化存储为 provider/model
      session.metadata.model = {
        provider: providerName,
        model: parsed.model,
      };
    }

    session.meta.updatedAt = Date.now();
    await this.store.save(session.id, session);

    return this.buildSessionModelView(session);
  }

  private readSessionModelId(metadata: Record<string, unknown> | undefined): string | null {
    const raw = metadata?.model;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (raw && typeof raw === 'object') {
      const obj = raw as { provider?: unknown; model?: unknown };
      if (typeof obj.model === 'string' && obj.model) {
        return typeof obj.provider === 'string' && obj.provider
          ? `${obj.provider}/${obj.model}`
          : obj.model;
      }
    }
    return null;
  }

  /**
   * 手动结构压缩（不依赖 contextWindow?
   *
   * ?SessionAwareRunner.handle **共用 session ?*（E1/E4?
   * 权威互斥，不?status==='processing'；同 sessionId ?run/compact 排队?
   * Compact ?= (sessionId, agentId)；全?messages 仍保留在 session store?
   *
   * @param sessionId - 会话 id
   * @param agentId - ?agent（避免全 agent ；缺省用 session.agentId?
   * @returns 压缩结果
   */
  async compactSession(
    sessionId: string,
    agentId?: string,
  ): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter?: number;
    summary?: string;
  }> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    // E4：compact 用调用方 agentId（缺?primary）；不静默改?
    const effectiveAgentId = agentId ?? session.primaryAgentId ?? session.agentId;
    let cached = this.agentCache.get(effectiveAgentId);
    if (!cached) {
      const def = this.agents.get(effectiveAgentId);
      if (!def) {
        throw new Error(`Agent "${effectiveAgentId}" not found`);
      }
      cached = await this.buildAgent(def);
      this.agentCache.set(effectiveAgentId, cached);
    }

    const engine = cached.contextEngine;
    type StructuralEngine = {
      compactStructural?: (input: {
        sessionId: string;
        agentId?: string;
        messages: import('@octopi-agent/core/types.js').Message[];
        summarize?: (messages: import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[], opts?: { maxTokens?: number }) => Promise<string>;
        compactTargetTokens?: number;
      }) => Promise<{
        ok: boolean;
        compacted: boolean;
        reason?: string;
        tokensBefore: number;
        tokensAfter?: number;
        summary?: string;
      }>;
    };
    const structural = engine as StructuralEngine | undefined;

    if (!structural?.compactStructural) {
      return {
        ok: false,
        compacted: false,
        reason: 'context engine does not support structural compact',
        tokensBefore: 0,
      };
    }

    const agentDef = this.agents.get(effectiveAgentId);
    const modelRef = this.readSessionModelId(session.metadata);
    const { createProviderSummarize } = await import('@octopi-agent/engine/harness/context/summarize.js');
    const { resolveModelRef } = await import('@octopi-agent/engine/harness/run/model/index.js');
    type SummarizeFn = (messages: import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[], opts?: { maxTokens?: number }) => Promise<string>;

    let summarize: SummarizeFn | undefined;
    const bound = modelRef
      ? resolveModelRef(modelRef, {
          providers: this.providers,
          defaultProvider: agentDef?.model.provider,
          isOverride: true,
        })
      : agentDef
        ? resolveModelRef(`${agentDef.model.provider}/${agentDef.model.model}`, {
            providers: this.providers,
            isOverride: false,
          })
        : null;
    if (bound) {
      summarize = createProviderSummarize(bound.provider);
    }

    const compactTargetTokens =
      this.config.context?.contextAssembler?.compactTargetTokens;

    // D1：与 handle 共用 Runner session 锁；持久化走 Runner（E4 
    return cached.runner.compactSession(sessionId, effectiveAgentId, {
      compactStructural: (input) =>
        structural.compactStructural!({
          sessionId: input.sessionId,
          agentId: input.agentId,
          messages: input.messages,
          summarize: input.summarize,
          compactTargetTokens: input.compactTargetTokens,
        }),
      summarize,
      compactTargetTokens,
    });
  }

  getProviderSummaries(): Array<{ name: string; circuitBreaker: { state: string; failureCount: number } }> {
    const result: Array<{ name: string; circuitBreaker: { state: string; failureCount: number } }> = [];
    for (const [name] of this.providers) {
      const cb = this.circuitBreakers.get(name);
      result.push({ name, circuitBreaker: cb ? cb.snapshot() : { state: 'closed', failureCount: 0 } });
    }
    return result;
  }

  async listSessions(agentId?: string): Promise<SessionMeta[]> {
    return this.store.list(agentId ? { agentId } : undefined);
  }

  /**
   * 手动重命名会话标题（titleSource=user，永不被自动摘要覆盖）。
   *
   * @param sessionId - 目标会话
   * @param title - 用户标题
   * @returns 更新后的 SessionMeta
   */
  async renameSession(sessionId: string, title: string): Promise<SessionMeta> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const applied = applyUserTitle(session, title);
    if (!applied) {
      throw new Error('title must not be empty');
    }
    await this.store.save(sessionId, session);
    this.broadcastSessionUpdated(sessionId, applied, 'user');
    return session.meta;
  }

  /**
   * turn 落盘后异步更新标题（snippet / 小模型摘要）；失败不影响主流程。
   *
   * 同 session 串行；进行中再触发则标记 trailing，结束后补跑一次，避免丢掉第二轮升级。
   *
   * @param sessionId - 目标会话
   */
  private scheduleSessionTitleUpdate(sessionId: string): void {
    if (this.titleUpdatePromises.has(sessionId)) {
      this.titleUpdatePending.add(sessionId);
      return;
    }
    const run = async (): Promise<void> => {
      try {
        await maybeUpdateSessionTitle(sessionId, {
          load: (id) => this.store.load(id),
          save: (id, data) => this.store.save(id, data),
          providers: this.providers,
          modelLevels: this.modelLevels,
          resolveFallback: (session) => this.resolveTitleModelRef(session),
          onTitleUpdated: (id, title, titleSource) => this.broadcastSessionUpdated(id, title, titleSource),
        });
      } catch (err) {
        // 标题是展示元数据；失败保持原标题，不阻断对话
        console.warn(
          `[SessionTitle] update failed (session=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    const task = (async () => {
      try {
        await run();
      } finally {
        this.titleUpdatePromises.delete(sessionId);
        if (this.titleUpdatePending.delete(sessionId)) {
          this.scheduleSessionTitleUpdate(sessionId);
        }
      }
    })();
    this.titleUpdatePromises.set(sessionId, task);
  }

  private resolveTitleModelRef(session: SessionData): { provider: ModelProvider; model?: string } | null {
    const agentId = session.primaryAgentId ?? session.agentId;
    const agentDef = this.agents.get(agentId);
    const modelRef = this.readSessionModelId(session.metadata);
    const tryResolve = (ref: string): { provider: ModelProvider; model?: string } | null => {
      const slash = ref.indexOf('/');
      if (slash <= 0) return null;
      const providerName = ref.slice(0, slash);
      const model = ref.slice(slash + 1);
      const provider = this.providers.get(providerName);
      return provider ? { provider, model } : null;
    };
    if (modelRef) {
      const bound = tryResolve(modelRef);
      if (bound) return bound;
    }
    if (agentDef) {
      const bound = tryResolve(`${agentDef.model.provider}/${agentDef.model.model}`);
      if (bound) return bound;
      const provider = this.providers.get(agentDef.model.provider);
      if (provider) return { provider, model: agentDef.model.model };
    }
    return null;
  }

  private broadcastSessionUpdated(
    sessionId: string,
    title: string,
    titleSource: 'snippet' | 'auto' | 'user',
  ): void {
    const event = {
      type: 'session.updated',
      sessionId,
      timestamp: Date.now(),
      data: { sessionId, title, titleSource, updatedAt: Date.now() },
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(sessionId, event);
    }
  }

  async createSession(options: { agentId: string; sessionId?: string; metadata?: Record<string, unknown> }): Promise<SessionMeta> {
    const agent = this.agents.get(options.agentId);
    if (!agent) {
      throw new Error(`Agent "${options.agentId}" not found`);
    }

    // 文件系统安全：避?`:` 等字符（Windows 文件名非法）
    const sessionId = options.sessionId ?? `${options.agentId}-web-${Date.now()}`;
    const session: SessionData = {
      id: sessionId,
      agentId: options.agentId,
      primaryAgentId: options.agentId,
      meta: {
        id: sessionId,
        agentId: options.agentId,
        channelId: 'web',
        peerId: 'web-ui',
        status: 'idle',
        createdAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages: [],
      turns: [],
      metadata: options.metadata ?? {},
      tasks: [],
    };

    await this.store.save(sessionId, session);
    return session.meta;
  }


  /**
   * 查找 session（sessionId 等；无需遍历 agent?
   */
  private async findSession(sessionId: string): Promise<SessionData | null> {
    return this.store.load(sessionId);
  }

  async getSessionView(sessionId: string, _agentId?: string): Promise<{ meta: SessionMeta; messageCount: number; turnCount: number; taskCount?: number } | null> {
    const session = await this.store.load(sessionId);
    if (!session) return null;
    return {
      meta: session.meta,
      messageCount: session.messages.length,
      turnCount: session.turns.length,
      taskCount: session.tasks?.length ?? 0,
    };
  }

  /**
   * 会话任务列表（只读，?UI?
   */
  async getSessionTasks(sessionId: string, _agentId?: string): Promise<SessionData['tasks']> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    return (session.tasks ?? []).map((t) => ({ ...t }));
  }

  async getSessionMessages(sessionId: string, options: { limit: number; cursor?: string; agentId?: string }): Promise<{ messages: Message[]; nextCursor?: string }> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const offset = options.cursor ? Number(Buffer.from(options.cursor, 'base64').toString('utf-8')) : 0;
    const slice = session.messages.slice(offset, offset + options.limit);
    const nextOffset = offset + slice.length;
    const nextCursor = nextOffset < session.messages.length ? Buffer.from(String(nextOffset)).toString('base64') : undefined;

    return { messages: slice, nextCursor };
  }

  async getMemoryStats(): Promise<Record<string, unknown> | null> {
    // 预留：当?Gateway ?MemoryStore，返?null 表示?
    return null;
  }

  //  Knowledge 源注册（OCTOPI_HOME/knowledge/knowledge.db）─

  /** 会话附件服务（OP-15；懒加载?*/
  private attachmentServicePromise?: Promise<
    import('@octopi-agent/engine/harness/session/attachments/service.js').SessionAttachmentService
  >;

  /**
   * 会话附件服务（OCTOPI_HOME/sessions/&lt;sid&gt;/attachments?
   */
  async getAttachmentService(): Promise<
    import('@octopi-agent/engine/harness/session/attachments/service.js').SessionAttachmentService
  > {
    if (!this.attachmentServicePromise) {
      this.attachmentServicePromise = (async () => {
        const { SessionAttachmentService } = await import(
          '@octopi-agent/engine/harness/session/attachments/service.js'
        );
        const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
        const { join } = await import('node:path');
        const att = this.config.knowledge?.attachments;
        const documentPort = await this.getDocumentPort();
        return new SessionAttachmentService({
          sessionsDir: join(getOctopiHome(), 'sessions'),
          documentPort,
          limits: {
            ...(att?.maxFiles != null ? { maxFiles: att.maxFiles } : {}),
            ...(att?.maxFileBytes != null ? { maxFileBytes: att.maxFileBytes } : {}),
            ...(att?.maxTotalBytes != null ? { maxTotalBytes: att.maxTotalBytes } : {}),
            ...(att?.allowedExtensions?.length
              ? { allowedExtensions: att.allowedExtensions }
              : {}),
          },
        });
      })();
    }
    return this.attachmentServicePromise;
  }

  private documentPortPromise?: Promise<
    import('@octopi-agent/engine/harness/capabilities/document/types.js').DocumentPort | null
  >;

  /**
   * DocumentPort（documents.extract.enabled === false 时为 null?
   */
  async getDocumentPort(): Promise<
    import('@octopi-agent/engine/harness/capabilities/document/types.js').DocumentPort | null
  > {
    if (!this.documentPortPromise) {
      this.documentPortPromise = (async () => {
        const extract = this.config.documents?.extract;
        if (extract?.enabled === false) return null;
        const { createDocumentPortFromConfig } = await import(
          '@octopi-agent/engine/harness/capabilities/document/index.js'
        );
        return createDocumentPortFromConfig(this.config.documents);
      })();
    }
    return this.documentPortPromise;
  }

  /**
   * 列出会话附件
   */
  async listSessionAttachments(
    sessionId: string,
  ): Promise<import('@octopi-agent/engine/harness/session/attachments/types.js').SessionAttachment[]> {
    const svc = await this.getAttachmentService();
    return svc.list(sessionId);
  }

  /**
   * 上传会话附件（JSON + base64 ?utf8 文本?
   */
  async uploadSessionAttachments(
    sessionId: string,
    files: Array<{ name: string; mime?: string; dataBase64?: string; text?: string }>,
  ): Promise<import('@octopi-agent/engine/harness/session/attachments/types.js').SessionAttachment[]> {
    const svc = await this.getAttachmentService();
    const out: import('@octopi-agent/engine/harness/session/attachments/types.js').SessionAttachment[] = [];
    for (const f of files) {
      const data = f.dataBase64
        ? Buffer.from(f.dataBase64, 'base64')
        : Buffer.from(f.text ?? '', 'utf8');
      out.push(await svc.save(sessionId, { name: f.name, mime: f.mime, data }));
    }
    return out;
  }

  /**
   * 删除单条会话附件（若?make-searchable 则顺?purge Knowledge source?
   */
  async deleteSessionAttachment(sessionId: string, attachmentId: string): Promise<boolean> {
    const svc = await this.getAttachmentService();
    const item = svc.get(sessionId, attachmentId);
    if (!item) return false;
    const removed = await svc.delete(sessionId, attachmentId);
    if (removed && item.searchableSourceId) {
      try {
        await this.removeKnowledgeSource(item.searchableSourceId);
      } catch (err) {
        console.warn(
          `[Gateway] purge searchable source failed (${item.searchableSourceId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return removed;
  }

  /**
   * 归入项目：移动到项目 directory 源（OP-15 promote?
   */
  async promoteSessionAttachment(
    sessionId: string,
    attachmentId: string,
    opts: { projectKey: string; targetSourceId?: string },
  ): Promise<{ attachment: import('@octopi-agent/engine/harness/session/attachments/types.js').SessionAttachment; targetPath: string }> {
    const svc = await this.getAttachmentService();
    const client = await this.getKnowledgeClient();
    const all = (await client.listSources()) as unknown as Array<{
      id: string;
      kind: string;
      location: string;
      scopeRef: { level: string; key: string };
    }>;
    const sources = all.filter(
      (s) =>
        s.scopeRef.level === 'project' &&
        s.scopeRef.key === opts.projectKey &&
        (s.kind === 'directory' || s.kind === 'file' || s.kind === 'workspace'),
    );
    const target = opts.targetSourceId
      ? sources.find((s) => s.id === opts.targetSourceId)
      : sources.find((s) => s.kind === 'directory') ?? sources[0];
    if (opts.targetSourceId && !target) {
      throw new Error(`targetSourceId not found in project "${opts.projectKey}": ${opts.targetSourceId}`);
    }
    if (!target) {
      throw new Error(
        `project "${opts.projectKey}" has no directory/file source to receive the attachment; create one first`,
      );
    }

    const { rename, mkdir, access } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    void dirname;
    const item = svc.get(sessionId, attachmentId);
    if (!item) throw new Error(`attachment not found: ${attachmentId}`);
    const from = svc.resolveAbsolutePath(sessionId, attachmentId);
    const destDir =
      target.kind === 'file' ? dirname(target.location) : target.location;
    await mkdir(destDir, { recursive: true });
    const to = join(destDir, item.name);
    try {
      await access(to);
      throw new Error(`target already has a file named ${item.name}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('target already')) throw err;
      // 不存在则继续 move
    }
    await rename(from, to);
    // 若有抽取伴生且不同名，一并移?
    if (item.extractPath && item.extractPath !== item.path) {
      const fromExtract = join(svc.attachmentRoot(sessionId), item.extractPath);
      const toExtract = join(destDir, item.extractPath);
      try {
        await rename(fromExtract, toExtract);
      } catch {
        // 伴生缺失不阻?promote
      }
    }
    const marked = await svc.markPromoted(sessionId, attachmentId, {
      projectKey: opts.projectKey,
      targetSourceId: target.id,
    });
    return { attachment: marked, targetPath: to };
  }

  /**
   * 附件升为注册 scopeRef=session ?Knowledge source ?ingest
   */
  async makeAttachmentSearchable(
    sessionId: string,
    attachmentId: string,
  ): Promise<{
    attachment: import('@octopi-agent/engine/harness/session/attachments/types.js').SessionAttachment;
    sourceId: string;
    status: string;
  }> {
    const svc = await this.getAttachmentService();
    const item = svc.get(sessionId, attachmentId);
    if (!item) throw new Error(`attachment not found: ${attachmentId}`);
    if (item.status === 'promoted') {
      throw new Error('attachment already promoted to project');
    }
    if (item.searchableSourceId) {
      const client = await this.getKnowledgeClient();
      try {
        const existing = (await client.getSource(
          item.searchableSourceId,
        )) as unknown as { id: string; status: string };
        if (existing) {
          return {
            attachment: item,
            sourceId: existing.id,
            status: existing.status,
          };
        }
      } catch {
        // 源已删则继续注册
      }
    }
    const abs = svc.resolveAbsolutePath(sessionId, attachmentId);
    const source = await this.createKnowledgeSource({
      kind: 'file',
      location: abs,
      scopeRef: { level: 'session', key: sessionId },
      displayName: item.name,
      description: `会话附件 · ${item.name}`,
      sync: { strategy: 'manual', enabled: true },
    });
    const re = await this.reindexKnowledgeSource(source.id, { full: true, watch: false });
    const marked = await svc.markSearchable(sessionId, attachmentId, source.id);
    return { attachment: marked, sourceId: source.id, status: re.status };
  }

  /**
   * 解析 chat 消息附件指针（TriggerAttachmentRef?
   */
  async resolveAttachmentRefs(
    sessionId: string,
    attachmentIds: unknown,
  ): Promise<import('@octopi-agent/engine/harness/activation/types.js').TriggerAttachmentRef[]> {
    if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return [];
    const svc = await this.getAttachmentService();
    const { join: pathJoin } = await import('node:path');
    const refs: import('@octopi-agent/engine/harness/activation/types.js').TriggerAttachmentRef[] = [];
    for (const id of attachmentIds) {
      if (typeof id !== 'string') continue;
      const item = svc.get(sessionId, id);
      if (!item || item.status === 'promoted') continue;
      const abs = svc.resolveAbsolutePath(sessionId, id);
      const extractAbs = item.extractPath
        ? pathJoin(svc.attachmentRoot(sessionId), item.extractPath)
        : abs;
      refs.push({
        id: item.id,
        name: item.name,
        mime: item.mime,
        sizeBytes: item.sizeBytes,
        path: extractAbs,
        kind: item.kind,
      });
    }
    return refs;
  }

  /**
   * Knowledge Service 时（懒启manageLocal 或远?baseUrl?
   */
  async getKnowledgeRuntime(): Promise<
    import('./knowledge-runtime.js').GatewayKnowledgeRuntime
  > {
    if (!this.knowledgeRuntimePromise) {
      this.knowledgeBootState = 'starting';
      this.knowledgeRuntimePromise = (async () => {
        const { GatewayKnowledgeRuntime } = await import('./knowledge-runtime.js');
        const rt = new GatewayKnowledgeRuntime();
        const kn = this.config.knowledge as
          | {
              service?: {
                baseUrl?: string;
                token?: string;
                manageLocal?: boolean;
                timeoutMs?: number;
              };
              embed?: {
                enabled?: boolean;
                embedBatch?: number;
                embedMinIntervalMs?: number;
                embedConcurrency?: number;
                embedSecretPolicy?: 'allow' | 'redact' | 'skip';
              };
            }
          | undefined;
        const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
        const { resolveKnowledgePaths } = await import(
          '@octopi-agent/engine/harness/knowledge/index.js'
        );
        const paths = resolveKnowledgePaths(getOctopiHome());
        const embeddingModels = {
          providers: this.config.modelProviders ?? {},
          embedding: this.config.embedding,
        };
        const embForVec = this.config.embedding as { sqliteVecExtensionPath?: string } | undefined;
        await rt.start(kn?.service, {
          dataDir: paths.root ?? paths.dbPath.replace(/[/\\][^/\\]+$/, ''),
          gatewayId: process.env.OCTOPI_GATEWAY_ID ?? 'gw-local',
          documentConfig: this.config.documents ?? null,
          embeddingModels,
          embed: kn?.embed,
          ...(embForVec?.sqliteVecExtensionPath
            ? { sqliteVecExtensionPath: embForVec.sqliteVecExtensionPath }
            : {}),
        });
        this.knowledgeRuntimeRef = rt;
        void this.startKnowledgeProgressForwarding().catch(() => undefined);
        return rt;
      })();
    }
    return this.knowledgeRuntimePromise;
  }

  /**
   * v2：Gateway **?*打开 knowledge.db；写/读一律经 Knowledge Service?
   * 保留方法名仅作兼容编译面，调用应改为 getKnowledgeClient()?
   */
  async getKnowledgeSourceStore(): Promise<never> {
    throw new Error('knowledge_disabled: use Knowledge Service (getKnowledgeClient)');
  }

  /**
   * Knowledge API（v2）：优先 KnowledgeClient；Service 抛可感知
   */
  async getKnowledgeClient(): Promise<
    import('@octopi-agent/engine/harness/knowledge/client.js').KnowledgeClient
  > {
    const rt = await this.getKnowledgeRuntime();
    const client = rt.knowledgeClient;
    if (!client || rt.state === 'disabled') {
      throw new Error('knowledge_disabled');
    }
    if (rt.state === 'degraded') {
      // 仍尝试调失败由上层降?
    }
    return client;
  }

  /** SSE ?WS （knowledge.index.progress）；幂等 */
  private knowledgeProgressForward?: () => void;

  async startKnowledgeProgressForwarding(): Promise<void> {
    if (this.knowledgeProgressForward) return;
    const rt = await this.getKnowledgeRuntime();
    if (rt.state === 'disabled' || !rt.knowledgeClient) return;
    const stop = await rt.subscribeProgress((evt) => {
      const event = {
        type: evt.type === 'knowledge.index.progress' ? 'knowledge.index.progress' : evt.type,
        timestamp: Date.now(),
        data: (evt.data ?? {}) as Record<string, unknown>,
      };
      this.emitEvent(event);
      for (const adapter of this.streamingAdapters) {
        adapter.broadcastEvent('*', event);
      }
    });
    this.knowledgeProgressForward = stop;
  }

  /**
   * 知识源列???Knowledge Service
   */
  async listKnowledgeSources(
    agentId: string,
    opts?: {
      sessionId?: string;
      scopeLevel?: 'global' | 'project' | 'session';
      projectKey?: string;
    },
  ): Promise<import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource[]> {
    const client = await this.getKnowledgeClient();
    await client.ensurePrincipal(agentId).catch(() => undefined);
    const raw = await client.listSources({
      ...(opts?.scopeLevel ? { scopeLevel: opts.scopeLevel } : {}),
      ...(opts?.projectKey ? { projectKey: opts.projectKey } : {}),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    });
    return raw as unknown as import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource[];
  }

  /**
   * 注册知识???Knowledge Service
   */
  async createKnowledgeSource(
    input: import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSourceInput,
  ): Promise<import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource> {
    const allowedKinds = new Set(['workspace', 'directory', 'file', 'url', 'connector']);
    const allowedLevels = new Set(['global', 'project', 'session']);
    if (!allowedKinds.has(input.kind)) {
      throw new Error(`invalid kind: ${input.kind}`);
    }
    if (!input.location?.trim()) {
      throw new Error('location is required');
    }
    if (!allowedLevels.has(input.scopeRef?.level)) {
      throw new Error(`invalid scopeRef.level: ${input.scopeRef?.level}`);
    }
    const client = await this.getKnowledgeClient();
    const src = await client.createSource(input as unknown as Record<string, unknown>);
    return src as unknown as import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource;
  }

  /**
   * 更新知识??Knowledge Service
   */
  async updateKnowledgeSource(
    id: string,
    patch: import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSourcePatch,
  ): Promise<import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource | null> {
    const client = await this.getKnowledgeClient();
    const updated = await client.patchSource(id, patch as unknown as Record<string, unknown>);
    return updated as unknown as import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource;
  }

  /**
   * 卸载知识??Knowledge Service（解?+ ?purge?
   */
  async removeKnowledgeSource(id: string): Promise<boolean> {
    const client = await this.getKnowledgeClient();
    await client.deleteSource(id);
    return true;
  }

  /**
   * Project 挂载 / Global 屏蔽（可?Knowledge Service
   */
  async setKnowledgeVisibility(action: {
    op: 'assignProject' | 'unassignProject' | 'hide' | 'unhide';
    agentId: string;
    projectKey?: string;
    sourceId?: string;
  }): Promise<void> {
    const client = await this.getKnowledgeClient();
    await client.visibility(action.agentId, action.op, {
      projectKey: action.projectKey,
      sourceId: action.sourceId,
    });
  }

  /**
   * Knowledge 注册表统??Knowledge Service
   */
  async getKnowledgeStats(agentId: string): Promise<Record<string, number>> {
    const client = await this.getKnowledgeClient();
    await client.ensurePrincipal(agentId).catch(() => undefined);
    const stats = await client.stats(agentId);
    return stats as unknown as Record<string, number>;
  }

  /**
   * 项目视图（先建项挂源?
   */
  async listKnowledgeProjects(): Promise<
    Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
    }>
  > {
    const client = await this.getKnowledgeClient();
    const rows = await client.listProjects();
    return rows as unknown as Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
    }>;
  }

  async createKnowledgeProject(projectKey: string, displayName?: string): Promise<void> {
    const client = await this.getKnowledgeClient();
    await client.createProject({ projectKey, displayName });
  }

  async removeKnowledgeProject(projectKey: string): Promise<boolean> {
    const client = await this.getKnowledgeClient();
    await client.deleteProject(projectKey);
    return true;
  }

  /**
   * 单源详情 + 索引规模
   */
  async getKnowledgeSourceDetail(sourceId: string): Promise<
    | (import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource & {
        fileCount: number;
        chunkCount: number;
        embeddingCount: number;
        errorFileCount: number;
        skippedFileCount: number;
        assignedAgentIds: string[];
        hiddenForAgentIds: string[];
        jobControl: import('@octopi-agent/engine/harness/knowledge/ingest.js').KnowledgeJobControlState;
      })
    | null
  > {
    const client = await this.getKnowledgeClient();
    let detail: Record<string, unknown> | null = null;
    try {
      detail = (await client.getSource(sourceId)) as Record<string, unknown> | null;
    } catch {
      return null;
    }
    if (!detail) return null;
    const stats = (detail.stats ?? {}) as Record<string, number>;
    const jobControl = (detail.jobControl ?? {
      aborted: false,
      jobsQueued: 0,
      jobsRunning: 0,
      jobsCancelled: 0,
      embedMissing: false,
      canAbort: false,
      canResume: false,
    }) as import('@octopi-agent/engine/harness/knowledge/ingest.js').KnowledgeJobControlState;
    return {
      ...(detail as unknown as import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource),
      fileCount: Number(stats.files ?? 0),
      chunkCount: Number(stats.chunks ?? 0),
      embeddingCount: Number(stats.embeddings ?? 0),
      errorFileCount: Number(stats.errors ?? 0),
      skippedFileCount: Number(stats.skipped ?? 0),
      assignedAgentIds: (detail.assignedAgentIds as string[] | undefined) ?? [],
      hiddenForAgentIds: (detail.hiddenForAgentIds as string[] | undefined) ?? [],
      jobControl,
    };
  }

  /**
   * 源下索引文件列表 ?Knowledge Service
   */
  async listKnowledgeSourceFiles(sourceId: string): Promise<
    import('@octopi-agent/engine/harness/knowledge/index-store.js').IndexedFileRecord[]
  > {
    const client = await this.getKnowledgeClient();
    const files = await client.listFiles(sourceId);
    return files as unknown as import('@octopi-agent/engine/harness/knowledge/index-store.js').IndexedFileRecord[];
  }

  /** 源文件分页：走 Service 服务端分页（禁止全量 listFiles 再本地分） */
  async listKnowledgeSourceFilesPaged(
    sourceId: string,
    opts?: {
      status?: 'indexed' | 'skipped' | 'error' | 'all';
      ext?: string;
      q?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<{
    items: Array<
      import('@octopi-agent/engine/harness/knowledge/index-store.js').IndexedFileRecord & {
        ext: string;
      }
    >;
    total: number;
    page: number;
    pageSize: number;
    statusCounts: { indexed: number; skipped: number; error: number };
    extCounts: Array<{ ext: string; n: number }>;
  }> {
    const client = await this.getKnowledgeClient();
    return client.listFilesPaged(sourceId, opts) as unknown as Promise<{
      items: Array<
        import('@octopi-agent/engine/harness/knowledge/index-store.js').IndexedFileRecord & {
          ext: string;
        }
      >;
      total: number;
      page: number;
      pageSize: number;
      statusCounts: { indexed: number; skipped: number; error: number };
      extCounts: Array<{ ext: string; n: number }>;
    }>;
  }

  /**
   * 重做文件：强制重新解?分块/向量
   *
   * @param sourceId - ?id
   * @param opts.paths - 指定；或
   * @param opts.filter - 按当前列表筛选批?
   * @returns 入队条数
   */
  async reprocessKnowledgeFiles(
    sourceId: string,
    opts: {
      paths?: string[];
      filter?: {
        status?: string;
        ext?: string;
        q?: string;
      };
    },
  ): Promise<{
    ok: true;
    queued: number;
    alreadyActive: number;
    cleanedNonFiles: number;
    resumed: boolean;
    rejected: number;
  }> {
    const paths = opts?.paths?.filter((p) => typeof p === 'string' && p) ?? [];
    const filter = opts?.filter;
    const hasFilter =
      filter != null && (filter.status != null || filter.ext != null || filter.q != null);
    if (paths.length === 0 && !hasFilter) {
      throw new Error('bad_request: paths or filter required');
    }
    const client = await this.getKnowledgeClient();
    const data = await client.reprocess(sourceId, {
      ...(paths.length > 0 ? { paths } : {}),
      ...(hasFilter ? { filter } : {}),
    });
    return { ok: true, ...data };
  }

  /** 级任?文件重做完成跟踪?*/
  async knowledgePathJobStates(
    sourceId: string,
    paths: string[],
  ): Promise<
    Array<{
      path: string;
      jobsActive: number;
      fileStatus: string | null;
      chunkCount: number;
      error: string | null;
      exists: boolean;
    }>
  > {
    const client = await this.getKnowledgeClient();
    const [files, jobs] = await Promise.all([
      client.listFiles(sourceId) as unknown as Promise<
        Array<{ path: string; status: string; chunkCount: number; error?: string }>
      >,
      client.jobs({ sourceId }) as unknown as Promise<
        Array<{ path?: string | null; status: string }>
      >,
    ]);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const activeByPath = new Map<string, number>();
    for (const j of jobs) {
      if (!j.path) continue;
      if (j.status !== 'queued' && j.status !== 'running') continue;
      activeByPath.set(j.path, (activeByPath.get(j.path) ?? 0) + 1);
    }
    return paths.map((p) => {
      const f = byPath.get(p);
      return {
        path: p,
        jobsActive: activeByPath.get(p) ?? 0,
        fileStatus: f?.status ?? null,
        chunkCount: f?.chunkCount ?? 0,
        error: f?.error ?? null,
        exists: Boolean(f),
      };
    });
  }

  /**
   * 按路径列 chunk理面?
   */
  async listKnowledgeChunks(agentId: string, sourceId: string, path: string): Promise<
    Array<{
      id: string;
      path: string;
      text: string;
      startLine: number;
      endLine: number;
    }>
  > {
    const client = await this.getKnowledgeClient();
    await client.ensurePrincipal(agentId).catch(() => undefined);
    const rows = await client.listChunks(agentId, sourceId, path);
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      text: r.text,
      startLine: r.startLine,
      endLine: r.endLine,
    }));
  }

  /**
   * 宿主直搜理面试搜；effective view?Knowledge Service
   */
  async searchKnowledge(
    query: string,
    opts: { agentId: string; sessionId?: string; limit?: number },
  ): Promise<import('@octopi-agent/engine/harness/knowledge/retriever.js').HybridSearchResult> {
    const client = await this.getKnowledgeClient();
    await client.ensurePrincipal(opts.agentId).catch(() => undefined);
    const data = await client.search(opts.agentId, query, {
      sessionId: opts.sessionId,
      limit: opts.limit,
    });
    return data as unknown as import('@octopi-agent/engine/harness/knowledge/retriever.js').HybridSearchResult;
  }

  /**
   * 会话视图 overlay ?Knowledge Service
   */
  async getKnowledgeSessionVisibility(
    agentId: string,
    sessionId: string,
  ): Promise<import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSessionVisibilityItem[]> {
    const client = await this.getKnowledgeClient();
    await client.ensurePrincipal(agentId).catch(() => undefined);
    const rows = await client.sessionVisibility(agentId, sessionId);
    return rows as unknown as import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSessionVisibilityItem[];
  }

  async setKnowledgeSessionVisibility(
    agentId: string,
    sessionId: string,
    item: import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSessionVisibilityInput,
  ): Promise<void> {
    const client = await this.getKnowledgeClient();
    await client.setSessionVisibility(agentId, {
      sessionId,
      targetType: item.targetType,
      targetId: item.targetId,
      op: item.op,
    });
  }

  async replaceKnowledgeSessionVisibility(
    agentId: string,
    sessionId: string,
    items: readonly import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSessionVisibilityInput[],
  ): Promise<void> {
    const client = await this.getKnowledgeClient();
    // Service 侧 PUT replace（先清后写），不在 Gateway 循环 upsert
    await client.replaceSessionVisibility(
      agentId,
      sessionId,
      items.map((i) => ({ targetType: i.targetType, targetId: i.targetId, op: i.op })),
    );
  }

  async clearKnowledgeSessionVisibility(
    agentId: string,
    sessionId: string,
    target?: {
      targetType: import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeVisibilityTargetType;
      targetId: string;
    },
  ): Promise<void> {
    const client = await this.getKnowledgeClient();
    await client.clearSessionVisibility(agentId, sessionId, target);
  }

  /**
   * Agent ?base 性摘要（排查图；不含会话 overlay?
   */
  async getKnowledgeVisibility(agentId: string): Promise<{
    hiddenSourceIds: string[];
    globalSources: Array<
      import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource & { hiddenForAgent: boolean }
    >;
    assignedProjects: Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
      sources: import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource[];
    }>;
    unassignedProjects: Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
    }>;
  }> {
    const client = await this.getKnowledgeClient();
    await client.ensurePrincipal(agentId).catch(() => undefined);
    const vis = await client.getVisibility(agentId);
    const sources = (await client.listSources()) as unknown as Array<
      import('@octopi-agent/engine/harness/knowledge/types.js').KnowledgeSource
    >;
    const projects = (await client.listProjects()) as Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
    }>;
    const hiddenSet = new Set(vis.hiddenSourceIds ?? []);
    const assignedKeys = new Set(vis.assignedProjects ?? []);
    const sourcesOfProject = (key: string) =>
      sources.filter((s) => s.scopeRef?.level === 'project' && s.scopeRef?.key === key);
    const isMountedForAgent = (p: { projectKey: string; assignedAgentIds: string[] }) =>
      assignedKeys.has(p.projectKey) || p.assignedAgentIds.includes(agentId);

    return {
      hiddenSourceIds: vis.hiddenSourceIds ?? [],
      globalSources: sources
        .filter((s) => s.scopeRef?.level === 'global')
        .map((s) => ({ ...s, hiddenForAgent: hiddenSet.has(s.id) })),
      assignedProjects: projects.filter(isMountedForAgent).map((p) => ({
        projectKey: p.projectKey,
        displayName: p.displayName,
        sourceCount: p.sourceCount,
        assignedAgentIds: p.assignedAgentIds,
        sources: sourcesOfProject(p.projectKey),
      })),
      unassignedProjects: projects
        .filter((p) => !isMountedForAgent(p))
        .map((p) => ({
          projectKey: p.projectKey,
          displayName: p.displayName,
          sourceCount: p.sourceCount,
          assignedAgentIds: p.assignedAgentIds,
        })),
    };
  }

  /**
   * 提升来自 knowledge.promotion.metrics?
   */
  async getKnowledgePromotionCandidates(): Promise<
    import('@octopi-agent/engine/harness/knowledge/hit-log.js').PromotionCandidate[]
  > {
    const client = await this.getKnowledgeClient();
    return (await client.promotionCandidates()) as import('@octopi-agent/engine/harness/knowledge/hit-log.js').PromotionCandidate[];
  }

  /**
   * v2：ingest ?Knowledge Service 内；Gateway 不再持有
   */
  async getKnowledgeIngest(): Promise<never> {
    throw new Error('knowledge_disabled: ingest runs in Knowledge Service');
  }

  /**
   * 触发源索引（P2 Phase A）；?watch；索引排空后后台 auto-describe
   *
   * HTTP 不等待整?parse 完成会把请求挂住，且?UI 读库争用?
   */
  async reindexKnowledgeSource(
    sourceId: string,
    opts?: { full?: boolean; watch?: boolean },
  ): Promise<{ ok: true; sourceId: string; status: string }> {
    const client = await this.getKnowledgeClient();
    await client.reindex(sourceId);
    return { ok: true, sourceId, status: 'indexing' };
  }

  /**
   * 手动知识索引任务 ?Knowledge Service
   */
  async abortKnowledgeJobs(sourceId?: string): Promise<{
    ok: true;
    cancelledQueued: number;
    abortedRunning: number;
    runningJobs: number;
  }> {
    const client = await this.getKnowledgeClient();
    try {
      const r = (await client.abort(sourceId)) as Record<string, number | boolean>;
      return {
        ok: true,
        cancelledQueued: Number(r.cancelledQueued ?? r.jobsCancelled ?? 0),
        abortedRunning: Number(r.abortedRunning ?? 0),
        runningJobs: Number(r.runningJobs ?? r.jobsRunning ?? 0),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('knowledge_http_timeout')) {
        throw new Error(
          `Knowledge Service 无响应（${msg}）；中止指令未确认。若索引卡住请重启 Gateway/Service。`,
        );
      }
      throw err;
    }
  }

  /**
   * /继续索引 ?Knowledge Service
   */
  async resumeKnowledgeJobs(sourceId?: string): Promise<{
    ok: true;
    restoredCancelled: number;
    embedQueued: number;
  }> {
    const client = await this.getKnowledgeClient();
    const r = (await client.resume(sourceId)) as Record<string, number>;
    return {
      ok: true,
      restoredCancelled: r.restoredCancelled ?? 0,
      embedQueued: r.embedQueued ?? 0,
    };
  }

  /** 索引稳定后写 generatedDescription；长任务不靠 idle 超时 */
  private async describeAfterIndexIdle(sourceId: string): Promise<void> {
    try {
      // 兜底：若已无队列量小文件）可立即描述；否则等 onSourceSettled
      await this.maybeAutoDescribe(sourceId);
    } catch {
      /* describe 失败不影响索?*/
    }
  }

  /** 索引稳定后生成 generatedDescription（Service 启发式 / LLM 由 Service 配置） */
  private async maybeAutoDescribe(sourceId: string): Promise<void> {
    await this.autoDescribeKnowledgeSource(sourceId);
  }

  async autoDescribeKnowledgeSource(sourceId: string): Promise<void> {
    const client = await this.getKnowledgeClient();
    await client.describeSource(sourceId);
  }

  /** 有可?LLM 时构?describe ；无则走?*/
  private buildKnowledgeDescribePort():
    | import('@octopi-agent/engine/harness/knowledge/describe.js').KnowledgeDescribePort
    | undefined {
    const provider = [...this.providers.values()][0];
    if (!provider) return undefined;
    return async ({ displayName, kind, location, sample }) => {
      const res = await provider.chat({
        messages: [
          {
            role: 'system',
            content:
              'Write one short purpose line for a knowledge corpus catalog. ' +
              'Say WHAT it covers and WHEN to search it (typical questions). ' +
              'Plain text only, no list markers, max 120 words.',
          },
          {
            role: 'user',
            content: `name: ${displayName}\ntype: ${kind}\nlocation: ${location}\n\nsample:\n${sample}`,
          },
        ],
        temperature: 0.2,
        maxTokens: 200,
      });
      return res.content ?? '';
    };
  }

  /**
   * 读取会话近一次七配快照（产品 Context 面板?
   *
   * 有权：Gateway Map = 产品（与 observer.level 无关终写入）?
   * ObserverHub ?observer （Run 观测?
   *
   * @param sessionId - 会话 id
   * @returns ；尚配过则为 null
   */
  getSessionContextLayers(sessionId: string): ContextLayersSnapshot | null {
    return this.lastContextLayers.get(sessionId) ?? null;
  }

  /**
   * 产品 Observer Hub（Run 观测?
   */
  getObserverHub(): ObserverHub {
    return this.observerHub;
  }

  /**
   * 会话近一?Run 观测投影
   *
   * @param sessionId - 会话 id
   * @returns RunObservatorySnapshot；无记录或面板关 null
   */
  getSessionRunObservatory(sessionId: string): RunObservatorySnapshot | null {
    return this.observerHub.getRunObservatory(sessionId);
  }

  /**
   * Run messages （摘?+ 配置时的全文?
   *
   * @param sessionId - 会话 id
   * @param options - phase / runId
   * @returns ?null
   */
  getSessionRunMessages(
    sessionId: string,
    options?: { phase?: 'entry' | 'final' | 'llm'; runId?: string; view?: 'workspace' | 'llm' },
  ): RunMessagesSnapshot | null {
    return this.observerHub.getRunMessages(sessionId, options);
  }

  /**
   * 读取 Agent 七层数据面健康（store 计数?
   *
   * 优先：已 build ?contextHealth probe
   * ：按 agent.home 直接?skills / agent.db（不依赖懒构建）
   *
   * @param agentId - Agent id
   * @returns 健康
   */
  async getAgentContextHealth(agentId: string): Promise<import('@octopi-agent/engine/harness/context/layer-health.js').ContextLayerHealth> {
    const cached = this.agentCache.get(agentId);
    if (cached?.contextHealth) {
      return cached.contextHealth(agentId);
    }
    const def = this.agents.get(agentId);
    if (def?.home) {
      const { probeAgentHomeHealth } = await import('@octopi-agent/engine/harness/context/layer-health.js');
      return probeAgentHomeHealth(agentId, def.home);
    }
    const { probeContextLayerHealth } = await import('@octopi-agent/engine/harness/context/layer-health.js');
    return probeContextLayerHealth({ agentId, personaLoaded: false });
  }

  /**
   * 产品 Context 面板终写?Map（与 observer.level 无关?
   *
   * Observer Hub 采样?**Runner.emitObserved**（以?Builder ContextEngine emit 回调）；
   * Gateway ****?`hub.ingestEvent`，否?timeline/lifecycle 会双?
   */
  private rememberContextLayers(sessionId: string, event: AgentEvent): void {
    const data = event.data as
      | {
          manifest?: AssembleManifest;
          enabledLayerIds?: ContextLayerId[];
          query?: string;
          assembledAt?: number;
          fallback?: boolean;
          fallbackError?: string;
        }
      | undefined;
    if (!data?.manifest) return;
    if (
      !this.lastContextLayers.has(sessionId) &&
      this.lastContextLayers.size >= Gateway.MAX_CONTEXT_LAYERS_SESSIONS
    ) {
      const oldest = this.lastContextLayers.keys().next().value;
      if (oldest !== undefined) this.lastContextLayers.delete(oldest);
    }
    this.lastContextLayers.set(
      sessionId,
      buildContextLayersSnapshot({
        manifest: data.manifest,
        enabledLayerIds: data.enabledLayerIds,
        query: data.query,
        assembledAt: data.assembledAt ?? event.timestamp,
        fallback: data.fallback,
        fallbackError: data.fallbackError,
      }),
    );
  }

  async queryMemory(_options: { q: string; limit: number }): Promise<Record<string, unknown> | null> {
    return null;
  }

  listPendingApprovals(): PendingApprovalView[] {
    return Array.from(this.pendingApprovals.values());
  }

  createPendingApproval(input: { sessionId: string; agentId: string; request: PendingApprovalRequest }): PendingApprovalView {
    const view: PendingApprovalView = {
      id: randomUUID().slice(0, 8),
      sessionId: input.sessionId,
      agentId: input.agentId,
      request: input.request,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.pendingApprovals.set(view.id, view);
    return view;
  }

  resolvePendingApproval(approvalId: string, input: { action: 'approve' | 'reject'; reason?: string }): PendingApprovalView | null {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) return null;

    const now = Date.now();
    approval.status = input.action === 'approve' ? 'approved' : 'rejected';
    approval.decisionReason = input.reason;
    approval.decidedAt = now;
    approval.updatedAt = now;

    return approval;
  }

  // ================================================================
  // ask_user：pending questions（工具等待用户回答）
  // ================================================================

  listPendingQuestions(sessionId?: string): PendingQuestionView[] {
    const all = Array.from(this.pendingQuestions.values());
    return sessionId ? all.filter((q) => q.sessionId === sessionId) : all;
  }

  /**
   * ?ask_user 挂成 pending question，并等待 UI 作答?
   * ?daemon / builder 注入 AskUserCallback 使用?
   */
  askUser(input: {
    sessionId: string;
    agentId: string;
    question: string;
    options?: string[];
  }): Promise<string> {
    const id = randomUUID().slice(0, 8);
    const view: PendingQuestionView = {
      id,
      sessionId: input.sessionId,
      agentId: input.agentId,
      question: input.question,
      options: input.options,
      status: 'pending',
      createdAt: Date.now(),
    };
    // 先注?waiter 再广emitEvent ?listener?
    // ?listener 在事件里立即 resolvePendingQuestion，resolver 必须已在?
    return new Promise<string>((resolve) => {
      this.pendingQuestions.set(id, view);
      this.questionResolvers.set(id, resolve);
      this.evictOldQuestions();
      this.broadcastQuestionEvent(view);
    });
  }

  /** 用户作答：标?answered 并唤醒等待中?ask_user */
  resolvePendingQuestion(questionId: string, input: { answer: string }): PendingQuestionView | null {
    const q = this.pendingQuestions.get(questionId);
    if (!q || q.status !== 'pending') return null;

    const now = Date.now();
    q.status = 'answered';
    q.answer = input.answer;
    q.decidedAt = now;
    q.updatedAt = now;

    const resolve = this.questionResolvers.get(questionId);
    this.questionResolvers.delete(questionId);
    resolve?.(input.answer);
    this.broadcastQuestionEvent(q);
    return q;
  }

  /**
   * 会话时取消未答问题，避免工具?
   * status ?cancelled（非用户作答）；工具侧应视为 abort/error，不得当用户回答?
   */
  cancelPendingQuestions(sessionId: string): void {
    for (const [id, q] of this.pendingQuestions) {
      if (q.sessionId !== sessionId || q.status !== 'pending') continue;
      const now = Date.now();
      q.status = 'cancelled';
      q.answer = '';
      q.decidedAt = now;
      q.updatedAt = now;
      const resolve = this.questionResolvers.get(id);
      this.questionResolvers.delete(id);
      // 哨兵唤醒：工具侧识别为取消，不当作用户回?
      resolve?.(ASK_USER_CANCELLED);
      this.broadcastQuestionEvent(q);
    }
  }

  /** 已终态问题保留少量供 UI 对账，防长驻 daemon 无限增长 */
  private evictOldQuestions(): void {
    const MAX_QUESTIONS = 256;
    if (this.pendingQuestions.size <= MAX_QUESTIONS) return;
    const terminal = [...this.pendingQuestions.values()]
      .filter((q) => q.status !== 'pending')
      .sort((a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt));
    for (const q of terminal) {
      if (this.pendingQuestions.size <= MAX_QUESTIONS) break;
      this.pendingQuestions.delete(q.id);
    }
    // 情况：全?pending 也硬删最旧（ resolver，避唤醒?
    if (this.pendingQuestions.size > MAX_QUESTIONS) {
      const oldest = [...this.pendingQuestions.values()]
        .filter((q) => q.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const q of oldest) {
        if (this.pendingQuestions.size <= MAX_QUESTIONS) break;
        this.pendingQuestions.delete(q.id);
      }
    }
  }

  private broadcastQuestionEvent(question: PendingQuestionView): void {
    const event = {
      type: question.status === 'pending' ? 'ask_user.pending' : 'ask_user.resolved',
      sessionId: question.sessionId,
      timestamp: Date.now(),
      data: { question },
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(question.sessionId, event);
    }
  }

  // ================================================================
  // 核心消息处理
  // ================================================================

  async send(message: ChannelMessage): Promise<void> {
    await this.handleInboundMessage(message);
  }

  getSession(sessionId: string): SessionMeta | undefined {
    // 化的 session  store?
    return undefined;
  }

  // ================================================================
  // 内部
  // ================================================================

  private async handleInboundMessage(msg: ChannelMessage): Promise<void> {
    console.log(`[Gateway] Inbound message from ${msg.channel}:${msg.senderId} ?"${msg.content.substring(0, 50)}..."`);

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

    // 2b. 对话?/xxx 命令（Intent Ingress）：先于 dispatch?stop ?
    //  user/skill 命令载（径兜底；start() 载）
    await this.ensureCommandSources();
    let inboundContent = msg.content;
    {
      const view = this.buildSessionReadView(sessionKey, agent.id);
      // 尽力补全 model（异 store?
      try {
        const session = await this.store.load(sessionKey);
        const modelMeta = session?.metadata?.model as { provider?: string; model?: string } | undefined;
        if (modelMeta?.model) {
          view.model = modelMeta.provider
            ? `${modelMeta.provider}/${modelMeta.model}`
            : modelMeta.model;
        }
      } catch {
        // view.model ?
      }

      const outcome = await this.commandRouter.execute({
        content: msg.content,
        sessionId: sessionKey,
        agentId: agent.id,
        principal: { actorId: msg.senderId, actorType: 'user' },
        view,
      });

      if (outcome.kind === 'command') {
        const result = outcome.result;
        await this.applySessionOps(sessionKey, agent.id, result.sessionOps, result);
        if (result.newSessionId) {
          result.display = {
            type: 'text',
            text: `${result.display.text}\nSession: ${result.newSessionId}`,
          };
        }
        await this.appendCommandDiscourse(sessionKey, agent.id, msg.content, result.display.text, {
          status: result.status,
          command: outcome.definition?.name,
          issueId: result.issueId,
        });
        this.broadcastCommandResult(sessionKey, {
          status: result.status,
          display: result.display,
          issueId: result.issueId,
          newSessionId: result.newSessionId,
          enterLoop: result.enterLoop === true,
        });

        // prompt 展开：继 Loop
        if (result.enterLoop && result.messages?.length) {
          const joined = result.messages.map((m) => m.content).join('\n\n');
          inboundContent = joined;
        } else {
          // control / client / ：不?Loop?
          // 合成 turn.end 作终态；****?error:true（Loop 会把 UI 打回 waiting?
          this.broadcastCommandTurnEnd(
            sessionKey,
            result.display.text,
            result.display.type,
          );

          // IM 复（Telegram 等无 WS 事件流的渠道?
          const adapter = this.channels.get(msg.channel);
          if (adapter && result.display.text) {
            try {
              await adapter.send({
                channel: msg.channel,
                conversationId: msg.conversationId,
                content: result.display.text,
                replyToId: msg.id,
              });
            } catch {
              // IM 败不影响已广 command_result
            }
          }
          return;
        }
      } else {
        inboundContent = outcome.content;
      }
    }

    // 3. 获取或构?Agent + SessionAwareRunner，并注册?Runtime
    let cached = this.agentCache.get(agent.id);
    if (!cached) {
      cached = await this.buildAgent(agent);
      this.agentCache.set(agent.id, cached);
    }
    const { runner } = cached;

    //  Runtime 已注 agent ?dispatcher
    if (!this.runtime.listAgents().some((a) => a.agentId === agent.id)) {
      await this.registerRuntimeAgent(agent, runner);
    }

    // 4?. 经激主执行（模型 A）；onEvent 做流式广不变?#6?
    let finalContent = '';
    // 会话附件指针（OP-15）：metadata.attachmentIds ?Trigger.attachments
    let attachMetadata: Record<string, unknown> = {};
    const rawAttachIds = (msg.metadata as { attachmentIds?: unknown } | undefined)?.attachmentIds;
    if (Array.isArray(rawAttachIds) && rawAttachIds.length > 0) {
      try {
        const refs = await this.resolveAttachmentRefs(sessionKey, rawAttachIds);
        if (refs.length > 0) {
          attachMetadata = { attachments: refs };
        }
      } catch (attErr) {
        console.warn(
          `[Gateway] resolve attachments failed (session=${sessionKey}): ${attErr instanceof Error ? attErr.message : String(attErr)}`,
        );
      }
    }
    const dispatchResult = await dispatchChannelMessage({
      runtime: this.runtime,
      msg: {
        ...msg,
        content: inboundContent,
        metadata: { ...(msg.metadata ?? {}), ...attachMetadata },
      },
      resolveAgentId: () => agent.id,
      resolveSessionId: () => sessionKey,
      onEvent: (event) => {
        // Runner：llm_stream_delta ?yield（不?bus）；其余事件还会 emit ?gatewayBus?
        // 流式 delta + 须用 sessionKey 广播?
        // - delta 不在 bus ?
        // -  bus ?event.sessionId，匹配失败时 UI 会永远停?streaming
        if (event.type === 'llm_stream_delta') {
          this.emitEvent(event as unknown as AgentEvent);
          for (const adapter of this.streamingAdapters) {
            adapter.broadcastEvent(sessionKey, event as unknown as AgentEvent);
          }
        } else if (Gateway.isTerminalWsEvent(event.type)) {
          for (const adapter of this.streamingAdapters) {
            adapter.broadcastEvent(sessionKey, event as unknown as AgentEvent);
          }
        }
        if (event.type === 'turn.end' && event.data?.content) {
          finalContent = event.data.content as string;
        }
      },
    });

    if (dispatchResult.status === 'failed') {
      const err =
        'error' in dispatchResult
          ? dispatchResult.error
          : dispatchResult.results
              .map((r) => `${r.agentId}:${r.result.status}`)
              .join(',');
      console.error(`[Gateway] Error processing message:`, err);
      finalContent = `[Gateway Error] ${err}`;
    } else if (dispatchResult.status === 'skipped') {
      console.warn(`[Gateway] Dispatch skipped: ${dispatchResult.reason}`);
    } else {
      // 会话标题：snippet 兜底 / 信号足够时小模型摘要（异步，不阻塞回复）
      this.scheduleSessionTitleUpdate(sessionKey);
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

    // 7. ?
    const adapter = this.channels.get(msg.channel);
    if (adapter && channelReply.content) {
      await adapter.send(channelReply);
      await this.pluginManager.runAllHooks('message_sent', { ...hookCtx, reply: channelReply });
    }
  }

  private async registerRuntimeAgent(
    agent: AgentDefinition,
    runner: SessionAwareRunner,
  ): Promise<void> {
    // 仅内?persona 写入 defaults；文件式 persona ?runner ?resolver 每轮解析
    const runSystemPrompt =
      typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '';
    let contextWindow = agent.model.contextWindow;
    if (!contextWindow) {
      const provider = this.providers.get(agent.model.provider);
      contextWindow = provider?.getModelInfo(agent.model.model)?.contextWindow;
    }

    this.runtime.registerAgent({
      agentId: agent.id,
      dispatcher: new SessionRunnerDispatcher({
        runner,
        // ?agent  model 写入 defaults?
        // RunConfig.model ?*消息?*覆盖；会盖在 session.metadata.model
        runConfigDefaults: {
          agentId: agent.id,
          contextWindow,
          systemPrompt: runSystemPrompt,
        },
      }),
      resolveSession: (trigger) => trigger.sessionId ?? `${agent.id}:main`,
    });
  }

  /**
   * ?Agent 构建 Agent + SessionAwareRunner（新架构?
   */
  private async buildAgent(agent: AgentDefinition): Promise<{
    agent: import('@octopi-agent/engine/harness/run/agent/index.js').Agent;
    runner: SessionAwareRunner;
    contextEngine?: import('@octopi-agent/engine/harness/context/types.js').ContextEngine;
    contextHealth?: (agentId?: string) => Promise<import('@octopi-agent/engine/harness/context/layer-health.js').ContextLayerHealth>;
  }> {
    // 获取?provider，并解析 agent 模型（含熔断?
    const rawProvider = this.providers.get(agent.model.provider);
    if (!rawProvider) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }
    const defaultSnapshot = resolveModel({
      providerName: agent.model.provider,
      modelName: agent.model.model,
      providers: this.providers,
      explicit: {
        contextWindow: agent.model.contextWindow,
        maxOutputTokens: agent.model.maxTokens,
      },
      isOverride: false,
      wrapProvider: (p, name) => wrapProviderWithCircuitBreaker(p, this.getCircuitBreaker(name)),
    });
    if (!defaultSnapshot) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }
    const wrappedProvider: ModelProvider = defaultSnapshot.provider;

    // 如果配置?fallbackModels，构?FallbackProvider（回 provider 也包?circuit breaker?
    let finalProvider: import('@octopi-agent/core/interfaces/model-provider.js').ModelProvider = wrappedProvider;
    if (agent.model.fallbackModels && agent.model.fallbackModels.length > 0) {
      const { FallbackProvider } = await import('@octopi-agent/engine/harness/run/reliability/fallback-provider.js');
      const wrappedProviders = new Map<string, import('@octopi-agent/core/interfaces/model-provider.js').ModelProvider>();
      for (const [name, p] of this.providers) {
        wrappedProviders.set(name, wrapProviderWithCircuitBreaker(p, this.getCircuitBreaker(name)));
      }
      finalProvider = new FallbackProvider(
        wrappedProvider,
        agent.model.model,
        agent.model.fallbackModels,
        wrappedProviders,
      );
      console.log(`[Gateway] Agent "${agent.id}" fallback chain: ${[agent.model.model, ...agent.model.fallbackModels.map(f => f.model)].join(' ?')}`);
    }

    // 使用 AgentBuilder 构建；与 Runtime 同源 EventBus，Escalate/子系统事件才
    const builder = new (await import('@octopi-agent/engine/harness/agent/builder.js')).AgentBuilder()
      .model(finalProvider)
      .store(this.store)
      .workspace(agent.workspace ?? '')
      .events(this.gatewayBus);

    if (this.config.toolIsolation) {
      builder.toolIsolation(this.config.toolIsolation);
    }
    // E1/E2：同进程内所?Runner 共享?session lease；E6：注?ACL + agent 天花?
    // OP-15：会话附件只读根（file 工具?
    const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
    const { join: pathJoinForAttachments } = await import('node:path');
    builder.runnerConfig({
      sessionLease: this.sessionLease,
      sessionAcl: this.sessionAcl,
      agentMaxSessionRights: agent.maxSessionRights,
      observerHub: this.observerHub.isEnabled() ? this.observerHub : undefined,
      sessionAttachmentsBaseDir: pathJoinForAttachments(getOctopiHome(), 'sessions'),
      sessionAttachmentInject: {
        fullTextMaxChars: this.config.knowledge?.attachments?.inject?.fullTextMaxChars,
        intent: this.config.knowledge?.attachments?.inject?.intent,
        intentTimeoutMs: this.config.knowledge?.attachments?.inject?.intentTimeoutMs,
        emptyMessagePrompt: this.config.knowledge?.attachments?.inject?.emptyMessagePrompt,
      },
    });

    //  七层数据源：skills / memory / wisdom / cognition / knowledge / assembler 
    // ?config-bridge 同构，保?serve  Web「上下文」能看到真实层数?
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const skillDir =
      agent.skillDirectory ?? (agent.home ? join(agent.home, 'skills') : undefined);
    if (skillDir && existsSync(skillDir)) {
      try {
        const { DefaultSkillManager } = await import('@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/manager.js');
        const skillManager = new DefaultSkillManager();
        await skillManager.discover(skillDir);
        builder.skills(skillManager);
        this.registerSkillCommands(skillManager);
      } catch (err) {
        console.warn(`[Gateway] skill discover failed for agent "${agent.id}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (agent.home) {
      try {
        this.registerUserCommands(agent.id, join(agent.home, 'commands'));
      } catch (err) {
        console.warn(`[Gateway] user command load failed for agent "${agent.id}": ${err instanceof Error ? err.message : String(err)}`);
      }
      builder.agentHome(agent.home);
      builder.agentId(agent.id);
      try {
        const { AgentDatabase } = await import('@octopi-agent/engine/harness/memory/sqlite/agent-db.js');
        const { SqliteMemoryStore } = await import('@octopi-agent/engine/harness/memory/sqlite/memory-store.js');
        const { SqliteWisdomStore } = await import('@octopi-agent/engine/harness/memory/sqlite/wisdom-store.js');
        const { SqliteConceptGraph } = await import('@octopi-agent/engine/harness/memory/sqlite/cognition-store.js');
        const { resolveEmbeddingRuntime } = await import('@octopi-agent/engine/harness/memory/sqlite/embedding-from-models.js');

        const embRuntime = resolveEmbeddingRuntime({
          providers: this.config.modelProviders ?? {},
          embedding: this.config.embedding,
        });
        const useVec = embRuntime && embRuntime.vectorEngine !== 'js';
        const db = await AgentDatabase.create({
          dbPath: join(agent.home, 'agent.db'),
          sqliteVec: useVec
            ? { extensionPath: embRuntime?.sqliteVecExtensionPath }
            : false,
          vectorDimensions: useVec ? embRuntime?.dimensions : undefined,
        });
        builder.memoryStore(
          new SqliteMemoryStore(db, {
            embeddingProvider: embRuntime?.provider ?? null,
            vectorEngine: embRuntime?.vectorEngine ?? 'auto',
            minSimilarity: this.config.memory?.retrieval?.minSimilarity,
            similarityWeight: this.config.memory?.retrieval?.similarityWeight,
            minKeywordScore: this.config.memory?.retrieval?.minKeywordScore,
          }),
        );
        builder.wisdomStore(new SqliteWisdomStore(db));
        builder.cognitionStore(new SqliteConceptGraph(db, {
          embeddingProvider: embRuntime?.provider ?? null,
        }));
        // Knowledge catalog → Knowledge Service（不得再写死 []）
        try {
          const agentIdForCatalog = agent.id;
          const kn = this.config.knowledge;
          const catalogMax = kn?.catalog?.maxEntries;
          const catalogGroup = kn?.catalog?.groupByScope;
          const catalogProgress = kn?.catalog?.showProgress;
          builder.knowledgeCatalog(
            async () => {
              try {
                const client = await this.getKnowledgeClient();
                const items = await client.catalog(agentIdForCatalog);
                return items as import('@octopi-agent/engine/harness/knowledge/catalog-types.js').KnowledgeCatalogItem[];
              } catch {
                return [];
              }
            },
            {
              maxEntries: catalogMax,
              groupByScope: catalogGroup,
              showProgress: catalogProgress,
            },
          );
        } catch (kErr) {
          console.warn(
            `[Gateway] knowledge catalog unavailable: ${kErr instanceof Error ? kErr.message : String(kErr)}`,
          );
        }
        if (embRuntime?.provider) {
          console.log(
            `[Gateway] memory embedding enabled: model=${embRuntime.model} vectorEngine=${embRuntime.vectorEngine}`,
          );
        } else {
          console.log('[Gateway] memory embedding not configured ?keyword retrieval');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Gateway] context stores unavailable for agent "${agent.id}": ${msg}`);
        if (/node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|ERR_DLOPEN|NODE_MODULE_VERSION/i.test(msg)) {
          console.warn(
            `[Gateway] hint: SQLite backend requires Node.js >= 24 with built-in node:sqlite (process.version=${process.version}). Memory tools will be skipped until the runtime is upgraded.`,
          );
        }
      }
    }
    if (this.config.context?.contextAssembler ?? this.config.contextAssembler) {
      builder.contextAssembler(this.config.context?.contextAssembler ?? this.config.contextAssembler!);
    }
    if (this.config.context?.constitution ?? this.config.constitution) {
      builder.constitution(this.config.context?.constitution ?? this.config.constitution ?? null);
    }

    // 注册工具（跳?memory_*：由 AgentBuilder  agent ?memoryStore 创建，保证与 MemoryLayer 同实例）
    console.log(`[Gateway] Building agent "${agent.id}" with ${this.tools.length} global tools: ${this.tools.map(t => t.definition.name).join(', ')}`);
    for (const tool of this.tools) {
      const name = tool.definition.name;
      if (name === 'memory_store' || name === 'memory_search') continue;
      builder.tool(tool);
    }

    // Knowledge 工具?Knowledge Service Client（v2?
    try {
      const rt = await this.getKnowledgeRuntime();
      if (rt.state === 'disabled') {
        console.log('[Gateway] knowledge tools skipped: knowledge.service disabled');
      } else {
        const kclient = await this.getKnowledgeClient();
        const { createKnowledgeClientTools } = await import(
          '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/knowledge.js'
        );
        for (const tool of createKnowledgeClientTools({ client: kclient })) {
          builder.tool(tool);
        }
        console.log('[Gateway] knowledge tools via service: knowledge_search, knowledge_read');

        // turn 级 auto-ground（recall=off 则不装）
        const recall =
          (agent as { knowledge?: { recall?: string } }).knowledge?.recall ??
          this.config.knowledge?.recall ??
          'hybrid';
        if (recall !== 'off') {
          const { ClientKnowledgeGrounding } = await import(
            '@octopi-agent/engine/harness/knowledge/client.js'
          );
          const g = this.config.knowledge?.autoInject;
          const q = this.config.knowledge?.query;
          builder.knowledgeGrounding(
            new ClientKnowledgeGrounding(
              kclient,
              recall as 'hint' | 'hybrid' | 'inject',
            ),
            {
              ...(g?.budgetTokens != null ? { budgetTokens: g.budgetTokens } : {}),
              ...(g?.budgetRatio != null ? { budgetRatio: g.budgetRatio } : {}),
              ...(g?.maxBudgetTokens != null ? { maxBudgetTokens: g.maxBudgetTokens } : {}),
              ...(g?.maxChunks != null ? { maxChunks: g.maxChunks } : {}),
              ...(q?.skipIfUserTokensBelow != null
                ? { skipIfUserTokensBelow: q.skipIfUserTokensBelow }
                : {}),
              ...(q?.includePriorUserTurns != null
                ? { includePriorUserTurns: q.includePriorUserTurns }
                : {}),
            },
          );
          console.log(`[Gateway] knowledge grounding via service (recall=${recall})`);
        }
      }
    } catch (kToolErr) {
      console.warn(
        `[Gateway] knowledge tools skipped: ${kToolErr instanceof Error ? kToolErr.message : String(kToolErr)}`,
      );
    }

    // 设置 systemPrompt：内?persona 固定烤入；文件式 persona ?builder.persona（run 时热更新?
    if (typeof agent.persona === 'object' && agent.persona?.systemPrompt) {
      builder.systemPrompt(agent.persona.systemPrompt);
    } else if (agent.home) {
      builder.persona(agent.home);
    }

    // 策略
    builder.errorStrategy({
      onModelError: (error, attempt) => {
        const retryable = ['rate_limit', 'timeout', 'network', 'server'];
        if (retryable.includes(error.reason) && attempt < 3) {
          const delayMs = (attempt + 1) * (error.reason === 'rate_limit' ? 1000 : 2000);
          return { action: 'retry', delayMs };
        }
        return { action: 'abort', reason: error.message };
      },
      onToolError: () => ({ action: 'skip', reason: 'Tool failed' }),
      onContextOverflow: () => ({ action: 'compact' }),
      onSecurityViolation: (v) => ({ action: 'block', reason: v.description }),
    });

    // high 风险人工：接?ask_user UI（有交互则确认，无人值守 fail-safe 拒绝?
    builder.confirmHighRisk(async (req) => {
      const sessionId = req.sessionId ?? 'unknown';
      const agentId = req.agentId ?? 'default';
      const toolName = req.toolCall?.name ?? 'tool';
      const argsPreview = JSON.stringify(req.toolCall?.arguments ?? {}).slice(0, 200);
      try {
        const answer = await this.askUser({
          sessionId,
          agentId,
          question:
            `High-risk tool requires confirmation.\n` +
            `Tool: ${toolName}\nArgs: ${argsPreview}\nRisk: ${req.reason}\n\n` +
            `Allow this call?`,
          options: ['yes', 'no'],
        });
        return answer.trim().toLowerCase() === 'yes' || answer.trim().toLowerCase() === 'y';
      } catch {
        return false;
      }
    });

    // 构建（builder.observerHub 已注入；setObserverHub ?runnerConfig 传入的路径）
    builder.observerHub(this.observerHub.isEnabled() ? this.observerHub : undefined);
    const built = await builder.build();
    built.runner.setObserverHub(this.observerHub.isEnabled() ? this.observerHub : undefined);
    const agentToolNames = built.agent.context.tools
      ?.map((t: any) => t?.definition?.name ?? t?.name)
      .filter(Boolean) ?? [];
    const hasMemoryTools = agentToolNames.includes('memory_store') && agentToolNames.includes('memory_search');
    console.log(
      `[Gateway] Agent "${agent.id}" tools: ${agentToolNames.join(', ') || '(none)'}` +
        (hasMemoryTools ? ' [memory_store/search OK]' : ' [memory_store/search MISSING]'),
    );

    //  Run 级模型快照解析（ B 入口）─
    // ?run 调一次；provider 缺失返回 null，Runner  Agent 实例
    const wrap = (p: ModelProvider, providerName: string) =>
      wrapProviderWithCircuitBreaker(p, this.getCircuitBreaker(providerName));

    built.runner.setModelResolver(({ modelRef, defaultProvider }) => {
      const agentDef = this.agents.get(agent.id) ?? agent;
      if (!modelRef) {
        return resolveModel({
          providerName: agentDef.model.provider,
          modelName: agentDef.model.model,
          providers: this.providers,
          explicit: {
            contextWindow: agentDef.model.contextWindow,
            maxOutputTokens: agentDef.model.maxTokens,
          },
          isOverride: false,
          wrapProvider: wrap,
        });
      }
      return resolveModelRef(modelRef, {
        providers: this.providers,
        defaultProvider: defaultProvider ?? agentDef.model.provider,
        isOverride: true,
        wrapProvider: wrap,
      });
    });

    // 会话任务事件 ?WebSocket（UI 实时面板?
    const forwardTaskEvent = (event: { sessionId?: string; type: string; data?: unknown }) => {
      if (!event.sessionId) return;
      for (const adapter of this.streamingAdapters) {
        adapter.broadcastEvent(event.sessionId, event as any);
      }
    };
    for (const type of ['session.task.created', 'session.task.updated', 'session.task.snapshot']) {
      built.events.on(type, forwardTaskEvent);
    }

    return { agent: built.agent, runner: built.runner, contextEngine: built.contextEngine, contextHealth: built.contextHealth };
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
    // Fallback: use first registered agent
    const fallback = this.agents.values().next().value;
    if (fallback) console.warn(`[Gateway] No channel binding match for ${msg.channel}:${msg.senderId}, falling back to agent "${fallback.id}"`);
    return fallback;
  }

  private buildSessionKey(agent: AgentDefinition, msg: ChannelMessage): string {
    // 使用消息 agentId Gateway 解析后的 agent.id?
    // 这样 sessionKey ?WS session ?agentId 致，broadcastEvent ?
    const agentId = (msg.metadata?.agentId as string) ?? agent.id;

    // 优先使用客户来的 sessionId（WebUI 通过 REST API 创建?session?
    const clientSessionId = msg.metadata?.sessionId as string | undefined;
    if (clientSessionId) {
      return clientSessionId;
    }

    switch (this.dmScope) {
      case 'per-peer':
        return `${agentId}:${msg.senderId}`;
      case 'per-channel-peer':
        return `${agentId}:${msg.channel}:${msg.senderId}`;
      default:
        return `${agentId}:main`;
    }
  }

  private static isTerminalWsEvent(type: string): boolean {
    return (
      type === 'turn.end' ||
      type === 'engine.end' ||
      type === 'engine.error' ||
      type === 'aborted' ||
      type === 'interrupted' ||
      type === 'command.result'
    );
  }

  private emitEvent(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener 不应流程
      }
    }
  }

  /**
   * 获取或创?provider 熔断?
   */
  private getCircuitBreaker(providerName: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(providerName);
    if (!cb) {
      cb = new CircuitBreaker({
        failureThreshold: 5,
        recoveryTimeoutMs: 30_000,
        name: providerName,
      });
      this.circuitBreakers.set(providerName, cb);
    }
    return cb;
  }

  /**
   * 获取有熔?
   */
  getCircuitBreakerStatus(): Record<string, { state: string; failureCount: number }> {
    const result: Record<string, { state: string; failureCount: number }> = {};
    for (const [name, cb] of this.circuitBreakers) {
      result[name] = cb.snapshot();
    }
    return result;
  }

  /**
   * 解析 trace 日志级别串为数字
   */
  private parseTraceLevel(level: string): number {
    const levels: Record<string, number> = {
      'ERROR': 1, 'WARN': 2, 'INFO': 3, 'DEBUG': 4, 'TRACE': 5,
    };
    return levels[level.toUpperCase()] ?? 3;
  }
}

/**
 * WS 广播前剥?context.layers.assembled 里的?content
 *
 * Gateway 缓存/REST 仍保留全文；UI 时经 REST 拉取?
 * preview 保留?WS，便于未?
 */
function stripLayerContentFromEvent(event: AgentEvent): AgentEvent {
  const data = event.data as
    | { manifest?: AssembleManifest; [k: string]: unknown }
    | undefined;
  if (!data?.manifest?.layers) return event;
  return {
    ...event,
    data: {
      ...data,
      manifest: {
        ...data.manifest,
        layers: data.manifest.layers.map(({ content: _content, ...rest }) => rest),
      },
    },
  } as AgentEvent;
}
