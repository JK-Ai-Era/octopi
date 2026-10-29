/**
 * Gateway — 核心守护进程
 *
 * 三层架构 Integration 层组件。
 * 职责：组装 Agent + 挂载协议适配器 + 管理生命周期。
 *
 * 架构：
 *   外部消息 → Channel Adapter → Gateway → SessionAwareRunner → Agent → LLM
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

import type { RegisteredTool, SessionMeta } from '@octopi-agent/core/types.js';
import { readTitleState } from '@octopi-agent/core/types/session.js';
import type { AgentDefinition, ModelConfig } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { ChannelAdapter, ChannelMessage, ChannelReply } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';
import type { GitStatusSnapshot } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-status-snapshot.js';
import type { EffectPolicyConfig, ProcessIsolationProfile } from '@octopi-agent/engine';
import { expandHomePath } from '@octopi-agent/engine/paths.js';
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
import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CircuitBreaker } from '@octopi-agent/engine/harness/run/reliability/circuit-breaker.js';
import { isTurnStartContent } from '@octopi-agent/engine/harness/context/turn-envelope.js';
import { isTurnAnchor } from '@octopi-agent/engine/harness/context/layer-types.js';
import { wrapProviderWithCircuitBreaker } from '@octopi-agent/engine/harness/run/reliability/provider-wrapper.js';
import { resolveModel, resolveModelRef, resolveCatalogEntry, parseModelRef } from '@octopi-agent/engine/harness/run/model/index.js';
import { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager.js';
import {
  ClientToolRegistry,
  ClientStreamTransport,
  type ClientStreamChannel,
  type ClientStreamSampleInput,
  type ClientToolCall,
  type ClientToolCallId,
  type ClientToolCallOutcome,
  type ClientToolDescriptor,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';
import { ClientToolHost } from './client-tools-host.js';
import { FileReleaseService, type FileReleaseIndexEntry } from './file-release.js';
import { getOctopiHome } from '@octopi-agent/engine/paths.js';
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
import { getRunScope } from '@octopi-agent/engine/harness/run/run-scope.js';
import {
  buildToolLlmParameters,
  prepareHandlerArgs,
  resolveToolCallPurpose,
} from '@octopi-agent/engine/harness/agent/tool-purpose.js';
import { AgentRuntime, SessionRunnerDispatcher, ExplicitRouter } from '@octopi-agent/engine/harness/activation/index.js';
import { dispatchChannelMessage } from '@octopi-agent/engine/integration/agent-runtime/channel-message-source.js';
import { SessionAclService } from '@octopi-agent/engine/harness/governance/session-acl/service.js';
import type { HitlDecision } from '@octopi-agent/core/types/tools.js';
import { defaultHitlCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import { InProcessSessionLock } from '@octopi-agent/engine/harness/run/concurrency/session-lease.js';
import { ObserverHub } from '@octopi-agent/engine/harness/observability/observer/hub.js';
import type {
  RunMessagesSnapshot,
  RunObservatorySnapshot,
} from '@octopi-agent/engine/harness/observability/observer/types.js';

// Web REST 骨架所需的 Gateway 扩展类型
// ================================================================

/** Pending approval 请求载荷（SEC-7 单模型） */
export interface PendingApprovalRequest {
  id: string;
  /** high_risk 工具确认 | host-gate 效应确认 */
  kind: 'high_risk' | 'effect';
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  riskDescription: string;
  actionDescription: string;
}

/** 审批作用域（映射 HitlDecision） */
export type ApprovalScope = 'once' | 'session' | 'always';

/** Pending approval 视图 */
export interface PendingApprovalView {
  id: string;
  sessionId: string;
  agentId: string;
  request: PendingApprovalRequest;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  /** 引擎确认窗截止时刻（与 ops 审计 confirm_timeout 同一时刻口径；迟到点击记 rejected/late，不补记 approved） */
  deadlineAt?: number;
  updatedAt?: number;
  decidedAt?: number;
  decisionReason?: string;
  decisionScope?: ApprovalScope;
  /** ops P5：谁批的（宿主归因；未知缺省，不编造） */
  decidedBy?: string;
  /** ops P5：经哪条通道（gateway 事件 | webhook 回执） */
  decisionChannel?: 'gateway' | 'webhook';
}

/** ask_user 待答问题视图 */
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
 * cancel 时回给等待方的哨兵值。
 * 工具侧识别后抛 abort 错误，不得把空串当用户回答。
 */
export const ASK_USER_CANCELLED = '__ask_user_cancelled__';

/** Normalized risk level for approval display (unknown severity → high, fail-safe) */
function normalizeRiskLevel(
  severity: string | undefined,
): PendingApprovalRequest['riskLevel'] {
  switch (severity) {
    case 'low':
    case 'medium':
    case 'high':
    case 'critical':
    case 'unknown':
      return severity;
    default:
      return 'high';
  }
}

/** RegisteredTool → AgentTool（热更新已 build Agent 的 client tool） */
/**
 * 将 RegisteredTool 转换为 Loop AgentTool（与 builder.convertToAgentTool、think.buildAgentTools 同构）。
 * 导出供测试覆盖三处映射的 executionMode 透传一致性。
 */
export function registeredToolToAgentTool(tool: RegisteredTool): {
  name: string;
  description: string;
  executionMode?: 'parallel' | 'sequential';
  parameters?: Record<string, unknown>;
  execute: (
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: (partial: { content?: unknown }) => void,
  ) => Promise<{
    toolCallId: string;
    name: string;
    content: unknown;
    isError?: boolean;
    durationMs?: number;
    purpose?: string;
  }>;
} {
  return {
    name: tool.definition.name,
    description: tool.definition.description,
    // 与 convertToAgentTool 同构：purpose 统一装配（arch/tool-call-purpose.md）
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    parameters: buildToolLlmParameters(tool.definition.parameters),
    execute: async (toolCallId, args, signal, onUpdate) => {
      const startTime = Date.now();
      try {
        const rawArgs = (args ?? {}) as Record<string, unknown>;
        // schema 已 required purpose；模型漏填时推导，不中断调用
        const purpose = resolveToolCallPurpose(tool.definition.name, rawArgs);
        const handlerArgs = prepareHandlerArgs(rawArgs, tool.definition);
        const scope = getRunScope();
        const result = await tool.handler(handlerArgs, {
          sessionId: scope?.sessionId ?? 'unknown',
          agentId: scope?.agentId ?? 'unknown',
          messages: scope?.toolRuntime?.messages ?? [],
          abortSignal: signal,
          // 工具部分输出通道（展示用途）；无转发器时不给工具假通道
          ...(onUpdate ? { onUpdate } : {}),
          fileEffects:
            scope?.toolRuntime?.fileEffects
            ?? (await import('@octopi-agent/engine')).createUnconfiguredFileEffects(),
          memoryEffects:
            scope?.toolRuntime?.memoryEffects
            ?? (await import('@octopi-agent/engine')).createUnconfiguredMemoryEffects(),
        });
        return {
          toolCallId,
          name: tool.definition.name,
          content: result,
          purpose,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          toolCallId,
          name: tool.definition.name,
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          durationMs: Date.now() - startTime,
        };
      }
    },
  };
}

/** WebUI 模型目录条目（与 harness/run/model ModelCatalogEntry 对齐） */
export interface ModelCatalogItem {
  id: string;
  provider: string;
  model: string;
  /** 未配置时为 null（未知，不猜测） */
  contextWindow: number | null;
  maxOutputTokens?: number;
  known: boolean;
  source: string;
}

/** Agent 默认模型摘要 */
export interface AgentModelSummary {
  agentId: string;
  /** agent 配置的默认模型 id（`provider/model`） */
  defaultModelId: string;
}

/** WebUI 模型目录 */
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
  /** 当前生效模型 id；null 表示沿用 agent 默认 */
  modelId: string | null;
  defaultModelId: string;
  /** 当前生效模型的能力快照（UI 只读，禁止再猜窗口） */
  resolved?: ModelCatalogItem;
}

// ================================================================
// 默认 Session Store（OCTOPI_HOME/sessions）
// ================================================================

/**
 * 无显式 store 时，在 OCTOPI_HOME/sessions 创建持久化 JSONL store。
 * 禁止改回 SqliteSessionStore（已删除；见 arch/session-history-search.md）。
 */
async function createDefaultStore(_agents: AgentDefinition[]): Promise<SessionStore<SessionData>> {
  const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
  const { join } = await import('node:path');
  const { JsonlSessionStore } = await import('@octopi-agent/engine/integration/storage/jsonl.js');
  return new JsonlSessionStore({
    sessionsDir: join(getOctopiHome(), 'sessions'),
  });
}

/**
 * git-status 读缓存 TTL（毫秒，单调时钟）：短窗去重，多标签页/多客户端不重复
 * spawn git。资源护栏按代码常量管理（同 sandbox 16MB 上限、工具 8k 输出门先例）。
 *
 * 刻意不做成配置项：TTL 只在「多客户端/多标签页同键并发」时有意义，单客户端
 * 下前端 `inFlightRef` 自互斥已足够；且 `web.gitStatusPollSeconds` 是**客户端轮询**
 * 参数（CLI 读后写进 /octopi-config.js），Gateway 进程不读 `web` 段——真要开放
 * 得新开网关侧配置面，为三个调不动的护栏常量付这个价不划算。
 */
const GIT_STATUS_CACHE_TTL_MS = 1_000;

/** git-status 并发上限（不同键的并发）：超出报 `git_status_busy`（429） */
const GIT_STATUS_MAX_CONCURRENCY = 4;

/** git-status 读缓存条目上限（超出淘汰最旧） */
const GIT_STATUS_CACHE_MAX_ENTRIES = 256;

/**
 * 并发闸门：上限内发放一次性归还句柄，超出返回 null。
 *
 * @param max - 同时在飞的最大数量（必须为正整数）
 * @returns tryAcquire 发放归还句柄（null=满）；句柄幂等，重复调用只归还一次
 */
export function createConcurrencyGate(max: number): {
  tryAcquire: () => (() => void) | null;
} {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`gate_invalid: max must be a positive integer (got ${String(max)})`);
  }
  let active = 0;
  return {
    tryAcquire: () => {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}

export class Gateway {
  /** 已注册的 Agent */
  private agents = new Map<string, AgentDefinition>();
  /** git-status 读缓存（key 含路径+隔离签名+maxEntries；单调时钟 TTL，超限淘汰最旧） */
  private gitStatusCache = new Map<
    string,
    { expiresAtMono: number; payload: GitStatusSnapshot & { path: string } }
  >();
  /** git-status 单飞表：同键并发共享同一次读（缓存 miss 不各自 spawn git） */
  private gitStatusInflight = new Map<
    string,
    Promise<GitStatusSnapshot & { path: string }>
  >();
  /** git-status 并发闸门（约束不同键的并发） */
  private gitStatusGate = createConcurrencyGate(GIT_STATUS_MAX_CONCURRENCY);
  /** 已注册的 Channel Adapter */
  private channels = new Map<string, ChannelAdapter>();
  /** Plugin Manager */
  private pluginManager: PluginManager;
  /** 插件发现幂等位：PluginLoader 不去重，重复 discover 会双注册 hooks/命令 */
  private pluginsDiscovered = false;
  /** Session Store */
  private store!: SessionStore<SessionData>;
  /** Gateway 配置 */
  private config: GatewayConfig;
  /** DM 作用域 */
  private dmScope: string;
  /** 是否已启动 */
  private started = false;
  /** 事件监听器 */
  private listeners: Array<(event: AgentEvent) => void> = [];
  /** Provider */
  private providers = new Map<string, ModelProvider>();
  /** 工具 */
  private tools: RegisteredTool[] = [];
  /** 每 agent 记忆逆放器（L3 P2） */
  private memoryRestorers = new Map<string, import('@octopi-agent/engine').MemoryEffectRestorer>();
  /** 委派编排运行时（arch/delegation.md）惰性创建 */
  private delegationRuntime?: import('@octopi-agent/engine/harness/collaboration/delegation/wiring.js').DelegationRuntime;
  /** ensureDelegationRuntime 首建合流（防并发双建；仅缓存成功创建的 runtime） */
  private delegationRuntimePromise?: Promise<
    import('@octopi-agent/engine/harness/collaboration/delegation/wiring.js').DelegationRuntime | undefined
  >;
  /** 委派未启用诊断日志只打一次 */
  private delegationSkippedLogged = false;
  /** Agent 缓存（避免每条消息重建） */
  private agentCache = new Map<string, {
    agent: import('@octopi-agent/engine/harness/run/agent/index.js').Agent;
    runner: SessionAwareRunner;
    contextEngine?: import('@octopi-agent/engine/harness/context/types.js').ContextEngine;
    contextHealth?: (agentId?: string) => Promise<import('@octopi-agent/engine/harness/context/layer-health.js').ContextLayerHealth>;
  }>();
  /**
   * 热失效退役的 runner（arch/config-hot-reload.md §3：新 run 生效，在跑 run 跑完）。
   * dispose 判据 = in-flight run 计数归零（dispatcher 包装跟踪）；长尾 30min 强制兜底（warn）。
   */
  private retiredRunners: SessionAwareRunner[] = [];
  /** runner → in-flight run 计数（dispatcher 包装维护；退役 dispose 判据） */
  private runnerInflight = new WeakMap<SessionAwareRunner, number>();
  /** 流式 adapter 引用（用于广播事件） */
  private streamingAdapters: StreamingChannelAdapter[] = [];
  /** RUN_EVENT 已广播的 Loop 事件对象（总线原始副本去重，防双投） */
  private readonly wrappedRunEvents = new WeakSet<object>();
  /** 每个 provider 的熔断器 */
  private circuitBreakers = new Map<string, CircuitBreaker>();
  /** 默认 store 的异步初始化 Promise（未传入 store 时） */
  private _defaultStorePromise?: Promise<SessionStore<SessionData>>;
  /** Web Runtime pending approvals（confirmHighRisk / confirmEffect） */
  private pendingApprovals = new Map<string, PendingApprovalView>();
  private approvalResolvers = new Map<
    string,
    (decision: HitlDecision | import('@octopi-agent/core/types/tools.js').ConfirmOutcome) => void
  >();
  /** ask_user 待答（UI 答完 resolve 等待工具） */
  private pendingQuestions = new Map<string, PendingQuestionView>();
  private questionResolvers = new Map<string, (answer: string) => void>();
  /** Client Tool（客户端能力 → tool 面）*/
  private clientToolRegistry = new ClientToolRegistry();
  private clientStreamTransport!: ClientStreamTransport;
  private clientTools!: ClientToolHost;
  private fileReleases!: FileReleaseService;
  private sessionMetaQueues = new Map<string, Promise<void>>();
  /** 会话最近一次七层装配快照（含 content，仅 REST）；FIFO 防泄漏 */
  private lastContextLayers = new Map<string, ContextLayersSnapshot>();
  private static readonly MAX_CONTEXT_LAYERS_SESSIONS = 256;
  /** 产品 Observer 通道（Run 现场） */
  private observerHub: ObserverHub;
  /** models.level — 供 WebUI 模型目录展示分级名 */
  private modelLevels?: Record<string, { primary: string; fallback?: string[] }>;
  /** 激活宿主（arch/agent-runtime.md）；消息路径经 dispatch */
  private runtime: AgentRuntime;
  private gatewayBus: DefaultEventBus;
  /** AgentSignalSource 已挂到 AgentRuntime（委派 notify 推送的接收端） */
  private agentSignalMounted = false;
  /** ensureAgentSignalSource in-flight 合流（成功后置 mounted；失败清缓存留重试口） */
  private agentSignalSourcePromise?: Promise<void>;
  /** agentRuntime.agentSignal === false：显式关闭推送（委派退化为 poll + 状态提示） */
  private agentSignalPushDisabled = false;
  /** Session ACL（E6）；缺省内置五角色 */
  private sessionAcl: SessionAclService;
  /** 进程内共享 Session Lease（E1/E2）：所有 Runner 注入同一实例 */
  private sessionLease: import('@octopi-agent/engine/harness/run/concurrency/session-lease.js').InProcessSessionLock;
  /** 会话日程（arch/session-schedules.md）；进程级单例 + schedules.db */
  private sessionSchedules?: import('@octopi-agent/engine/harness/session/schedules/service.js').SessionScheduleService;
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
  /** 产品问题面 */
  private issueRegistry: IssueRegistry;
  /** 会话内 /xxx 命令调用面 */
  private commandRouter: CommandRouter;
  /** user/skill 命令是否已装载（启动时装载，不依赖 buildAgent） */
  private commandSourcesReady = false;

  constructor(config: GatewayConfig, store?: SessionStore<SessionData>) {
    this.config = config;
    this.dmScope = config.session?.dmScope ?? 'main';
    this.pluginManager = new PluginManager(
      config.plugins?.loadPaths ? { loadPaths: config.plugins.loadPaths } : undefined,
    );
    this.sessionAcl = new SessionAclService(config.sessionAcl);
    this.sessionLease = new InProcessSessionLock();
    this.issueRegistry = new IssueRegistry();
    this.commandRouter = this.createCommandRouter();
    this.clientStreamTransport = new ClientStreamTransport({
      emitEvent: (event) => {
        const agentId = (event as { agentId?: string }).agentId;
        const ev = {
          type: event.type,
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          ...(agentId ? { agentId } : {}),
          data: event.data,
        } as unknown as AgentEvent;
        this.emitEvent(ev);
        for (const adapter of this.streamingAdapters) {
          adapter.broadcastEvent(event.sessionId, ev, agentId);
        }
      },
    });
    this.fileReleases = new FileReleaseService({
      auditDir: join(getOctopiHome(), 'audit'),
      maxBytes: config.fileSend?.maxBytes,
      maxReleasesPerSession: config.fileSend?.maxReleasesPerSession,
      persistIndex: async (sessionId, entries) => {
        await this.patchSessionMetadata(sessionId, (meta) => {
          meta.fileReleases = entries;
        });
      },
      loadIndex: async (sessionId) => {
        await this.ensureStore();
        const session = await this.store.load(sessionId);
        const raw = session?.metadata?.fileReleases;
        return Array.isArray(raw) ? (raw as FileReleaseIndexEntry[]) : [];
      },
    });
    this.clientTools = new ClientToolHost({
      registry: this.clientToolRegistry,
      streamTransport: this.clientStreamTransport,
      registerGlobalTool: (tool) => {
        this.tools.push(tool);
      },
      unregisterGlobalTool: (name) => {
        this.tools = this.tools.filter((t) => t.definition.name !== name);
      },
      syncAgentTools: (ops) => this.syncClientToolsToAgents(ops),
      providerLiveTtlMs: 90_000,
      persistCall: (call) => this.persistClientToolCall(call),
      releaseFile: async (input) => {
        const agent = this.agents.get(input.agentId);
        const { resolve: pathResolve } = await import('node:path');
        const { getOctopiHome: homeFn, expandHomePath } = await import('@octopi-agent/engine/paths.js');
        const { resolveSessionAttachmentsPaths } = await import(
          '@octopi-agent/engine/harness/session/attachments/paths.js'
        );
        const workspace = agent?.workspace?.trim()
          ? pathResolve(expandHomePath(agent.workspace.trim()))
          : undefined;
        const sessionSubdir = workspace ? pathResolve(workspace, input.sessionId) : undefined;
        const sessionsDir = pathResolve(homeFn(), 'sessions');
        const attachmentsRoot = resolveSessionAttachmentsPaths(sessionsDir, input.sessionId).root;
        const allowedRoots = [workspace, sessionSubdir, pathResolve(attachmentsRoot)].filter(
          (r): r is string => Boolean(r),
        );
        const resolveBases = [sessionSubdir, workspace, pathResolve(attachmentsRoot)].filter(
          (r): r is string => Boolean(r),
        );
        const result = await this.fileReleases.release({
          sessionId: input.sessionId,
          agentId: input.agentId,
          runId: input.runId,
          toolName: input.toolName,
          toolCallId: input.toolCallId,
          path: input.path,
          name: input.name,
          purpose: input.purpose,
          clientInstanceId: input.clientInstanceId,
          allowedRoots,
          resolveBases,
        });
        return result.fileRef;
      },
      saveHtmlAsset: async (input) => {
        const svc = await this.getAttachmentService();
        const att = await svc.save(input.sessionId, {
          name: input.name,
          mime: 'text/html',
          data: Buffer.from(input.html, 'utf8'),
        });
        return {
          assetId: att.id,
          mime: att.mime || 'text/html',
          sizeBytes: att.sizeBytes ?? Buffer.byteLength(input.html, 'utf8'),
        };
      },
      emitSessionEvent: (sessionId, event) => {
        const ev = event as unknown as AgentEvent;
        this.emitEvent(ev);
        for (const adapter of this.streamingAdapters) {
          adapter.broadcastEvent(sessionId, ev, event.agentId);
        }
      },
    });
    // Gateway EventBus：RuntimeEvents 进可观测总线，并转发到 Gateway listeners（不变量 #6）
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
      // Observer 通道：Runner 在 emit 时直采 Hub（避免与 bus 双计 timeline/lifecycle）
      // Gateway 只保留产品 Context Map；不再二次 ingestEvent
      // Runtime 的统一 run-event 是所有 Trigger（含后台续跑）的唯一 WS 扇出口。
      // 内部 EventBus 不再承担流式/终态的客户端广播，避免两套可见性契约。
      if (event.type === 'runtime.run.event' && event.sessionId) {
        const runEvent = (event.data as { event?: AgentEvent } | undefined)?.event;
        if (runEvent) {
          this.wrappedRunEvents.add(runEvent);
          for (const adapter of this.streamingAdapters) {
            adapter.broadcastEvent(event.sessionId, runEvent, runEvent.agentId ?? event.agentId);
          }
        }
        return;
      }
      // Loop 事件在总线上还有 emitObserved 的原始副本（同一对象）：
      // 已由 RUN_EVENT 广播过，这里跳过；只有观测专属事件（run.timing /
      // session.inbox.appended 等）继续走下面的广播分支。
      if (this.wrappedRunEvents.has(event)) return;
      if (
        event.sessionId &&
        !Gateway.isTerminalWsEvent(event.type)
      ) {
        // WS 不广播层正文全文（content）；点选层时 UI 经 REST 拉取
        const out =
          event.type === 'context.layers.assembled'
            ? stripLayerContentFromEvent(event)
            : event;
        for (const adapter of this.streamingAdapters) {
          adapter.broadcastEvent(event.sessionId, out as never, event.agentId);
        }
      }
    });
    if (store) {
      this.store = store;
    } else {
      // 延迟初始化：启动时解析默认持久化 store
      this._defaultStorePromise = createDefaultStore(config.agents);
    }

    // Issue → WS 广播
    this.issueRegistry.subscribe((ev) => this.broadcastIssue(ev));
    // doctor 兜底：崩溃残留 undo 目录
    void this.scanOrphanUndo().catch(() => undefined);

    // 注册配置中定义的 agents
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }

    this.modelLevels = config.levels;
  }

  /**
   * 设置 models.level 映射（daemon 启动注入 / L0 热更新）；同步 GatewayConfig 影子
   *
   * @param levels - level 映射；undefined 仅清展示源（启动路径兼容）
   */
  setModelLevels(levels: Record<string, { primary: string; fallback?: string[] }> | undefined): void {
    this.modelLevels = levels;
    this.config.levels = levels;
  }

  /** 激活宿主（Schedule/Escalate 等 Source 挂载用） */
  getAgentRuntime(): AgentRuntime {
    return this.runtime;
  }

  /**
   * 按配置挂载 Runtime Sources（Schedule / Escalate）。
   * 应在 start() 之前调用；与 gatewayBus 同源。
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
    /**
     * 挂载 AgentSignalSource（agent_signal 通知）三态：
     * true=挂载；false=显式关闭（委派 notify 推送随之关闭）；
     * 缺省=本方法不挂载，委派接线时按需补挂（ensureDelegationRuntime）。
     */
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
    // agentSignal 三态：true=挂载；false=显式关闭（委派 notify 推送随之关闭）；
    // 缺省=此处不挂载，委派接线时按需补挂（ensureDelegationRuntime）。
    // 注意：notifier 只在 ensureDelegationRuntime 首建 runtime 时按当时的
    // agentSignalPushDisabled 决定，运行期重配推送开关不生效（当前无此路径）。
    this.agentSignalPushDisabled = cfg.agentSignal === false;
    const wantsAgentSignal =
      cfg.agentSignal === true ||
      (cfg.agentSignal !== false && !!cfg.escalate?.defaultAgentId);
    if (wantsAgentSignal) {
      await this.ensureAgentSignalSource();
    }
  }

  /**
   * 幂等挂载 AgentSignalSource——委派 notify 推送的接收端。
   *
   * notify 链路：notifier -> emitAgentSignal(gatewayBus) -> AgentSignalSource
   * -> Trigger -> 父 Run。接收端缺失时通知会发进无人监听的总线，因此
   * 「装不装 notifier」必须与「挂没挂本 Source」保持一致（见 ensureDelegationRuntime）。
   */
  private async ensureAgentSignalSource(): Promise<void> {
    if (this.agentSignalMounted) return;
    // in-flight 合流：并发调用共用一次 import + 挂载；成功后才置 mounted
    //（先置位会让 import/addSource 失败变成永久「假挂载」），失败清缓存留重试口
    if (!this.agentSignalSourcePromise) {
      this.agentSignalSourcePromise = (async () => {
        const { AgentSignalSource } = await import(
          '@octopi-agent/engine/harness/activation/sources/agent-signal.js'
        );
        this.runtime.addSource(new AgentSignalSource({ events: this.gatewayBus }));
        this.agentSignalMounted = true;
        console.log('[Gateway] AgentRuntime AgentSignalSource mounted');
      })().catch((err) => {
        this.agentSignalSourcePromise = undefined;
        throw err;
      });
    }
    await this.agentSignalSourcePromise;
  }

  // ================================================================
  // 生命周期
  // ================================================================


  /**
   * 确保 store 已就绪（解析默认 store 的异步初始化）
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

    // 模型超时口径自检（2026-10-27 事故）：配置写 900s 却因 undici 默认 300s 从未生效。
    // 只告警不改行为——把隐含的优先级关系摊到启动日志里。
    {
      const { checkTimeoutCoherence, logTimeoutCoherence } = await import(
        '@octopi-agent/engine/integration/providers/timeout-coherence.js'
      );
      const providerTimeouts: Record<string, number | undefined> = {};
      for (const [name, p] of Object.entries(this.config.modelProviders ?? {})) {
        providerTimeouts[name] = p.timeoutSeconds;
      }
      const chainLengths = Array.from(this.agents.values()).map(
        (a) => 1 + (a.model?.fallbackModels?.length ?? 0),
      );
      logTimeoutCoherence(
        checkTimeoutCoherence({
          idleTimeoutMs: this.config.modelCallIdleTimeoutMs,
          absoluteTimeoutMs: this.config.modelCallAbsoluteTimeoutMs,
          providerTimeouts,
          fallbackAttemptTtftMs: this.config.modelCallFallbackAttemptTtftMs,
          maxFallbackChainLength: chainLengths.length > 0 ? Math.max(...chainLengths) : undefined,
        }),
      );
    }

    // 插件发现（docs/plugin-system.md）：扫描 plugins.loadPaths，注册 hooks / 命令。
    // 幂等：PluginLoader.discover 不做去重，stop→start 重复 discover 会双注册 hooks/命令
    if (!this.pluginsDiscovered) {
      try {
        const loaded = await this.pluginManager.discover();
        this.pluginsDiscovered = true;
        console.log(
          loaded.length > 0
            ? `[Gateway] plugins loaded: ${loaded.map((p) => p.id).join(', ')}`
            : '[Gateway] plugins loaded: (none)',
        );
      } catch (err) {
        // 吞掉发现期错误（单个插件坏包不阻断网关启动）；保留 warn 与插件名定位，
        // pluginsDiscovered 不置位，下次 start 可重试
        console.warn(
          `[Gateway] plugin discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 会话日程：Service open() 惰性建库；wakeup 接 AgentRuntime（arch/session-schedules.md）
    {
      // start 重试时先拆掉旧实例，避免双 writer / 双 timer
      this.sessionSchedules?.dispose();
      this.sessionSchedules = undefined;
      const { SessionScheduleService } = await import(
        '@octopi-agent/engine/harness/session/schedules/service.js'
      );
      const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
      const { join } = await import('node:path');
      this.sessionSchedules = new SessionScheduleService({
        dbPath: join(getOctopiHome(), 'schedules.db'),
        events: this.gatewayBus,
        ...(this.config.schedules?.maxOpenPerSession !== undefined
          ? { maxOpenPerSession: this.config.schedules.maxOpenPerSession }
          : {}),
        ...(this.config.schedules?.maxWakesPerHour !== undefined
          ? { maxWakesPerHour: this.config.schedules.maxWakesPerHour }
          : {}),
        ...(this.config.schedules?.tickIntervalMs !== undefined
          ? { tickIntervalMs: this.config.schedules.tickIntervalMs }
          : {}),
      });
      await this.sessionSchedules.open();
      this.sessionSchedules.setWakeup((trigger) => {
        void this.runtime.dispatch(trigger).catch((err) => {
          console.error(
            '[Gateway] session schedule wake dispatch failed:',
            err instanceof Error ? err.message : err,
          );
        });
      });
      this.sessionSchedules.setNotify(async ({ schedule, content }) => {
        // notify：只落会话消息，不 dispatch Run
        const session = await this.store.load(schedule.sessionId);
        if (!session) return;
        session.messages.push({
          role: 'user',
          content,
          timestamp: Date.now(),
          agentId: schedule.agentId,
          metadata: {
            source: 'runtime',
            origin: 'session_schedule',
            scheduleId: schedule.id,
            delivery: 'notify',
            triggerType: 'schedule',
          },
        });
        session.meta.updatedAt = Date.now();
        await this.store.save(schedule.sessionId, session);
      });
      console.log('[Gateway] SessionScheduleService ready (schedules.db)');
    }

    console.log('[Gateway] Starting...');
    console.log(`[Gateway] Agents: ${Array.from(this.agents.keys()).join(', ') || '(none)'}`);
    console.log(`[Gateway] Channels: ${Array.from(this.channels.keys()).join(', ') || '(none)'}`);

    // SEC-4: surface unsafe effect mode when Web is on (visibility, not a hard stop)
    const effStatus = this.getEffectPolicyStatus();
    if (effStatus.configuredMode) {
      console.log(`[Gateway] effectPolicy.mode: ${effStatus.configuredMode}`);
    } else {
      console.log(
        `[Gateway] effectPolicy.mode: (unset) → engine default ${effStatus.engineDefaultMode}`,
      );
    }
    for (const w of effStatus.warnings) {
      console.warn(`[Gateway] WARNING ${w}`);
    }

    // Knowledge 与 channel 并行拉起：HTTP 就绪时 /health 不必再读到启动窗口
    const knowledgeBoot = this.bootKnowledgeRuntime();

    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Starting channel: ${name}`);
      await adapter.start(async (msg) => {
        await this.handleInboundMessage(msg);
      });
    }

    // Plugin 已注册命令合入 + user/skill 命令装载（必须在收消息前）
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

  /**
   * EffectPolicy visibility (SEC-4): configured vs engine default vs warnings.
   * Engine default is workspace when `mode` is omitted; scaffold sets host explicitly.
   */
  getEffectPolicyStatus(): {
    configuredMode?: string;
    effectiveMode: string;
    engineDefaultMode: string;
    webEnabled: boolean;
    warnings: string[];
  } {
    const configuredMode = this.config.effectPolicy?.mode;
    const engineDefaultMode = 'workspace';
    const effectiveMode = configuredMode ?? engineDefaultMode;
    const webEnabled = !!(
      (this.config as { web?: unknown }).web ||
      (this.config as { webui?: unknown }).webui
    );
    const warnings: string[] = [];
    if (webEnabled && effectiveMode === 'host') {
      warnings.push(
        'web_enabled_with_host_mode: full tool capability (shell, no path jail). Multi-tenant should use workspace|untrusted.',
      );
    }
    if (webEnabled && effectiveMode === 'project') {
      warnings.push(
        'web_enabled_with_project_mode: coding mode, not an isolation mode (shell may touch paths outside roots).',
      );
    }
    return { configuredMode, effectiveMode, engineDefaultMode, webEnabled, warnings };
  }

  /**
   * 特权部署状态（ops P4，`arch/ops-privileged-mode.md` §5 P4/§8.1）：
   * WebUI / CLI 常驻 `PRIVILEGED` 标记的数据源。
   *
   * active = 任一 effectPolicy 授权无笼（`jail: none`）/ 全量提权（`escalation: full`）
   * / 本进程高权限（root·elevated，行为探测而非配置位）。授权态 ≠ 降级：不进
   * securityDegraded，只做常驻可见性。
   */
  async getPrivilegedStatus(): Promise<{ active: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const policies: Array<{ scope: string; policy?: EffectPolicyConfig }> = [
      { scope: 'top', policy: this.config.effectPolicy },
      ...Array.from(this.agents.entries()).map(([id, agent]) => ({
        scope: id,
        policy: (agent as { effectPolicy?: EffectPolicyConfig }).effectPolicy,
      })),
    ];
    for (const { scope, policy } of policies) {
      if (policy?.jail === 'none') reasons.push(`${scope}: jail=none`);
      if (policy?.escalation?.policy === 'full') reasons.push(`${scope}: escalation=full`);
    }
    const { isProcessElevated } = await import(
      '@octopi-agent/engine/harness/extension/execution-environment/privileged-exec.js'
    );
    if (await isProcessElevated()) reasons.push('process: elevated (root/admin)');
    return { active: reasons.length > 0, reasons };
  }

  /**
   * Session effect roots (SEC / ToolEffectPolicy): configured roots + session temporary roots.
   * Temporary roots are append-only and die with the session.
   */
  async getSessionEffectRoots(sessionId: string): Promise<{
    sessionId: string;
    temporaryRoots: string[];
    configuredRoots: string[];
    mode?: string;
  }> {
    // 显式挑字段：私有 helper 多带 effectPolicyConfig/workspace，不得外泄进 HTTP 契约
    const { sessionId: id, temporaryRoots, configuredRoots, mode } =
      await this.resolveSessionEffectRoots(sessionId);
    return { sessionId: id, temporaryRoots, configuredRoots, mode };
  }

  /**
   * Derive the session's effect roots (throws when the session is missing).
   * Shared by the roots API and the git-status containment check.
   */
  private async resolveSessionEffectRoots(sessionId: string): Promise<{
    sessionId: string;
    temporaryRoots: string[];
    configuredRoots: string[];
    mode?: string;
    /** 原始 effectPolicy 配置（供 resolveEffectiveEffectPolicy 推导 jail 等） */
    effectPolicyConfig?: EffectPolicyConfig;
    workspace?: string;
  }> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const { readSessionEffectOverrides } = await import('@octopi-agent/engine');
    const temporaryRoots =
      readSessionEffectOverrides(session.metadata).transactionRoots ?? [];

    const agentId = session.primaryAgentId ?? session.agentId;
    // 策略来源唯一权威：运行时注册表（registerAgent → buildAgent）。config.agents
    // 影子查找已清理（P2）：注册表条目（AgentDefinition）自带 effectPolicy/workspace，
    // 全局 config.effectPolicy 仅作缺省兜底。`~` 形态统一展开后输出。
    const agentDef = this.agents.get(agentId);
    const eff: EffectPolicyConfig | undefined =
      agentDef?.effectPolicy ?? (this.config.effectPolicy as EffectPolicyConfig | undefined);
    const workspaceRaw = agentDef?.workspace?.trim() || undefined;
    const workspace = workspaceRaw ? expandHomePath(workspaceRaw) : undefined;
    const extra = (eff?.transactionRoots ?? [])
      .filter(Boolean)
      .map((r) => expandHomePath(r.trim()));
    const configuredRoots = [...(workspace ? [workspace] : []), ...extra];
    return {
      sessionId,
      temporaryRoots,
      configuredRoots,
      mode: eff?.mode,
      effectPolicyConfig: eff,
      workspace,
    };
  }

  /**
   * Structured git status for one directory under this session's effect roots
   * (WebUI Git tab). Read-only and context-free: git runs through the engine's
   * hardened runner (the git_* tools' git-config isolation — hooks/filters
   * neutralized, `--no-optional-locks`, so polling cannot disturb real git
   * operations). Isolation parity with the agent's tools: the jail backend is
   * used whenever the host offers one (same as tool runs), the fence roots are
   * passed as jail roots so bwrap namespaces still see the whole work tree, and
   * the runner's shared `requiresJail(eff)` turns jail-setup failure into a
   * hard error (fail-closed) for untrusted sessions instead of the supervised
   * fallback. Other context knobs (homeWrite/network) stay off here.
   *
   * Fencing note: this is a capability boundary, not a security boundary — any
   * caller allowed to add session effect roots can widen it. The fence validates
   * the requested directory itself (lexical + realpath, symlink-proof); `git
   * status` then reports the whole discovered work tree, which may reach above
   * the requested directory (git semantics).
   *
   * @param sessionId - session whose roots fence the request
   * @param rawPath - absolute directory path (a root or inside one; `~/` expanded)
   * @param options - maxEntries cap passthrough
   * @returns path echo (canonical) + snapshot (isRepo=false is a state, not an error)
   * @throws Error `path_invalid` / `path_not_allowed` / `path_not_found` /
   *          `git_not_found` / `git_status_failed`
   */
  async getSessionGitStatus(
    sessionId: string,
    rawPath: string,
    options?: { maxEntries?: number },
  ): Promise<GitStatusSnapshot & { path: string }> {
    const roots = await this.resolveSessionEffectRoots(sessionId);
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const expandHome = expandHomePath;
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes('\0')) {
      throw new Error('path_invalid: path must be non-empty and contain no NUL byte');
    }
    const expanded = expandHome(trimmed);
    if (!path.isAbsolute(expanded)) {
      throw new Error(`path_invalid: "${rawPath}" must be an absolute path`);
    }
    const lexTarget = path.resolve(expanded);
    const casefold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const under = (parent: string, child: string): boolean => {
      const rel = path.relative(casefold(parent), casefold(child));
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    };
    const rootsLex = [...roots.configuredRoots, ...roots.temporaryRoots].map((root) =>
      path.resolve(expandHome(root)),
    );
    // 围栏先于存在性检查：越界路径一律 path_not_allowed，不泄露目标是否存在。
    if (!rootsLex.some((r) => under(r, lexTarget))) {
      throw new Error(`path_not_allowed: "${lexTarget}" is outside this session's roots`);
    }
    // Symlink-proof fence, second stage: containment must also hold on the
    // canonical path — `/ws/link -> /etc` passes the lexical check but fails
    // this one. git then runs at the validated canonical path, closing the
    // check-vs-use race on the target side.
    const realTarget = await fs.realpath(lexTarget).catch(() => {
      // Swallows the fs error detail (ENOENT/EACCES/…): the picker only offers
      // existing roots, so any realpath failure is stale or invalid picker
      // state, reported uniformly as not-found (lexical fence already passed).
      throw new Error(`path_not_found: "${lexTarget}" does not exist or is not readable`);
    });
    const rootsReal = await Promise.all(
      rootsLex.map((lex) => fs.realpath(lex).catch(() => lex)),
    );
    if (!rootsReal.some((r) => under(r, realTarget))) {
      throw new Error(`path_not_allowed: "${lexTarget}" resolves outside this session's roots`);
    }
    const st = await fs.stat(realTarget).catch(() => null);
    if (!st) {
      throw new Error(`path_not_found: "${lexTarget}" does not exist or is not readable`);
    }
    if (!st.isDirectory()) {
      throw new Error(`path_not_found: "${lexTarget}" is not a directory`);
    }
    // ── 隔离对齐（留观①）：先推导后节流——untrusted admission 拒绝不得被缓存旁路。
    // jail 后端可用即进（与工具同路径）；围栏根集合作为 jail roots 传入（bwrap
    // 命名空间只挂列名根，缺了会把上级 .git 判成非仓库）；requiresJail(eff) 与
    // runner 同源，把 untrusted 的 jail 建立失败从「回落 supervised」变成硬错误。
    const {
      readGitStatusSnapshot,
      resolveEffectiveEffectPolicy,
      requiresJail,
      probeProcessIsolation,
    } = await import('@octopi-agent/engine');
    const eff = resolveEffectiveEffectPolicy(
      roots.effectPolicyConfig ?? {},
      roots.workspace,
      await probeProcessIsolation(),
    );
    const requireJail = requiresJail(eff);

    // ── 读节流（留观④）──
    // 键含请求维度（maxEntries）与隔离签名（requireJail + jailRoots）：不同会话的
    // 隔离语义绝不互串——untrusted 的 fail-closed 判定、bwrap 可见性都不会被另一
    // 会话的缓存条目旁路；同键并发走单飞共享一次读，闸门只约束不同键的并发。
    const cacheKey = [
      realTarget,
      String(options?.maxEntries ?? 'default'),
      requireJail ? 'jail' : 'open',
      [...rootsLex].sort().join(','),
    ].join('\0');
    const cached = this.gitStatusCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAtMono > performance.now()) return cached.payload;
      this.gitStatusCache.delete(cacheKey); // 惰性淘汰
    }
    const inflight = this.gitStatusInflight.get(cacheKey);
    if (inflight) return inflight;
    const release = this.gitStatusGate.tryAcquire();
    if (!release) {
      throw new Error('git_status_busy: too many concurrent git status reads; retry shortly');
    }
    const task = (async () => {
      try {
        const snapshot = await readGitStatusSnapshot(realTarget, {
          ...options,
          requireJail,
          jailRoots: rootsLex,
        });
        // 冻结防消费方原地变异污染缓存
        const payload = Object.freeze({ path: realTarget, ...snapshot });
        this.gitStatusCache.set(cacheKey, {
          expiresAtMono: performance.now() + GIT_STATUS_CACHE_TTL_MS,
          payload,
        });
        while (this.gitStatusCache.size > GIT_STATUS_CACHE_MAX_ENTRIES) {
          const oldest = this.gitStatusCache.keys().next().value;
          if (oldest === undefined) break;
          this.gitStatusCache.delete(oldest);
        }
        return payload;
      } finally {
        release();
        this.gitStatusInflight.delete(cacheKey);
      }
    })();
    this.gitStatusInflight.set(cacheKey, task);
    return task;
  }

  /**
   * Append a session-temporary transaction root (does not loosen containment).
   *
   * @throws Error when session missing or path invalid
   */
  async addSessionEffectRoot(sessionId: string, rawPath: string): Promise<{
    temporaryRoots: string[];
  }> {
    const { normalizeTransactionRoots, readSessionEffectOverrides, SESSION_EFFECT_OVERRIDES_KEY } =
      await import('@octopi-agent/engine');
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const next = normalizeTransactionRoots([rawPath]);
    const add = next[0]!;
    await this.patchSessionMetadata(sessionId, (meta) => {
      const cur = readSessionEffectOverrides(meta).transactionRoots ?? [];
      const addKey = process.platform === 'win32' ? add.toLowerCase() : add;
      const merged = cur.filter(
        (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p) !== addKey,
      );
      merged.push(add);
      meta[SESSION_EFFECT_OVERRIDES_KEY] = {
        ...((meta[SESSION_EFFECT_OVERRIDES_KEY] as object) ?? {}),
        transactionRoots: merged,
      };
    });
    return {
      temporaryRoots:
        readSessionEffectOverrides(
          (await this.store.load(sessionId))?.metadata,
        ).transactionRoots ?? [],
    };
  }

  /**
   * Remove one session-temporary transaction root.
   */
  async removeSessionEffectRoot(sessionId: string, rawPath: string): Promise<{
    temporaryRoots: string[];
  }> {
    const { normalizeTransactionRoots, readSessionEffectOverrides, SESSION_EFFECT_OVERRIDES_KEY } =
      await import('@octopi-agent/engine');
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const target = normalizeTransactionRoots([rawPath])[0]!;
    const tKey = process.platform === 'win32' ? target.toLowerCase() : target;
    await this.patchSessionMetadata(sessionId, (meta) => {
      const cur = readSessionEffectOverrides(meta).transactionRoots ?? [];
      const kept = cur.filter(
        (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p) !== tKey,
      );
      if (kept.length === 0) {
        delete meta[SESSION_EFFECT_OVERRIDES_KEY];
      } else {
        meta[SESSION_EFFECT_OVERRIDES_KEY] = {
          ...((meta[SESSION_EFFECT_OVERRIDES_KEY] as object) ?? {}),
          transactionRoots: kept,
        };
      }
    });
    return {
      temporaryRoots:
        readSessionEffectOverrides(
          (await this.store.load(sessionId))?.metadata,
        ).transactionRoots ?? [],
    };
  }

  /**
   * 会话关闭策略（effectPolicy.onClose）：commit=manual 时残留 undo 的处理。
   * 缺省 commit（保留效应）；discard = 逆放 agent 效应。
   */
  async applySessionClosePolicy(sessionId: string): Promise<'committed' | 'discarded' | 'none'> {
    const { resolveSessionUndoOnClose, resolveEffectiveEffectPolicy } = await import(
      '@octopi-agent/engine'
    );
    const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
    const { join } = await import('node:path');
    const sessionsDir = join(getOctopiHome(), 'sessions');
    const agentId = await this.store
      .load(sessionId)
      .then((s) => s?.primaryAgentId ?? s?.agentId)
      .catch(() => undefined);
    const agentEff = this.agents.get(agentId ?? '')?.effectPolicy as
      | { onClose?: string }
      | undefined;
    const onClose =
      (agentEff?.onClose as 'commit' | 'discard' | undefined)
      ?? (this.config.effectPolicy?.onClose as 'commit' | 'discard' | undefined)
      ?? 'commit';
    const memoryRestorer = agentId ? this.memoryRestorers.get(agentId) : undefined;
    return resolveSessionUndoOnClose({
      sessionsDir,
      sessionId,
      onClose,
      memoryRestorer,
    });
  }

  /**
   * 删除会话：先按 onClose 收掉残留 undo，再删存储。幂等：已不存在视为成功。
   *
   * @param sessionId - 目标会话
   * @throws Run 在途（session_running: …）——在途删除会让落盘于删除之后的 Run 把会话写回来，必须先停再删。
   *   残余竞态（已知，见 arch/open-problems.md OP-WEB-3）：守卫与 store.delete 之间新准入的 Run 仍可能在删除后
   *   落盘复活，admission 侧尚无删除互斥；窗口已用删前二次校验收窄，未根除。
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.store.load(sessionId);
    if (!session) {
      // 幂等：删除已不存在的会话视为成功（多端并发删除不互相报错）
      return;
    }
    if (this.runtime.hasActiveRunForSession(sessionId)) {
      throw new Error(`session_running: cannot delete "${sessionId}" while a run is active`);
    }
    this.cancelPendingApprovals(sessionId);
    this.cancelPendingQuestions(sessionId);
    this.clearHitlSessionCache(sessionId);
    await this.applySessionClosePolicy(sessionId);
    this.sessionSchedules?.purgeSession(sessionId);
    // 删前二次校验，收窄守卫到删除之间的 Run 准入窗口
    if (this.runtime.hasActiveRunForSession(sessionId)) {
      throw new Error(`session_running: cannot delete "${sessionId}" while a run is active`);
    }
    await this.store.delete(sessionId);
    // 其他已订阅端同步移除卡片，避免点开已删会话才报错
    this.broadcastSessionEvent('session.removed', sessionId, {}, session.agentId ?? session.meta.agentId);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.cancelAllPendingHitl();
    this.gitStatusCache.clear();
    this.gitStatusInflight.clear();
    this.sessionSchedules?.dispose();
    this.sessionSchedules = undefined;
    // 委派运行时持有送达回执订阅（常驻 gatewayBus）：停机回收 + 清缓存，
    // 允许下次 start/接线重建（否则重复创建会累积订阅闭包）
    this.delegationRuntime?.dispose();
    this.delegationRuntime = undefined;
    this.delegationRuntimePromise = undefined;
    // 进程退出：按 onClose 收掉所有残留 turn undo（缺省 commit）
    try {
      const { resolveSessionUndoOnClose, resolveSessionUndoPaths } = await import(
        '@octopi-agent/engine'
      );
      const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
      const { join } = await import('node:path');
      const { readdir, stat } = await import('node:fs/promises');
      const sessionsDir = join(getOctopiHome(), 'sessions');
      const onClose =
        (this.config.effectPolicy?.onClose as 'commit' | 'discard' | undefined) ?? 'commit';
      const names = await readdir(sessionsDir).catch(() => [] as string[]);
      for (const name of names) {
        const undoRoot = join(sessionsDir, name, 'undo');
        try {
          await stat(undoRoot);
        } catch {
          continue;
        }
        const memRestorer = await this.store
          .load(name)
          .then((s) => this.memoryRestorers.get(s?.primaryAgentId ?? s?.agentId ?? ''))
          .catch(() => undefined);
        await resolveSessionUndoOnClose({
          sessionsDir,
          sessionId: name,
          onClose,
          memoryRestorer: memRestorer,
          // 本进程收尾只收残留；他人活跃进程（并行 daemon / 正在跑的测试）的 undo 不许动
          skipLiveForeign: true,
        }).catch(() => undefined);
      }
    } catch {
      // stop 路径 fail-open，不阻断关闭
    }

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

    // 释放 Runner 后台 timer（BackfillTrigger / HealthProbe / SubsystemRuntime）
    for (const cached of this.agentCache.values()) {
      try {
        cached.runner.dispose();
      } catch {
        // stop 路径 fail-open，不阻断关闭
      }
    }
    this.agentCache.clear();
    // 热失效退役 runner 兜底回收
    for (const runner of this.retiredRunners.splice(0)) {
      try {
        runner.dispose();
      } catch {
        // stop 路径 fail-open，不阻断关闭
      }
    }

    // 释放 provider transport（keep-alive dispatcher 的连接池）；
    // 经 Promise 桥接，dispose 的同步/异步异常都落进 catch，不阻断关闭
    for (const provider of this.providers.values()) {
      try {
        await Promise.resolve().then(() => provider.dispose?.());
      } catch {
        // stop 路径 fail-open，不阻断关闭
      }
    }
    this.providers.clear();

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

  // ================================================================
  // 配置热应用（arch/config-hot-reload.md §3）
  // ================================================================

  /**
   * 下线 agent：摘注册表 + 摘 runtime dispatcher（触发不再派发）+ 退役构建缓存
   * （home/persona 文件态保留；在跑 run 跑完自然结束）
   *
   * @param agentId - 要摘除的 agent id
   */
  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.runtime.unregisterAgent(agentId);
    const cached = this.agentCache.get(agentId);
    if (cached) {
      this.agentCache.delete(agentId);
      this.retireRunner(cached.runner);
    }
  }

  /**
   * 取注册表条目（配置热应用 persona 归属解析用）
   *
   * @param agentId - agent id
   * @returns AgentDefinition；未注册返回 undefined
   */
  getAgentDefinition(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 全量重置配置面运行时（回滚用）：providers / agents / levels 换成给定集合。
   * 退役的 agent 构建走 retireRunner（in-flight 跑完再 dispose）。
   *
   * @param providers - provider 实例 + raw 配置（影子同步）
   * @param agentDefs - agent 定义全集（调用方随后 registerAgent + invalidate）
   * @param levels - level 映射（undefined = 清空）
   */
  resetRuntimeConfig(
    providers: Array<{ name: string; config: Record<string, unknown>; instance: ModelProvider }>,
    agentDefs: AgentDefinition[],
    levels: Record<string, { primary: string; fallback?: string[] }> | undefined,
  ): void {
    for (const name of [...this.providers.keys()]) {
      if (!providers.some((p) => p.name === name)) this.providers.delete(name);
    }
    for (const p of providers) {
      this.providers.set(p.name, p.instance);
      if (this.config.modelProviders) {
        this.config.modelProviders[p.name] = p.config as unknown as import('@octopi-agent/engine/config.js').ModelProviderConfig;
      }
    }
    // 影子同步清理（#5）：移除不在回滚集合中的 provider 影子（防幽灵模型进目录）
    if (this.config.modelProviders) {
      for (const name of Object.keys(this.config.modelProviders)) {
        if (!providers.some((p) => p.name === name)) delete this.config.modelProviders[name];
      }
    }
    for (const id of [...this.agents.keys()]) {
      if (!agentDefs.some((d) => d.id === id)) this.removeAgent(id);
    }
    this.setModelLevels(levels);
    console.log(`[Gateway] Runtime config reset: ${providers.length} providers, ${agentDefs.length} agents`);
  }

  /**
   * 热失效 agent 构建缓存（L1）：**立即重建并覆盖注册**（runtime.registerAgent 为 upsert，
   * 不摘除 → Schedule/触发派发零窗口，不丢排队触发）；在跑 run 用旧构建跑完（旧 runner
   * 的 dispatcher 已被覆盖，in-flight 流仍由旧 runner 服务）。
   *
   * @param agentId - 失效的 agent id
   */
  async invalidateAgentBuild(agentId: string): Promise<void> {
    const cached = this.agentCache.get(agentId);
    if (cached) {
      this.agentCache.delete(agentId);
      this.retireRunner(cached.runner);
    }
    // 立即重建（新 provider/level/定义）+ 覆盖注册
    const def = this.agents.get(agentId);
    if (!def) return;
    try {
      const fresh = await this.buildAgent(def);
      this.agentCache.set(agentId, fresh);
      await this.registerRuntimeAgent(def, fresh.runner);
      console.log(`[Gateway] Rebuilt agent after config change: ${agentId}`);
    } catch (err) {
      // 构建失败降级（#6 fail-honest）：注册表仍保留新 def，缓存留空由下一条消息
      // 惰性重建——绝不让回滚/批量热更循环中途断裂（否则运行时半更新）。
      console.warn(`[Gateway] eager rebuild failed for "${agentId}"（下次消息惰性重建）: ${String(err)}`);
    }
  }

  /** 热失效全部 agent 构建（level 路由变更等影响面难精确枚举时） */
  async invalidateAllAgentBuilds(): Promise<void> {
    for (const agentId of [...this.agentCache.keys()]) {
      await this.invalidateAgentBuild(agentId);
    }
  }

  /**
   * 热替换 provider（L2）：注册表替换 + 影子同步 + 失效引用它的 agent 构建。
   *
   * @param provider - 新 provider 实例（同名替换）
   * @param providerConfig - 对应 raw 配置片段（同步 GatewayConfig 影子，供后续 build 用）
   * @param referencedAgentIds - 引用该 provider 的 agent id（调用方经 findProviderReferences 计算）
   */
  async replaceProvider(
    provider: ModelProvider,
    providerConfig: Record<string, unknown>,
    referencedAgentIds: string[],
  ): Promise<void> {
    this.providers.set(provider.name, provider);
    if (this.config.modelProviders) {
      this.config.modelProviders[provider.name] =
        providerConfig as unknown as import('@octopi-agent/engine/config.js').ModelProviderConfig;
    }
    for (const agentId of referencedAgentIds) {
      await this.invalidateAgentBuild(agentId);
    }
    console.log(`[Gateway] Hot-replaced provider: ${provider.name}`);
  }

  /**
   * 热删除 provider（L2）：注册表/影子摘除 + 失效引用它的 agent 构建。
   * 引用完整性（拒绝删除）由调用方经 findProviderReferences 把关。
   *
   * @param name - provider 名
   * @param referencedAgentIds - 引用该 provider 的 agent id
   */
  async removeProvider(name: string, referencedAgentIds: string[]): Promise<void> {
    this.providers.delete(name);
    if (this.config.modelProviders) {
      delete this.config.modelProviders[name];
    }
    for (const agentId of referencedAgentIds) {
      await this.invalidateAgentBuild(agentId);
    }
    console.log(`[Gateway] Hot-removed provider: ${name}`);
  }

  /** 退役 runner：in-flight 计数归零即 dispose；30min 长尾强制兜底（warn 后仍回收） */
  private retireRunner(runner: SessionAwareRunner): void {
    this.retiredRunners.push(runner);
    const tryDispose = (): void => {
      const inflight = this.runnerInflight.get(runner) ?? 0;
      if (inflight > 0) {
        // 仍有 run 在旧构建上跑完（拍板语义：不抢锁、不断流）——稍后重查
        const t = setTimeout(tryDispose, 5_000);
        t.unref?.();
        return;
      }
      this.disposeRetiredRunner(runner);
    };
    tryDispose();
    const force = setTimeout(() => {
      if (this.retiredRunners.includes(runner)) {
        console.warn('[Gateway] retired runner force-disposed with runs possibly in-flight (>30min)');
        this.disposeRetiredRunner(runner);
      }
    }, 30 * 60_000);
    force.unref?.();
  }

  /** 退役 runner 回收（幂等；stop 兜底也走这里） */
  private disposeRetiredRunner(runner: SessionAwareRunner): void {
    const idx = this.retiredRunners.indexOf(runner);
    if (idx < 0) return;
    this.retiredRunners.splice(idx, 1);
    this.runnerInflight.delete(runner);
    try {
      runner.dispose();
    } catch {
      // 退役回收 fail-open：dispose 只清后台 timer，失败不阻断
    }
  }

  registerChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter);
    // 检测是否支持流式广播
    if ('broadcastEvent' in adapter && typeof adapter.broadcastEvent === 'function') {
      this.streamingAdapters.push(adapter as StreamingChannelAdapter);
    }
    // 注册中止回调
    if ('onAbort' in adapter) {
      (adapter as any).onAbort = (sessionId: string) => this.abortSession(sessionId);
    }
    // 注册欢迎消息扩展（agent 信息 + 命令目录 + open issues）
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
    const name = tool.definition.name;
    // Dedupe by name: last explicit registration wins in the gateway list;
    // ToolBus still refuses silent replace when building agents unless toolReplace.
    const idx = this.tools.findIndex((t) => t.definition.name === name);
    if (idx >= 0) {
      console.warn(`[Gateway] tool "${name}" replaced in global list`);
      this.tools[idx] = tool;
    } else {
      this.tools.push(tool);
    }
  }

  registerProvider(provider: ModelProvider): void {
    // 热更替换（arch/config-hot-reload.md L2）不在此收口旧 provider：在跑 run 仍要
    // 用旧配置跑完（拍板），立即关 dispatcher 会让旧 run 的下一次模型调用伪失败；
    // 推迟回收属 config 热应用的退役协调（对齐 disposeRetiredRunner 的 in-flight 计数），
    // 进程级收口由 stop() 兜底。
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
   * 中止指定 session 的正在运行的 agent
   * 归属：Runtime 持有 AbortController；Gateway 转调（arch/agent-runtime.md §8.1）
   */
  abortSession(sessionId: string): void {
    this.cancelPendingQuestions(sessionId);
    this.cancelPendingApprovals(sessionId);
    this.clearHitlSessionCache(sessionId);
    this.clientTools.cancelSessionCalls(sessionId, 'session aborted');
    for (const agentId of this.agents.keys()) {
      this.runtime.abort(agentId, sessionId);
    }
  }

  // ================================================================
  // Commands / System Issues（arch/slash-commands.md · arch/system-issues.md）
  // ================================================================

  getIssueRegistry(): IssueRegistry {
    return this.issueRegistry;
  }

  /**
   * doctor：扫描会话 undo 孤儿目录（崩溃残留）并登记 Issue。
   *
   * @returns 孤儿列表
   */
  async scanOrphanUndo(): Promise<Array<{
    sessionDirName: string;
    undoRoot: string;
    entries: number;
    hasMemory: boolean;
    hasNotReversed: boolean;
  }>> {
    const { scanOrphanSessionUndo } = await import('@octopi-agent/engine');
    const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
    const { join } = await import('node:path');
    const sessionsDir = join(getOctopiHome(), 'sessions');
    const orphans = await scanOrphanSessionUndo(sessionsDir).catch(() => [] as never[]);
    if (orphans.length > 0) {
      const list = orphans
        .map((o) => `${o.sessionDirName}(${o.entries} entries)`)
        .join(', ');
      this.issueRegistry.report({
        id: 'orphan-session-undo',
        domain: 'other',
        code: 'undo_orphan_dirs',
        severity: 'warning',
        title: '发现残留 undo 目录',
        detail: `崩溃或异常退出后未清理的 turn undo：${list}。可对最后一轮执行编辑重发 discard，或手动删除 sessions/*/undo。`,
        refs: orphans.slice(0, 5).map((o) => ({ label: o.sessionDirName, path: o.undoRoot })),
        actions: [{ id: 'doctor', label: '重新扫描' }],
      });
    } else {
      this.issueRegistry.resolve('orphan-session-undo');
    }
    return orphans;
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
        // 同步路径仅能读缓存；完整值走 view（execute 入参）
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

  /** Skill command 桥接（启动 / buildAgent 发现 skill 后调用；冲突进 Issue） */
  registerSkillCommands(skills: import('@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/types.js').SkillManager): void {
    const defs = skillCommandsFromManager(skills, (id) => skills.load(id));
    // ref = skillId：同 skill 重载 upsert；不同 skill 同 command 名可冲突
    for (const skill of skills.list()) {
      if (!skill.command) continue;
      const def = defs.find((d) => d.name === skill.command);
      if (def) {
        this.commandRouter.register(def, `skill:${skill.id}`);
      }
    }
  }

  /** 用户 commands/*.md（agent.home/commands） */
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
   * 启动时注册各 agent 的 user/skill 命令。
   * 必须在命令裁决前完成——否则 /help 进 Loop 前看不到自定义命令。
   */
  async ensureCommandSources(): Promise<void> {
    if (this.commandSourcesReady) return;
    this.commandSourcesReady = true;
    for (const agent of this.agents.values()) {
      if (!agent.home) continue;
      // AgentDefinition 是宿主可编程注入的边界：`~` 在此展开（与 builder/config 同规），
      // 否则 join() 会在进程 cwd 下拼出字面 `~/…` 目录。
      const home = expandHomePath(agent.home.trim());
      try {
        this.registerUserCommands(agent.id, join(home, 'commands'));
      } catch (err) {
        console.warn(
          `[Gateway] user command load failed for agent "${agent.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const skillDir = agent.skillDirectory
        ? expandHomePath(agent.skillDirectory.trim())
        : join(home, 'skills');
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

  /** Plugin registerCommand → Router（plugin load 后调用） */
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
            // 硬收敛：把当前会话标 recent 并带 sessionText，供补录触发（不阻塞切换）
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
              // 切换会话不因补录快照失败而中断
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
            // reserved；V1 不落地
            break;
          default:
            break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 单 op 失败：收成 error，仍继续后续 op / 终态广播，避免 UI 卡死
        result.status = 'error';
        result.display = {
          type: 'text',
          text: `命令已接收，但执行副作用失败：${msg}`,
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
      // 留痕失败不阻断命令结果回放（Discourse 投影可重建）
    }
  }

  private broadcastCommandResult(sessionId: string, payload: Record<string, unknown>, agentId?: string): void {
    const event = {
      type: 'command.result',
      sessionId,
      timestamp: Date.now(),
      ...(agentId ? { agentId } : {}),
      data: payload,
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(sessionId, event, agentId);
    }
  }

  /**
   * control 命令终态：合成 turn.end，让 Web/TUI 清 streaming 并展示 display 文案。
   * 命令不进 Loop，不会由 Runner 产出 turn.end。
   * **不带 error:true**——Loop 的 turn.end+error 表示重试/waiting，会把命令结果打回运行态。
   * 纯文本（type=text）转 Markdown 硬换行；markdown 原样。
   */
  private broadcastCommandTurnEnd(
    sessionId: string,
    content: string,
    displayType: 'text' | 'markdown' | 'json' = 'text',
    agentId?: string,
  ): void {
    const raw = content ?? '';
    const text = displayType === 'text' ? raw.split('\n').join('  \n') : raw;
    const event = {
      type: 'turn.end',
      sessionId,
      timestamp: Date.now(),
      ...(agentId ? { agentId } : {}),
      data: {
        content: text,
        phase: 'final',
        hasToolCalls: false,
        fromCommand: true,
      },
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(sessionId, event, agentId);
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
      // 系统级问题：广播给全部 WS 会话
      adapter.broadcastEvent('*', event);
    }
  }

  // ================================================================
  // Web Runtime: read/write surface for REST skeleton
  // ================================================================

  getRegisteredAgents(): Array<{
    id: string;
    model: ModelConfig;
    /** Effective effectPolicy.mode (agent → global → engine default workspace) */
    effectMode: string;
    /** Where the mode came from */
    effectModeSource: 'agent' | 'global' | 'default';
  }> {
    const globalMode = this.config.effectPolicy?.mode;
    return Array.from(this.agents.entries()).map(([id, agent]) => {
      // 注册表唯一权威（P2 影子清理）：AgentDefinition 自带 effectPolicy
      const agentMode = agent.effectPolicy?.mode;
      const effectMode = agentMode ?? globalMode ?? 'workspace';
      const effectModeSource: 'agent' | 'global' | 'default' = agentMode
        ? 'agent'
        : globalMode
          ? 'global'
          : 'default';
      return { id, model: agent.model, effectMode, effectModeSource };
    });
  }

  /**
   * WebUI 模型目录
   *
   * @returns 已注册 provider 的全部模型 + agent 默认模型 + level 映射
   */
  getModelCatalog(): ModelCatalog {
    const seen = new Map<string, ModelCatalogItem>();
    const models: ModelCatalogItem[] = [];

    const push = (entry: ModelCatalogItem, opts?: { preferAgentExplicit?: boolean }) => {
      const prev = seen.get(entry.id);
      if (prev) {
        // agent 默认模型的配置窗口优先（与 session model 视图一致）
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
      // provider.models 含纯字符串模型（无能力字段）；必须入 catalog，窗口可为 null
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
      // agent 配置的 explicit 窗口优先于 provider 无能力条目
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
   * 查询 session 当前模型选择
   *
   * @param sessionId - 会话 id
   * @param agentId - 可选 agent 过滤
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
   * 设置 session 级模型选择
   *
   * @param sessionId - 会话 id
   * @param modelRef - `provider/model`、裸模型名或 null（恢复 agent 默认）
   * @param agentId - 可选 agent
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

    // 先算出目标 model 值，再原子写入 metadata（删键必须走 updateMetadata）
    let nextModel: { provider: string; model: string } | undefined;
    if (modelRef !== null && modelRef !== '') {
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
      nextModel = {
        provider: providerName,
        model: parsed.model,
      };
    }

    await this.patchSessionMetadata(sessionId, (meta) => {
      if (nextModel) {
        meta.model = nextModel;
      } else {
        delete meta.model;
      }
    });

    const fresh = await this.store.load(sessionId);
    if (fresh) {
      fresh.meta.updatedAt = Date.now();
      await this.store.save(fresh.id, fresh);
      return this.buildSessionModelView(fresh);
    }
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
   * 手动结构压缩（不依赖 contextWindow）
   *
   * 与 SessionAwareRunner.handle **共用 session 锁**（E1/E4）。
   * 权威互斥是锁，不是 status==='processing'；同 sessionId 的 run/compact 排队。
   * Compact 键 = (sessionId, agentId)；全量 messages 仍保留在 session store。
   *
   * @param sessionId - 会话 id
   * @param agentId - 可选 agent（避免全 agent 扫描；缺省用 session.agentId）
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

    // E4：compact 键使用调用方 agentId（缺省 primary）；不静默改键
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
        taskSnapshot?: string;
        contextWindow?: number;
        maxOutputTokens?: number;
        /** F22：cache-miss 旁路事件出口（ContextEmitFn 形状，经 observerHub 直采进 timeline） */
        emit?: (event: {
          type: string;
          sessionId?: string;
          reason?: string;
          fallback?: string;
          cached?: boolean;
        }) => void;
      }) => Promise<{
        ok: boolean;
        compacted: boolean;
        reason?: string;
        tokensBefore: number;
        tokensAfter?: number;
        summary?: string;
        coveredMessageCount?: number;
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
      // 会话模型绑定（评审 F6）：摘要必须走当前会话模型——丢了 modelName 会走 provider 默认
      // 模型，既违背「走当前会话模型」拍板，也让同形前缀缓存（per provider+model）彻底失效
      summarize = createProviderSummarize(bound.provider, {
        model: bound.modelName,
        maxOutputTokens: bound.maxOutputTokens,
      });
    }

    const compactTargetTokens =
      this.config.context?.contextAssembler?.compactTargetTokens;

    // D1：与 handle 共用 Runner session 锁；持久化走 Runner（E4 键）
    return cached.runner.compactSession(sessionId, effectiveAgentId, {
      compactStructural: (input) =>
        structural.compactStructural!({
          sessionId: input.sessionId,
          agentId: input.agentId,
          messages: input.messages,
          summarize: input.summarize,
          compactTargetTokens: input.compactTargetTokens,
          taskSnapshot: input.taskSnapshot,
          // 摘要请求窗口护栏（评审 F5）：窗口/输出上限随会话模型绑定注入，防最满时压缩被 400
          contextWindow: bound?.contextWindow,
          maxOutputTokens: bound?.maxOutputTokens,
          // F22：manual 路 cache-miss 旁路事件直采 Hub（同 Builder ContextEngine emit 合同：
          // ContextEngine 侧事件不经 Runner emitObserved，不直采 timeline 就永远看不到）
          emit: (e) => {
            const { type, sessionId: sid, ...data } = e;
            try {
              this.observerHub.ingestEvent({
                type,
                timestamp: Date.now(),
                sessionId: sid ?? input.sessionId,
                data,
              });
            } catch {
              // 观测 fail-open
            }
          },
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

  /** 会话列表项：meta + 实时运行态投影（不落盘，供 UI 识别正在跑的会话） */
  async listSessions(agentId?: string): Promise<Array<SessionMeta & { running: boolean }>> {
    const sessions = await this.store.list(agentId ? { agentId } : undefined);
    return sessions.map((meta) => ({
      ...meta,
      running: this.runtime.hasActiveRunForSession(meta.id),
    }));
  }

  /**
   * 手动重命名会话标题（titleSource=user，永不被自动摘要覆盖）。
   *
   * 标题是用户数据：写 `session.metadata` 三键（updateMetadata 通道，与 pinnedAt 同款），
   * 长驻 run 的整包 save 不回滚；列表侧由 SessionStore 投影为 SessionMeta.title。
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
    const trio = readTitleState(session.metadata);
    await this.patchSessionMetadata(sessionId, (meta) => {
      meta.title = trio.title;
      meta.titleSource = trio.titleSource;
      meta.titleUpdatedAt = trio.titleUpdatedAt;
    });
    this.broadcastSessionUpdated(sessionId, applied, 'user', session.agentId ?? session.meta.agentId);
    return session.meta;
  }

  /**
   * 置顶 / 取消置顶会话（SessionMeta.pinnedAt；历史列表置顶排序）。
   *
   * 置顶是用户数据，写 `session.metadata.pinnedAt`（updateMetadata 通道）：
   * 长驻 run 对象的整包 save 只浅合并 metadata、不抹本键；写 meta 会在 Run 落盘时被回写抹掉。
   * 列表侧由 SessionStore 投影为 SessionMeta.pinnedAt。
   *
   * @param sessionId - 目标会话
   * @param pinned - true=置顶（pinnedAt=now），false=取消置顶
   * @returns 更新后的 SessionMeta
   */
  async setSessionPinned(sessionId: string, pinned: boolean): Promise<SessionMeta> {
    const existing = await this.store.load(sessionId);
    if (!existing) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const at = Date.now();
    await this.patchSessionMetadata(sessionId, (meta) => {
      if (pinned) {
        meta.pinnedAt = at;
      } else {
        // metadata 键 save 浅合并删不掉，必须 updateMetadata 真删
        delete meta.pinnedAt;
      }
    });
    const updated = await this.store.load(sessionId);
    const pinnedAt = pinned ? at : undefined;
    const meta: SessionMeta = { ...(updated?.meta ?? existing.meta), pinnedAt };
    this.broadcastSessionMeta(sessionId, {
      pinnedAt: pinnedAt ?? null,
      updatedAt: Date.now(),
    }, existing.agentId ?? existing.meta.agentId);
    return meta;
  }

  /**
   * turn 落盘后异步更新标题（snippet / 小模型摘要）；失败不影响主流程。
   *
   * 同 session 串行；进行中再触发则标记 trailing，结束后补跑一次，避免丢掉第二轮升级。
   *
   * @param sessionId - 目标会话
   */
  /**
   * steered 消息的晚到回复：被接续进活跃 Run 后，回答在后续 turn 才产生。
   * 由事件转发触发、恰好发送一次（与同步回复路径互斥，评审 F3）。
   */
  private async sendLateChannelReply(
    msg: ChannelMessage,
    sessionKey: string,
    agentId: string,
    content: string,
  ): Promise<void> {
    try {
      const channelReply: ChannelReply = {
        channel: msg.channel,
        conversationId: msg.conversationId,
        content,
        replyToId: msg.id,
      };
      const hookCtx: HookContext = { sessionId: sessionKey, agentId };
      const sendBlock = await this.pluginManager.runHook<{ cancel?: boolean } | null>(
        'message_sending',
        { ...hookCtx, reply: channelReply },
        null,
      );
      if (sendBlock?.cancel) return;
      const adapter = this.channels.get(msg.channel);
      if (adapter && channelReply.content) {
        await adapter.send(channelReply);
      }
    } catch (err) {
      console.warn(
        `[Gateway] late channel reply failed (session=${sessionKey}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleSessionTitleUpdate(sessionId: string): void {
    if (this.titleUpdatePromises.has(sessionId)) {
      this.titleUpdatePending.add(sessionId);
      return;
    }
    const run = async (): Promise<void> => {
      try {
        await maybeUpdateSessionTitle(sessionId, {
          load: (id) => this.store.load(id),
          patchMetadata: (id, mutate) => this.patchSessionMetadata(id, mutate),
          providers: this.providers,
          modelLevels: this.modelLevels,
          resolveFallback: (session) => this.resolveTitleModelRef(session),
          onTitleUpdated: (id, title, titleSource, agentId) =>
            this.broadcastSessionUpdated(id, title, titleSource, agentId),
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
    agentId?: string,
  ): void {
    this.broadcastSessionMeta(sessionId, { title, titleSource }, agentId);
  }

  /** 会话展示元数据变更广播（title / pinnedAt 等），消费方按需取键 */
  private broadcastSessionMeta(sessionId: string, data: Record<string, unknown>, agentId?: string): void {
    this.broadcastSessionEvent('session.updated', sessionId, data, agentId);
  }

  /** 会话级广播（session.updated / session.removed），消费方按 type 与 data 取义 */
  private broadcastSessionEvent(
    type: string,
    sessionId: string,
    data: Record<string, unknown>,
    agentId?: string,
  ): void {
    const event = {
      type,
      sessionId,
      timestamp: Date.now(),
      ...(agentId ? { agentId } : {}),
      data: { sessionId, updatedAt: Date.now(), ...data },
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(sessionId, event, agentId);
    }
  }

  async createSession(options: { agentId: string; sessionId?: string; metadata?: Record<string, unknown> }): Promise<SessionMeta> {
    const agent = this.agents.get(options.agentId);
    if (!agent) {
      throw new Error(`Agent "${options.agentId}" not found`);
    }

    // sessionId 缺省则生成；未对传入值做 Windows 非法字符清洗（缺清洗为既有风险，另行处理）
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
   * 查找 session（sessionId 一等；无需遍历 agent）
   */
  private async findSession(sessionId: string): Promise<SessionData | null> {
    return this.store.load(sessionId);
  }

  /** 中止标记锚点 = 某 turn 的用户输入：开轮信封（含 wake 等机器输入），或定形前的裸用户输入 */
  private isTurnInput(msg: Message | undefined): boolean {
    return (
      !!msg &&
      msg.role === 'user' &&
      (isTurnStartContent(msg.content) || isTurnAnchor(msg))
    );
  }

  async getSessionView(sessionId: string, _agentId?: string): Promise<{
    meta: SessionMeta;
    messageCount: number;
    turnCount: number;
    taskCount?: number;
    abortedTurn?: { userMessageIndex: number; at?: number };
    /** 最近一次 LLM 调用的上下文用量（runner 持久化；UI 重开会话恢复显示） */
    contextTokens?: number;
    contextWindow?: number;
  } | null> {
    const session = await this.store.load(sessionId);
    if (!session) return null;
    const raw = session.metadata?.abortedTurn as
      | { userMessageIndex: number; at?: number }
      | undefined;
    let abortedTurn: { userMessageIndex: number; at?: number } | undefined;
    if (raw && typeof raw.userMessageIndex === 'number') {
      const idx = raw.userMessageIndex;
      const msg = session.messages[idx];
      // 过期判定（正向口径）：只有开轮信封（turn_start）才计「新轮已盖过」。
      // 引擎载体（turn_end / runStopped…）与 schedule notify（role=user 但不开轮）
      // 不得据此判标记过期；开轮路径必打 turn_start 信封（runner.bakeTurnStart 无条件定形）
      let hasNewerTurn = false;
      if (msg) {
        for (let i = idx + 1; i < session.messages.length; i++) {
          const later = session.messages[i];
          if (later.role === 'user' && isTurnStartContent(later.content)) {
            hasNewerTurn = true;
            break;
          }
        }
      }
      // 被标记的下标本身必须是该 turn 的用户输入（开轮信封，或 abort 抢在定形前的裸输入）：
      // legacy/损坏标记（指向载体或 notify）暴露出去会让截断点切错位置，重发叠出重复用户轮
      if (this.isTurnInput(msg) && !hasNewerTurn) {
        abortedTurn = raw;
      }
    }
    const metaContextTokens = session.metadata?.contextTokens;
    const metaContextWindow = session.metadata?.contextWindow;
    return {
      meta: session.meta,
      messageCount: session.messages.length,
      turnCount: session.turns.length,
      taskCount: session.tasks?.length ?? 0,
      abortedTurn,
      contextTokens: typeof metaContextTokens === 'number' ? metaContextTokens : undefined,
      contextWindow: typeof metaContextWindow === 'number' ? metaContextWindow : undefined,
    };
  }

  /**
   * 编辑重发准备：从 `fromIndex` 起截断（含），丢掉被中止轮的用户输入与残片。
   * 调用方随后用 sendChat 发送编辑后的用户消息（同会话，不建分支）。
   *
   * 与 Runner.handle 共 sessionLease，避免与 in-flight 写回竞态。
   */
  async truncateMessagesFrom(sessionId: string, fromIndex: number): Promise<{
    messageCount: number;
    fileEffects: import('@octopi-agent/engine').DiscardFileEffectsResult;
  }> {
    const release = await this.sessionLease.acquire(sessionId);
    try {
      const session = await this.store.load(sessionId);
      if (!session) {
        throw new Error(`Session "${sessionId}" not found`);
      }
      // 仅服务「最后一轮进行中 → 回到本轮起点」；效应是整轮 discard，不是按 index 定点回滚
      const aborted = session.metadata?.abortedTurn as
        | { userMessageIndex?: number }
        | undefined;
      const allowed = aborted && typeof aborted.userMessageIndex === 'number'
        ? aborted.userMessageIndex
        : undefined;
      if (allowed === undefined || fromIndex !== allowed) {
        throw new Error(
          `edit_resend_only_last_aborted_turn: fromIndex must equal abortedTurn.userMessageIndex`,
        );
      }
      if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > session.messages.length) {
        throw new Error(`fromIndex out of range: ${fromIndex}`);
      }
      // 与 view 同口径的写路径守卫：截断锚点必须是该 turn 的用户输入。
      // legacy/损坏的 abortedTurn 元数据可能指向引擎载体/notify，切在错误位置会把
      // 真正的中止残片留在历史里，重发叠出重复用户轮
      const anchor = session.messages[fromIndex];
      if (!this.isTurnInput(anchor)) {
        throw new Error(
          `edit_resend_only_last_aborted_turn: abortedTurn anchor is not a turn user message`,
        );
      }
      session.messages = session.messages.slice(0, fromIndex);
      // 租约下标必须随 messages 重写收缩，否则下一轮 LLM 窗口被裁空
      if (typeof session.contextDetachIndex === 'number') {
        session.contextDetachIndex = Math.min(session.contextDetachIndex, fromIndex);
      }
      session.meta.updatedAt = Date.now();
      // abortedTurn 是 metadata 键：save 浅合并删不掉，必须 updateMetadata
      await this.store.save(sessionId, session);
      await this.patchSessionMetadata(sessionId, (meta) => {
        delete meta.abortedTurn;
      });
      // L3: edit-resend reverses this turn's agent file effects (user hand-edits survive)
      const { discardSessionFileUndo } = await import('@octopi-agent/engine');
      const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
      const { join } = await import('node:path');
      const agentId = session.primaryAgentId ?? session.agentId;
      const memoryRestorer = this.memoryRestorers.get(agentId);
      const fileEffects = await discardSessionFileUndo(
        join(getOctopiHome(), 'sessions'),
        sessionId,
        memoryRestorer,
      );
      return { messageCount: session.messages.length, fileEffects };
    } finally {
      release();
    }
  }

  /**
   * 会话任务列表（只读，供 UI）
   */
  async getSessionTasks(sessionId: string, _agentId?: string): Promise<SessionData['tasks']> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    return (session.tasks ?? []).map((t) => ({ ...t }));
  }

  /** 会话日程列表（只读投影，arch/session-schedules.md P2） */
  async getSessionSchedules(
    sessionId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const items = this.sessionSchedules?.list(sessionId, { activeOnly: false }) ?? [];
    return items.map((s) => ({
      id: s.id,
      sessionId: s.sessionId,
      kind: s.kind,
      status: s.status,
      nextFireAt: s.nextFireAt,
      fireAt: s.fireAt,
      intervalMs: s.intervalMs,
      cron: s.cron,
      runCount: s.runCount,
      maxRuns: s.maxRuns,
      title: s.payload.title,
      prompt: s.payload.text,
      delivery: s.payload.delivery,
      catchUp: s.catchUp,
      coalesceKey: s.coalesceKey,
      createdAt: s.createdBy.at,
      createdByRunId: s.createdBy.runId,
      lastFireAt: s.lastFireAt,
      lastError: s.lastError,
    }));
  }

  /** 日程控制：cancel / pause / resume */
  async controlSchedule(
    sessionId: string,
    scheduleId: string,
    action: 'cancel' | 'pause' | 'resume',
    reason?: string,
  ): Promise<Record<string, unknown>> {
    if (!this.sessionSchedules) {
      throw new Error('SessionScheduleService not ready');
    }
    const existing = this.sessionSchedules.get(scheduleId);
    if (!existing || existing.sessionId !== sessionId) {
      throw new Error(`Schedule not found in session: ${scheduleId}`);
    }
    const next =
      action === 'cancel'
        ? this.sessionSchedules.cancel(scheduleId, reason)
        : action === 'pause'
          ? this.sessionSchedules.pause(scheduleId)
          : this.sessionSchedules.resume(scheduleId);
    return {
      id: next.id,
      status: next.status,
      nextFireAt: next.nextFireAt,
      runCount: next.runCount,
    };
  }

  async getSessionMessages(
    sessionId: string,
    options: {
      limit: number;
      cursor?: string;
      agentId?: string;
      /** backward = 从末尾向前取页（打开会话默认）；forward = 从头向后 */
      direction?: 'forward' | 'backward';
    },
  ): Promise<{
    messages: Array<Message & { index: number }>;
    nextCursor?: string;
    total: number;
    hasMore: boolean;
    /** 在途 Run 现场快照（盲窗 overlay）：未定形的流式正文 / running 工具；Run 不活跃缺省 */
    live?: import('../protocols/live-run-tracker.js').LiveRunOverlay;
  }> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const live = this.collectLiveRun(sessionId);

    const total = session.messages.length;
    const decodeCursor = (c: string): number => Number(Buffer.from(c, 'base64').toString('utf-8'));
    const encodeCursor = (n: number): string => Buffer.from(String(n)).toString('base64');

    if (options.direction === 'backward') {
      // cursor = 本页的 exclusive end 下标；缺省 = 末尾
      const end = options.cursor ? decodeCursor(options.cursor) : total;
      const safeEnd = Number.isFinite(end) ? Math.min(Math.max(end, 0), total) : total;
      const start = Math.max(0, safeEnd - options.limit);
      const slice = session.messages.slice(start, safeEnd);
      return {
        messages: slice.map((m, i) => ({ ...m, index: start + i })),
        nextCursor: start > 0 ? encodeCursor(start) : undefined,
        total,
        hasMore: start > 0,
        ...(live ? { live } : {}),
      };
    }

    const offset = options.cursor ? decodeCursor(options.cursor) : 0;
    const safeOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0;
    const slice = session.messages.slice(safeOffset, safeOffset + options.limit);
    const nextOffset = safeOffset + slice.length;
    return {
      messages: slice.map((m, i) => ({ ...m, index: safeOffset + i })),
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : undefined,
      total,
      hasMore: nextOffset < total,
      ...(live ? { live } : {}),
    };
  }

  /** 从流式 adapter 聚合在途 Run 现场（盲窗 overlay）；无流式 adapter 或 Run 不活跃返回 undefined */
  private collectLiveRun(sessionId: string): import('../protocols/live-run-tracker.js').LiveRunOverlay | undefined {
    for (const adapter of this.streamingAdapters) {
      const live = adapter.getLiveRun?.(sessionId);
      if (live) return live;
    }
    return undefined;
  }

  /**
   * 从历史会话切出前缀，新建分支会话（Discourse 复制，不改原会话）。
   *
   * `beforeIndex` 为 session.messages 下标，新会话包含 `[0, beforeIndex)`，
   * **不含**下标 beforeIndex 那条（落在用户气泡上 = 不含该条）。
   */
  async branchSession(
    sessionId: string,
    options: { beforeIndex: number; agentId?: string },
  ): Promise<SessionMeta> {
    const src = await this.store.load(sessionId);
    if (!src) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const beforeIndex = options.beforeIndex;
    if (!Number.isInteger(beforeIndex) || beforeIndex < 0 || beforeIndex > src.messages.length) {
      throw new Error(`beforeIndex out of range: ${beforeIndex}`);
    }

    const agentId = options.agentId ?? src.primaryAgentId ?? src.agentId;
    const newSessionId = `${agentId}-branch-${Date.now()}`;
    const now = Date.now();
    const prefix = src.messages.slice(0, beforeIndex).map((m) => ({ ...m }));

    const { readSessionCompact, writeSessionCompact } = await import(
      '@octopi-agent/engine/harness/session/compact.js'
    );
    const compactSnap = readSessionCompact(src, agentId);

    const session: SessionData = {
      id: newSessionId,
      agentId: src.agentId,
      primaryAgentId: src.primaryAgentId ?? src.agentId,
      preferredAgentId: src.preferredAgentId,
      meta: {
        id: newSessionId,
        agentId: src.agentId,
        channelId: src.meta.channelId ?? 'web',
        peerId: src.meta.peerId ?? 'web-ui',
        status: 'idle',
        createdAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
        updatedAt: now,
      },
      messages: prefix,
      turns: [],
      // 不复制 tasks / clientToolCalls / fileReleases / 附件体；只留溯源
      metadata: {
        parentSessionId: sessionId,
        branchFromIndex: beforeIndex,
        branchedAt: now,
      },
      tasks: [],
    };
    // compact 作前缀种子（E4：写到新 session 键下，不借用）
    if (compactSnap) {
      writeSessionCompact(session, agentId, compactSnap);
    }

    await this.store.save(newSessionId, session);
    return session.meta;
  }

  async getMemoryStats(): Promise<Record<string, unknown> | null> {
    // 预留：当前 Gateway 未持有 MemoryStore，返回 null 表示未配置。
    return null;
  }

  // ── Knowledge 源注册（OCTOPI_HOME/knowledge/knowledge.db）──

  /** 会话附件服务（OP-15；懒加载） */
  private attachmentServicePromise?: Promise<
    import('@octopi-agent/engine/harness/session/attachments/service.js').SessionAttachmentService
  >;

  /**
   * 会话附件服务（OCTOPI_HOME/sessions/&lt;sid&gt;/attachments）
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
   * DocumentPort（documents.extract.enabled === false 时为 null）
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
   * 上传会话附件（JSON + base64 或 utf8 文本）
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
   * 删除单条会话附件（若已 make-searchable 则顺带 purge Knowledge source）
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
   * 归入项目：移动到项目 directory 源（OP-15 promote）
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
    // 若有抽取伴生且不同名，一并移动
    if (item.extractPath && item.extractPath !== item.path) {
      const fromExtract = join(svc.attachmentRoot(sessionId), item.extractPath);
      const toExtract = join(destDir, item.extractPath);
      try {
        await rename(fromExtract, toExtract);
      } catch {
        // 伴生缺失不阻断 promote
      }
    }
    const marked = await svc.markPromoted(sessionId, attachmentId, {
      projectKey: opts.projectKey,
      targetSourceId: target.id,
    });
    return { attachment: marked, targetPath: to };
  }

  /**
   * 附件升为可检索：注册 scopeRef=session 的 Knowledge source 并 ingest
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
   * 解析 chat 消息附件指针（TriggerAttachmentRef）
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
   * Knowledge Service 运行时（懒启动 manageLocal 或远程 baseUrl）。
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
   * v2：Gateway **不再直接**打开 knowledge.db；写/读一律经 Knowledge Service。
   * 保留方法名仅作兼容编译面，调用应改为 getKnowledgeClient()。
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
      // 仍尝试调用，失败由上层降级
    }
    return client;
  }

  /** SSE → WS 转发（knowledge.index.progress）；幂等 */
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
   * 知识源列表 —— 经 Knowledge Service
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
   * 注册知识源 —— 经 Knowledge Service
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
   * 更新知识源 —— 经 Knowledge Service
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
   * 卸载知识源 —— 经 Knowledge Service（解绑 + purge）
   */
  async removeKnowledgeSource(id: string): Promise<boolean> {
    const client = await this.getKnowledgeClient();
    await client.deleteSource(id);
    return true;
  }

  /**
   * Project 挂载 / Global 屏蔽 —— 经 Knowledge Service（可选）
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
   * Knowledge 注册表统计 —— 经 Knowledge Service
   */
  async getKnowledgeStats(agentId: string): Promise<Record<string, number>> {
    const client = await this.getKnowledgeClient();
    await client.ensurePrincipal(agentId).catch(() => undefined);
    const stats = await client.stats(agentId);
    return stats as unknown as Record<string, number>;
  }

  /**
   * 项目登记视图（先建项目再挂源）
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
   * 源下索引文件列表 —— 经 Knowledge Service
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
   * 重做文件：强制重新解析/分块/向量
   *
   * @param sourceId - 源 id
   * @param opts.paths - 指定路径；或
   * @param opts.filter - 按当前列表筛选批量
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

  /** 路径级任务/文件状态（重做完成跟踪） */
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
   * 按路径列 chunk（管理面预览）
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
   * 宿主直搜（管理面试搜；effective view）—— Knowledge Service
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
   * 会话视图 overlay —— 经 Knowledge Service
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
   * Agent 级 base 可见性摘要（排查辅视图；不含会话 overlay）
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
   * 提升候选（阈值当前为 hit-log 代码内默认；knowledge.promotion.metrics 配置面未接线）
   */
  async getKnowledgePromotionCandidates(): Promise<
    import('@octopi-agent/engine/harness/knowledge/hit-log.js').PromotionCandidate[]
  > {
    const client = await this.getKnowledgeClient();
    return (await client.promotionCandidates()) as import('@octopi-agent/engine/harness/knowledge/hit-log.js').PromotionCandidate[];
  }

  /**
   * v2：ingest 移入 Knowledge Service 内；Gateway 不再持有
   */
  async getKnowledgeIngest(): Promise<never> {
    throw new Error('knowledge_disabled: ingest runs in Knowledge Service');
  }

  /**
   * 触发源索引 —— 经 Knowledge Service 委派；HTTP 即刻返回 indexing，不等待整库 parse 完成（大目录会挂住请求且与 UI 轮询读库争用）。
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
   * 手动知识索引任务（abort）—— 经 Knowledge Service
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
   * /继续索引（resume）—— 经 Knowledge Service
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
      // 兜底：若本源已无队列（增量小文件）可立即描述；否则等 onSourceSettled
      await this.maybeAutoDescribe(sourceId);
    } catch {
      /* describe 失败不影响索引 */
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

  /** 有可用 LLM 时构造 describe 端口；无则走启发式 */
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
   * 读取会话最近一次七层装配快照（产品 Context 面板）
   *
   * 所有权：Gateway Map = 产品路径（与 observer.level 无关，始终写入）；
   * ObserverHub 在 observer 开启时另行快照（Run 观测）。
   *
   * @param sessionId - 会话 id
   * @returns 快照；尚未装配过则为 null
   */
  getSessionContextLayers(sessionId: string): ContextLayersSnapshot | null {
    return this.lastContextLayers.get(sessionId) ?? null;
  }

  /**
   * 产品 Observer Hub（Run 观测）
   */
  getObserverHub(): ObserverHub {
    return this.observerHub;
  }

  /**
   * 会话最近一次 Run 观测投影
   *
   * @param sessionId - 会话 id
   * @returns RunObservatorySnapshot；无记录或面板关闭时 null
   */
  getSessionRunObservatory(sessionId: string): RunObservatorySnapshot | null {
    return this.observerHub.getRunObservatory(sessionId);
  }

  /**
   * Run messages 快照（摘要 + 配置允许时的全文）
   *
   * @param sessionId - 会话 id
   * @param options - phase / runId
   * @returns 快照或 null
   */
  getSessionRunMessages(
    sessionId: string,
    options?: { phase?: 'entry' | 'final' | 'llm'; runId?: string; view?: 'workspace' | 'llm' },
  ): RunMessagesSnapshot | null {
    return this.observerHub.getRunMessages(sessionId, options);
  }

  /**
   * 读取 Agent 七层数据面健康（store 计数）
   *
   * 优先：已 build 的 contextHealth probe
   * 回退：按 agent.home 直接扫 skills / agent.db（不依赖懒构建）
   *
   * @param agentId - Agent id
   * @returns 健康快照
   */
  async getAgentContextHealth(agentId: string): Promise<import('@octopi-agent/engine/harness/context/layer-health.js').ContextLayerHealth> {
    const cached = this.agentCache.get(agentId);
    if (cached?.contextHealth) {
      return cached.contextHealth(agentId);
    }
    const def = this.agents.get(agentId);
    if (def?.home) {
      const { probeAgentHomeHealth } = await import('@octopi-agent/engine/harness/context/layer-health.js');
      return probeAgentHomeHealth(agentId, expandHomePath(def.home.trim()));
    }
    const { probeContextLayerHealth } = await import('@octopi-agent/engine/harness/context/layer-health.js');
    return probeContextLayerHealth({ agentId, personaLoaded: false });
  }

  /**
   * 产品 Context 面板路径：始终写入 Map（与 observer.level 无关）。
   *
   * Observer Hub 采样归 **Runner.emitObserved**（以及 Builder ContextEngine emit 回调）；
   * Gateway **不要**再 `hub.ingestEvent`，否则 timeline/lifecycle 会双计。
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

  listPendingApprovals(sessionId?: string): PendingApprovalView[] {
    const all = Array.from(this.pendingApprovals.values());
    return sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
  }

  /**
   * 挂起审批并等待 UI 作答（SEC-7 唯一确认通道）。
   * 无人值守 / 取消 → deny（fail-closed）。
   */
  requestApproval(input: {
    sessionId: string;
    agentId: string;
    request: Omit<PendingApprovalRequest, 'id'>;
    timeoutMs?: number;
  }): Promise<HitlDecision | import('@octopi-agent/core/types/tools.js').ConfirmOutcome> {
    const id = randomUUID();
    const timeoutMs = input.timeoutMs ?? 120_000;
    const createdAt = Date.now();
    const view: PendingApprovalView = {
      id,
      sessionId: input.sessionId,
      agentId: input.agentId,
      request: { ...input.request, id },
      status: 'pending',
      createdAt,
      // 决策截止 = 引擎确认窗（timeoutMs）；窗口一关，迟到点击只记 rejected/late——
      // 审批账本与 ops 审计（confirm_timeout）必须是同一个故事
      deadlineAt: timeoutMs > 0 ? createdAt + timeoutMs : undefined,
    };
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (
        decision: HitlDecision | import('@octopi-agent/core/types/tools.js').ConfirmOutcome,
      ) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.approvalResolvers.delete(id);
        resolve(decision);
      };
      this.pendingApprovals.set(id, view);
      this.approvalResolvers.set(id, finish);
      // 先广播再淘汰：淘汰只会删更旧的条目，不会波及刚插入的 view
      this.broadcastApprovalEvent(view);
      this.evictOldApprovals(id);
      // ops P5 双通道：gateway 事件（上方广播）+ webhook 推送（失败只告警，另一通道仍在）
      this.notifyHitlWebhook(view, timeoutMs);
      if (timeoutMs > 0) {
        // 到点即 settle deny（fail-closed）；deadlineAt 同一时刻，之后的点击只会得到 rejected/late。
        // 与引擎 askWithTimeout 同值：本进程定时器按注册序触发，引擎侧先注册必先定案，
        // 故超时标签永远如实是 confirm_timeout，不会被 gateway 的 deny 抢标
        timer = setTimeout(() => {
          const pending = this.pendingApprovals.get(id);
          if (pending && pending.status === 'pending') {
            pending.status = 'rejected';
            pending.decisionReason = 'timeout';
            pending.decidedAt = Date.now();
            pending.updatedAt = pending.decidedAt;
            this.broadcastApprovalEvent(pending);
          }
          // 超时 ≠ 人工拒绝：带 reason 回给引擎（effect 通道无引擎窗，靠它如实标注）
          finish({ decision: 'deny', reason: 'timeout' });
        }, timeoutMs);
        // 不阻塞进程退出；resolver 命中时 timer 成为 no-op
        timer.unref?.();
      }
    });
  }

  resolvePendingApproval(
    approvalId: string,
    input: {
      action: 'approve' | 'reject';
      scope?: ApprovalScope;
      reason?: string;
      /** ops P5：谁批的（宿主归因；未知缺省） */
      approver?: string;
      /** ops P5：经哪条通道（缺省 gateway；webhook 回执标 webhook） */
      channel?: 'gateway' | 'webhook';
    },
  ): PendingApprovalView | null {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval || approval.status !== 'pending') return null;

    const now = Date.now();
    // 迟到决策（引擎确认窗已关）：如实记 rejected/late 并记录点击者，绝不补记 approved——
    // 否则审批账本说「批了」而 ops 审计说 confirm_timeout，两个故事（正是要治的病）
    if (approval.deadlineAt !== undefined && now > approval.deadlineAt) {
      approval.status = 'rejected';
      approval.decisionReason = 'late';
      approval.decidedAt = now;
      approval.updatedAt = now;
      approval.decidedBy = input.approver;
      approval.decisionChannel = input.channel ?? 'gateway';
      const lateFinish = this.approvalResolvers.get(approvalId);
      this.approvalResolvers.delete(approvalId);
      lateFinish?.('deny');
      this.broadcastApprovalEvent(approval);
      return approval;
    }
    const scope: ApprovalScope =
      input.action === 'approve' ? (input.scope ?? 'once') : 'once';
    approval.status = input.action === 'approve' ? 'approved' : 'rejected';
    approval.decisionReason = input.reason;
    approval.decisionScope = input.action === 'approve' ? scope : undefined;
    approval.decidedAt = now;
    approval.updatedAt = now;
    // 确认人身份入账（P5）：谁批的、经哪条通道——与决策一起定格
    approval.decidedBy = input.approver;
    approval.decisionChannel = input.channel ?? 'gateway';

    const decision: HitlDecision =
      input.action !== 'approve'
        ? 'deny'
        : scope === 'session'
          ? 'approve_session'
          : scope === 'always'
            ? 'approve_always'
            : 'approve';
    const finish = this.approvalResolvers.get(approvalId);
    this.approvalResolvers.delete(approvalId);
    finish?.({
      decision,
      approver: input.approver,
      channel: approval.decisionChannel,
    });
    this.broadcastApprovalEvent(approval);
    return approval;
  }

  /**
   * ops P5 双通道之 webhook：把待确认推送到 owner 侧端点（HMAC-SHA256 签名）。
   * 失败只告警——gateway 通道（WS 广播 + `/approvals`）仍在；两通道全失时靠超时 deny 兜底。
   */
  private notifyHitlWebhook(view: PendingApprovalView, timeoutMs: number): void {
    const hook = this.config.hitlWebhook;
    if (!hook?.url) return;
    const body = JSON.stringify({
      approvalId: view.id,
      sessionId: view.sessionId,
      agentId: view.agentId,
      request: view.request,
      deadlineAt: Date.now() + timeoutMs,
      decide: {
        method: 'POST',
        path: `/api/v1/approvals/${view.id}`,
        fields: ['action', 'scope', 'approver'],
        note: 'set channel=webhook on the decision so the approver is attributed to this channel',
      },
    });
    void fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(hook.secret
          ? {
              'x-octopi-signature': `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}`,
            }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      console.warn(
        `[Gateway] HITL webhook notify failed (${view.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** 会话结束时取消未决审批（fail-closed deny） */
  cancelPendingApprovals(sessionId: string): void {
    for (const [id, a] of this.pendingApprovals) {
      if (a.sessionId !== sessionId || a.status !== 'pending') continue;
      const now = Date.now();
      a.status = 'rejected';
      a.decisionReason = 'cancelled';
      a.decidedAt = now;
      a.updatedAt = now;
      const finish = this.approvalResolvers.get(id);
      this.approvalResolvers.delete(id);
      // 取消 ≠ 人工拒绝：带来源标注（引擎据此如实报 aborted，不冒充人工拒绝）
      finish?.({ decision: 'deny', reason: 'cancelled' });
      this.broadcastApprovalEvent(a);
    }
  }

  /** 丢掉该 session 的 HITL session-scope 缓存（always 保留） */
  private clearHitlSessionCache(sessionId: string): void {
    defaultHitlCache.clearSession(sessionId);
  }

  /** 进程退出：全部未决审批 / 问题 fail-closed */
  private cancelAllPendingHitl(): void {
    for (const sessionId of new Set(
      [...this.pendingApprovals.values(), ...this.pendingQuestions.values()].map((x) => x.sessionId),
    )) {
      this.cancelPendingApprovals(sessionId);
      this.cancelPendingQuestions(sessionId);
    }
  }

  /**
   * 淘汰超额审批。`keepId` 为刚插入的条目，永不淘汰。
   * 被淘汰的 pending 会标 rejected + 广播，避免 UI 残卡。
   */
  private evictOldApprovals(keepId: string): void {
    const MAX_APPROVALS = 256;
    if (this.pendingApprovals.size <= MAX_APPROVALS) return;
    const terminal = [...this.pendingApprovals.values()]
      .filter((a) => a.status !== 'pending')
      .sort((a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt));
    for (const a of terminal) {
      if (this.pendingApprovals.size <= MAX_APPROVALS) break;
      this.pendingApprovals.delete(a.id);
    }
    if (this.pendingApprovals.size > MAX_APPROVALS) {
      const oldest = [...this.pendingApprovals.values()]
        .filter((a) => a.status === 'pending' && a.id !== keepId)
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const a of oldest) {
        if (this.pendingApprovals.size <= MAX_APPROVALS) break;
        const now = Date.now();
        a.status = 'rejected';
        a.decisionReason = 'evicted';
        a.decidedAt = now;
        a.updatedAt = now;
        this.pendingApprovals.delete(a.id);
        const finish = this.approvalResolvers.get(a.id);
        this.approvalResolvers.delete(a.id);
        // 取消 ≠ 人工拒绝：带来源标注（同上）
        finish?.({ decision: 'deny', reason: 'cancelled' });
        this.broadcastApprovalEvent(a);
      }
    }
  }

  private broadcastApprovalEvent(approval: PendingApprovalView): void {
    const event = {
      type: approval.status === 'pending' ? 'approval.pending' : 'approval.resolved',
      sessionId: approval.sessionId,
      agentId: approval.agentId,
      timestamp: Date.now(),
      data: { approval },
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(approval.sessionId, event, approval.agentId);
    }
  }

  // ================================================================
  // ask_user：pending questions（工具等待用户回答）
  // ================================================================

  listPendingQuestions(sessionId?: string): PendingQuestionView[] {
    const all = Array.from(this.pendingQuestions.values());
    return sessionId ? all.filter((q) => q.sessionId === sessionId) : all;
  }

  /**
   * 把 ask_user 挂成 pending question，并等待 UI 作答。
   * 供 daemon / builder 注入 AskUserCallback 使用。
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
    // 先注册 waiter 再广播：emitEvent 同步跑 listener，
    // 若 listener 在事件里立即 resolvePendingQuestion，resolver 必须已在位
    return new Promise<string>((resolve) => {
      this.pendingQuestions.set(id, view);
      this.questionResolvers.set(id, resolve);
      this.evictOldQuestions();
      this.broadcastQuestionEvent(view);
    });
  }

  /** 用户作答：标记 answered 并唤醒等待中的 ask_user */
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
   * 会话中止时取消未答问题，避免工具悬挂。
   * status 记 cancelled（非用户作答）；工具侧应视为 abort/error，不得当用户回答。
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
      // 哨兵唤醒：工具侧识别为取消，不当作用户回答
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
    // 极端情况：全是 pending 也硬删最旧（不碰 resolver，避免误唤醒）
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
      agentId: question.agentId,
      timestamp: Date.now(),
      data: { question },
    } as unknown as AgentEvent;
    this.emitEvent(event);
    for (const adapter of this.streamingAdapters) {
      adapter.broadcastEvent(question.sessionId, event, question.agentId);
    }
  }

  // ================================================================
  // Client Tools（arch/client-tools.md）
  // ================================================================

  /**
   * 客户端上报能力；新 tool 进入 tool 面。
   */
  registerClientTools(input: {
    sessionId: string;
    clientInstanceId: string;
    platform?: string;
    principalId?: string;
    descriptors: ClientToolDescriptor[];
  }): { toolNames: string[] } {
    return this.clientTools.registerClientTools(input);
  }

  /** 客户端下线；无 provider 的 tool 移出 tool 面 */
  unregisterClientTools(input: {
    sessionId: string;
    clientInstanceId: string;
  }): { removedNames: string[] } {
    return this.clientTools.unregisterClientTools(input);
  }

  /** 已 release 文件列表（不含字节）；重启后自动 hydrate */
  async listSessionFileReleases(sessionId: string) {
    return (await this.fileReleases.listSessionReleases(sessionId)).map((r) => ({
      fileId: r.fileId,
      name: r.name,
      mime: r.mime,
      sizeBytes: r.sizeBytes,
      sourcePathDisplay: r.sourcePathDisplay,
      sourceKind: r.sourceKind,
      toolName: r.toolName,
      createdAt: r.createdAt,
    }));
  }

  /** 文件内容下发（Range 头）；未授权返回 null */
  async getSessionFileContent(
    sessionId: string,
    fileId: string,
    options?: { rangeHeader?: string; clientInstanceId?: string },
  ) {
    return this.fileReleases.readContent(sessionId, fileId, options);
  }

  async listClientToolCalls(sessionId: string): Promise<ClientToolCall[]> {
    await this.ensureStore();
    const live = this.clientTools.listSessionCalls(sessionId);
    const recent = this.clientTools.listRecentTerminalCalls(sessionId);
    const seen = new Set(live.map((c) => c.id).concat(recent.map((c) => c.id)));
    let stored: ClientToolCall[] = [];
    try {
      const session = await this.store.load(sessionId);
      const raw = session?.metadata?.clientToolCalls;
      if (Array.isArray(raw)) {
        stored = (raw as ClientToolCall[]).filter((c) => c?.id && !seen.has(c.id));
      }
    } catch {
      // 历史不可读时只返回内存中的 call
    }
    return [...live, ...recent, ...stored];
  }

  private async persistClientToolCall(call: ClientToolCall): Promise<void> {
    await this.patchSessionMetadata(call.sessionId, (meta) => {
      const key = 'clientToolCalls';
      const prev = Array.isArray(meta[key]) ? (meta[key] as ClientToolCall[]) : [];
      const record: ClientToolCall = { ...call };
      const html = record.args?.html;
      if (typeof html === 'string' && html.length > 64 * 1024) {
        record.args = {
          ...record.args,
          html: `${html.slice(0, 2048)}…[${html.length} chars, assetId=${record.assetId ?? 'n/a'}]`,
        };
      }
      const next = prev.filter((c) => c.id !== record.id).concat(record);
      meta[key] = next.slice(-200);
    });
  }

  /**
   * 会话 metadata 原子读改写（含删键）。
   * 与 JsonlSessionStore.updateMetadata 对齐；长驻 run 的 store.save 不得覆盖这些键。
   */
  private async patchSessionMetadata(
    sessionId: string,
    mutate: (meta: Record<string, unknown>) => void,
  ): Promise<void> {
    await this.ensureStore();
    const update = this.store.updateMetadata?.bind(this.store);
    if (update) {
      await update(sessionId, mutate);
      return;
    }
    // 老 store 无 updateMetadata：退化为串行 load-modify-save（metadata 合并仍由 save 保证）
    await this.withSessionMetadata(sessionId, (session) => {
      const meta = session.metadata ?? (session.metadata = {});
      mutate(meta);
    });
  }

  /** session.metadata 读改写串行（按 sessionId），避免 load→save 丢更新 */
  private async withSessionMetadata(
    sessionId: string,
    mutate: (session: SessionData) => void,
  ): Promise<void> {
    await this.ensureStore();
    const prev = this.sessionMetaQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const session = await this.store.load(sessionId);
      if (!session) return;
      mutate(session);
      await this.store.save(sessionId, session);
    });
    this.sessionMetaQueues.set(
      sessionId,
      next.catch(() => {}),
    );
    await next;
  }

  getClientToolCall(callId: ClientToolCallId): ClientToolCall | undefined {
    return this.clientTools.getCall(callId);
  }

  listSessionClientTools(sessionId: string): ReturnType<ClientToolHost['listSessionTools']> {
    return this.clientTools.listSessionTools(sessionId);
  }

  /** UI/设备提交结果 */
  resolveClientToolCall(
    callId: ClientToolCallId,
    outcome: ClientToolCallOutcome,
    completedByPrincipalId?: string,
  ): ClientToolCall | null {
    return this.clientTools.resolveCall(callId, outcome, completedByPrincipalId);
  }

  /** 客户端心跳（在线性续期） */
  heartbeatClientTools(input: {
    sessionId: string;
    clientInstanceId: string;
  }): { alive: boolean } {
    return this.clientTools.heartbeat(input);
  }

  // Client Stream（arch/client-tools.md §15.1；Host 通道，非 LLM API）
  openClientStream(input: {
    direction: 'source' | 'sink';
    sessionId: string;
    clientInstanceId: string;
    toolName?: string;
    sampleHint?: string;
    maxDurationMs?: number;
  }): ClientStreamChannel {
    return this.clientStreamTransport.open(input);
  }

  writeClientStreamSamples(
    streamId: string,
    samples: ClientStreamSampleInput[],
  ): boolean {
    return this.clientStreamTransport.writeSamples(streamId, samples);
  }

  closeClientStream(streamId: string, reason?: string): ClientStreamChannel | null {
    return this.clientStreamTransport.close(streamId, reason);
  }

  listClientStreams(sessionId: string): ClientStreamChannel[] {
    return this.clientStreamTransport.list(sessionId);
  }

  getClientStream(streamId: string): ClientStreamChannel | undefined {
    return this.clientStreamTransport.get(streamId);
  }

  /** 把动态 client tool 同步进已 build 的 Agent（E5 下同 session 串行，无需锁 tool 列表） */
  private syncClientToolsToAgents(
    ops: Array<{ op: 'add'; tool: RegisteredTool } | { op: 'remove'; name: string }>,
  ): void {
    const visibility = this.clientTools.createVisibilityFilter();
    for (const { agent } of this.agentCache.values()) {
      agent.setToolVisibilityFilter(visibility);
      if (ops.length === 0) continue;
      const current = agent.tools;
      let next = [...current];
      for (const op of ops) {
        if (op.op === 'add') {
          next = next.filter((t) => t.name !== op.tool.definition.name);
          next.push(registeredToolToAgentTool(op.tool));
        } else {
          next = next.filter((t) => t.name !== op.name);
        }
      }
      agent.setTools(next);
    }
  }

  // ================================================================
  // 核心消息处理
  // ================================================================

  async send(message: ChannelMessage): Promise<void> {
    await this.handleInboundMessage(message);
  }

  getSession(sessionId: string): SessionMeta | undefined {
    // 历史 stub：实现已随 store 迁移移除，恒返 undefined（真源在 Knowledge Service / sessions 面）
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

    // 2b. 对话内 /xxx 命令（Intent Ingress）：先于 dispatch；/stop 可抢占
    // 确保 user/skill 命令已装载（热路径兜底；start() 已装载）
    await this.ensureCommandSources();
    let inboundContent = msg.content;
    {
      const view = this.buildSessionReadView(sessionKey, agent.id);
      // 尽力补全 model（异步读 store）
      try {
        const session = await this.store.load(sessionKey);
        const modelMeta = session?.metadata?.model as { provider?: string; model?: string } | undefined;
        if (modelMeta?.model) {
          view.model = modelMeta.provider
            ? `${modelMeta.provider}/${modelMeta.model}`
            : modelMeta.model;
        }
      } catch {
        // view.model 可缺省
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
        }, (msg.metadata?.agentId as string | undefined) ?? agent.id);

        // prompt 展开：继续进 Loop
        if (result.enterLoop && result.messages?.length) {
          const joined = result.messages.map((m) => m.content).join('\n\n');
          inboundContent = joined;
        } else {
          // control / client / 错误：不进 Loop。
          // 合成 turn.end 作终态；**禁止**带 error:true（Loop 语义会把 UI 打回 waiting）
          this.broadcastCommandTurnEnd(
            sessionKey,
            result.display.text,
            result.display.type,
            (msg.metadata?.agentId as string | undefined) ?? agent.id,
          );

          // IM 短回复（Telegram 等无 WS 事件流的渠道）
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
              // IM 发送失败不影响已广播的 command_result
            }
          }
          return;
        }
      } else {
        inboundContent = outcome.content;
      }
    }

    // 3. 获取或构建 Agent + SessionAwareRunner，并注册进 Runtime
    let cached = this.agentCache.get(agent.id);
    if (!cached) {
      cached = await this.buildAgent(agent);
      this.agentCache.set(agent.id, cached);
    }
    const { runner } = cached;

    // 确保 Runtime 已注册该 agent 的 dispatcher
    if (!this.runtime.listAgents().some((a) => a.agentId === agent.id)) {
      await this.registerRuntimeAgent(agent, runner);
    }

    // 4–5. 经激活宿主执行（模型 A）；onEvent 做流式广播（不变量 #6）
    let finalContent = '';
    // steered（插话进活跃 Run）：回复晚于 dispatch 返回，由事件转发触发晚到发送（评审 F3）
    let steeredDelivery = false;
    let steeredReplySent = false;
    // 会话附件指针（OP-15）：metadata.attachmentIds → Trigger.attachments
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
        onDelivery: (delivery) => {
          if (delivery === 'steered' || delivery === 'followup') steeredDelivery = true;
        },
      },
      resolveAgentId: () => agent.id,
      resolveSessionId: () => sessionKey,
      onEvent: (event) => {
        // WS 已由 runtime.run.event 统一广播；这里只采集频道最终回复。
        if (event.type === 'turn.end' && event.data?.content) {
          const isError = (event.data as { error?: boolean } | undefined)?.error === true;
          // 失败尝试的 partial 不是回答：不得当最终回复外发（10-27 事故形态）
          if (!isError) {
            finalContent = event.data.content as string;
            // steered 消息的回答晚于 dispatch 返回：首个终态 turn 恰好发一次（评审 F3）
            const phase = (event.data as { phase?: string } | undefined)?.phase;
            if (steeredDelivery && !steeredReplySent && phase !== 'pre_tools' && finalContent) {
              steeredReplySent = true;
              void this.sendLateChannelReply(msg, sessionKey, agent.id, finalContent);
            }
          }
        }
        // 彻底失败的提示统一由下方 dispatchResult.status==='failed' 分支兜底：
        // 抛异常路径的 engine.error 不进事件流（onEvent 看不到），在此设哨兵会漏
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
      // 失败提示无条件覆盖正文：pre_tools 中间话术 / 部分成功正文都不得冒充最终回答
      //（engine.error 路径经 P1 已返回 status='failed'，抛异常路径同样落此分支）
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

    // 7. 发送回复（steered 的回复由晚到通道恰好发一次，这里不重复）
    const adapter = this.channels.get(msg.channel);
    if (!steeredDelivery && adapter && channelReply.content) {
      await adapter.send(channelReply);
      await this.pluginManager.runAllHooks('message_sent', { ...hookCtx, reply: channelReply });
    }
  }

  private async registerRuntimeAgent(
    agent: AgentDefinition,
    runner: SessionAwareRunner,
  ): Promise<void> {
    // 仅内联 persona 写入 defaults；文件式 persona 由 runner 的 resolver 每轮解析
    const runSystemPrompt =
      typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '';
    let contextWindow = agent.model.contextWindow;
    if (!contextWindow) {
      const provider = this.providers.get(agent.model.provider);
      contextWindow = provider?.getModelInfo(agent.model.model)?.contextWindow;
    }

    this.runtime.registerAgent({
      agentId: agent.id,
      dispatcher: this.wrapInflightTracking(
        runner,
        new SessionRunnerDispatcher({
          runner,
          redispatch: (trigger, options) => this.runtime.dispatch(trigger, options),
          // 不要把 agent 默认 model 写入 defaults：
          // RunConfig.model 只表示**消息级**覆盖；会话覆盖在 session.metadata.model
          runConfigDefaults: {
            agentId: agent.id,
            contextWindow,
            systemPrompt: runSystemPrompt,
          },
        }),
      ),
      resolveSession: (trigger) => trigger.sessionId ?? `${agent.id}:main`,
    });
  }

  /**
   * 包装 dispatcher：execute 期间维护 runner 的 in-flight run 计数。
   * 退役 runner 的 dispose 判据即此计数归零（拍板①：在跑 run 用旧构建跑完）。
   *
   * @param runner - 计数归属的 runner
   * @param inner - 原 dispatcher
   * @returns 包装后的 dispatcher（结构兼容 RunDispatcher）
   */
  private wrapInflightTracking(
    runner: SessionAwareRunner,
    inner: SessionRunnerDispatcher,
  ): SessionRunnerDispatcher {
    const tracker = this;
    return {
      inbox: inner.inbox,
      execute(req: Parameters<SessionRunnerDispatcher['execute']>[0], signal?: AbortSignal) {
        tracker.runnerInflight.set(runner, (tracker.runnerInflight.get(runner) ?? 0) + 1);
        const iter = inner.execute(req, signal);
        return (async function* () {
          try {
            yield* iter;
          } finally {
            // 完成 / 抛错 / 消费端提前 return 均收敛计数
            tracker.runnerInflight.set(runner, (tracker.runnerInflight.get(runner) ?? 1) - 1);
          }
        })();
      },
    } as unknown as SessionRunnerDispatcher;
  }

  /**
   * 获取或惰性创建委派编排运行时（arch/delegation.md §7/§14）。
   *
   * notify 通道的接收端（AgentSignalSource）默认随委派接线补挂，
   * 与 notifier 同源（gatewayBus）同生命周期；显式 agentSignal:false 时退化为
   * poll + 状态提示兜底。
   *
   * 任一 agent 声明了 delegation 策略才创建；否则返回 undefined，
   * 不为未使用委派的部署付出开销。
   *
   * @returns 委派运行时；无 agent 声明委派策略时为 undefined
   */
  private async ensureDelegationRuntime(): Promise<
    | import('@octopi-agent/engine/harness/collaboration/delegation/wiring.js').DelegationRuntime
    | undefined
  > {
    if (this.delegationRuntime) return this.delegationRuntime;
    // 首建合流：并发 buildAgent 共用一次创建（防双 runtime / 重复挂工具）；
    // 「无委派 agent」的结果不缓存，后续 agent 到达时重新判定
    if (!this.delegationRuntimePromise) {
      this.delegationRuntimePromise = this.wireDelegationRuntime()
        .then((rt) => {
          if (!rt) this.delegationRuntimePromise = undefined;
          return rt;
        })
        .catch((err) => {
          this.delegationRuntimePromise = undefined;
          throw err;
        });
    }
    return this.delegationRuntimePromise;
  }

  /** ensureDelegationRuntime 的实际构建（并发入口已由 promise 合流） */
  private async wireDelegationRuntime(): Promise<
    import('@octopi-agent/engine/harness/collaboration/delegation/wiring.js').DelegationRuntime | undefined
  > {
    // 先取模块：effectiveDelegationPolicy 在守卫里就要用
    const { createDelegationRuntime, effectiveDelegationPolicy } = await import(
      '@octopi-agent/engine/harness/collaboration/delegation/wiring.js'
    );

    // 委派**缺省默认开启**（arch/delegation.md §9.2）；只有全部 agent 显式关闭才不接线
    const anyDelegating = [...this.agents.values()].some(
      (a) => effectiveDelegationPolicy(a.delegation).canDelegate,
    );
    if (!anyDelegating) {
      if (!this.delegationSkippedLogged) {
        this.delegationSkippedLogged = true;
        const declared = [...this.agents.values()].map((a) => ({
          id: a.id,
          delegation: a.delegation ?? null,
        }));
        console.log(
          '[Gateway] Delegation tools NOT attached (no agent declares `delegation.canDelegate`). ' +
            'Enable by adding to octopi.json → agents[].delegation: ' +
            '{ "callable": true, "canDelegate": true, "maxDepth": 1 } ' +
            `(current agents: ${JSON.stringify(declared)})`,
        );
      }
      return undefined;
    }

    // notify 推送依赖接收端 AgentSignalSource；默认随委派接线补挂。
    // 显式 agentSignal:false 或挂载失败时不装 notifier——发进无人监听总线的通知
    // 不能被误标已送达（那正是曾经的断链故障），退化为 poll + 状态提示兜底。
    let notifyPush = !this.agentSignalPushDisabled;
    if (!notifyPush) {
      console.warn(
        '[Gateway] Delegation wired but notify push DISABLED (agentRuntime.agentSignal=false): ' +
          'results surface via delegate_get/delegate_list or the <delegation_status> hint only',
      );
    } else {
      try {
        await this.ensureAgentSignalSource();
      } catch (err) {
        notifyPush = false;
        console.warn(
          '[Gateway] AgentSignalSource mount failed, delegation notify push off (poll + hint fallback): ' +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    this.delegationRuntime = createDelegationRuntime({
      events: this.gatewayBus,
      notifyPush,
      maxActiveDelegationsPerSession: this.config.delegation?.maxActiveDelegationsPerSession,
    });
    console.log(
      notifyPush
        ? '[Gateway] Delegation runtime wired (shared gatewayBus, notify push on)'
        : '[Gateway] Delegation runtime wired (notify push off: poll + hint fallback)',
    );
    return this.delegationRuntime;
  }

  /**
   * 为 Agent 构建 Agent + SessionAwareRunner（新架构）
   */
  private async buildAgent(agent: AgentDefinition): Promise<{
    agent: import('@octopi-agent/engine/harness/run/agent/index.js').Agent;
    runner: SessionAwareRunner;
    contextEngine?: import('@octopi-agent/engine/harness/context/types.js').ContextEngine;
    contextHealth?: (agentId?: string) => Promise<import('@octopi-agent/engine/harness/context/layer-health.js').ContextLayerHealth>;
    registerTools: (tools: import('@octopi-agent/engine').RegisteredTool[]) => void;
  }> {
    // 获取主 provider，并解析 agent 默认模型快照（含熔断包装）
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

    // 命名 provider 同样包 circuit breaker：wire 的 providers 映射喂 ProviderPool 与
    // 子系统 provider/model 解析，必须与主 provider 同等待遇，不得绕过熔断
    const wrappedProviders = new Map<string, import('@octopi-agent/core/interfaces/model-provider.js').ModelProvider>();
    for (const [name, p] of this.providers) {
      wrappedProviders.set(name, wrapProviderWithCircuitBreaker(p, this.getCircuitBreaker(name)));
    }

    // 如果配置了 fallbackModels，构建 FallbackProvider（回退 provider 也包装 circuit breaker）
    let finalProvider: import('@octopi-agent/core/interfaces/model-provider.js').ModelProvider = wrappedProvider;
    if (agent.model.fallbackModels && agent.model.fallbackModels.length > 0) {
      const { FallbackProvider } = await import('@octopi-agent/engine/harness/run/reliability/fallback-provider.js');
      finalProvider = new FallbackProvider(
        wrappedProvider,
        agent.model.model,
        agent.model.fallbackModels,
        wrappedProviders,
        {
          attemptTtftTimeoutMs: this.config.modelCallFallbackAttemptTtftMs,
          attemptChatTimeoutMs: this.config.modelCallFallbackChatAttemptMs,
          degradeTtlMs: this.config.modelCallFallbackDegradeTtlMs,
        },
      );
      console.log(`[Gateway] Agent "${agent.id}" fallback chain: ${[agent.model.model, ...agent.model.fallbackModels.map(f => f.model)].join(' ?')}`);
    }

    // ── 标准组装（与 config-bridge 同源）+ 宿主适配 ──
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
    const {
      wireAgentBuilder,
      resolveSecurityConfig,
    } = await import('@octopi-agent/engine/harness/agent/wire-agent-builder.js');

    const builder = new AgentBuilder()
      .store(this.store)
      .events(this.gatewayBus);

    // F3/D5：observability 配置 → 观测装配（trace 落盘 + 采集意图）
    const { wireObservability } = await import('@octopi-agent/engine/config.js');
    await wireObservability(builder, this.config.observability, { filePrefix: agent.id });

    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
    const pathJoinForAttachments = join;

    const wired = await wireAgentBuilder(builder, {
      model: finalProvider,
      agentId: agent.id,
      workspace: agent.workspace,
      home: agent.home,
      persona:
        typeof agent.persona === 'object' && agent.persona?.systemPrompt
          ? { systemPrompt: agent.persona.systemPrompt }
          : typeof agent.persona === 'string'
            ? agent.persona
            : undefined,
      skillDirectory: agent.skillDirectory,
      tools: agent.tools,
      maxSessionRights: agent.maxSessionRights,
      effectPolicy:
        (agent as { effectPolicy?: import('@octopi-agent/engine').EffectPolicyConfig }).effectPolicy ??
        this.config.effectPolicy,
      toolIsolation: this.config.toolIsolation,
      sessionIdleExpiryMs: this.config.session?.idleExpiryMs,
      modelCallTimeouts:
        this.config.modelCallIdleTimeoutMs !== undefined ||
        this.config.modelCallAbsoluteTimeoutMs !== undefined
          ? {
              idleTimeoutMs: this.config.modelCallIdleTimeoutMs,
              absoluteTimeoutMs: this.config.modelCallAbsoluteTimeoutMs,
            }
          : undefined,
      providers: wrappedProviders,
      levelMap: this.config.levels,
      modelsConfig: {
        providers: this.config.modelProviders,
        embedding: this.config.embedding,
      },
      contextEngineConfig: this.config.contextEngine,
      contextAssemblerConfig:
        this.config.context?.contextAssembler ?? this.config.contextAssembler,
      constitutionConfig:
        this.config.context?.constitution ?? this.config.constitution,
      memoryConfig: this.config.memory,
      cognitionConfig: this.config.cognition,
      wisdomConfig: this.config.wisdom,
      securityConfig: resolveSecurityConfig({ security: this.config.security }),
      budgetConfig: this.config.budgetPolicy,
      runGuardConfig: this.config.runGuard,
      subsystemAuditDir: this.config.subsystems?.auditDir,
      subsystemAllowlist: this.config.subsystems?.allowlist,
      subsystemDenylist: this.config.subsystems?.denylist,
      concurrencyConfig: this.config.concurrency,
      extraRunnerConfig: {
        // ops P2：安全配置漂移守卫（daemon 锚定；漂移拒新 run）
        securityIntegrity: this.config.securityIntegrity,
        sessionLease: this.sessionLease,
        sessionAcl: this.sessionAcl,
        sessionScheduleService: this.sessionSchedules,
        requireCredentialBindings: this.config.credentials?.requireBindings === true,
        observerHub: this.observerHub.isEnabled() ? this.observerHub : undefined,
        sessionsDir: pathJoinForAttachments(getOctopiHome(), 'sessions'),
        sessionAttachmentInject: {
          fullTextMaxChars: this.config.knowledge?.attachments?.inject?.fullTextMaxChars,
          intent: this.config.knowledge?.attachments?.inject?.intent,
          intentTimeoutMs: this.config.knowledge?.attachments?.inject?.intentTimeoutMs,
          emptyMessagePrompt: this.config.knowledge?.attachments?.inject?.emptyMessagePrompt,
        },
      },
      errorStrategy: {
        onModelError: (error: { reason: string; message: string }, attempt: number) => {
          const retryable = ['rate_limit', 'timeout', 'network', 'server'];
          if (retryable.includes(error.reason) && attempt < 3) {
            const delayMs = (attempt + 1) * (error.reason === 'rate_limit' ? 1000 : 2000);
            return { action: 'retry' as const, delayMs };
          }
          return { action: 'abort' as const, reason: error.message };
        },
        onToolError: () => ({ action: 'skip' as const, reason: 'Tool failed' }),
        onContextOverflow: () => ({ action: 'compact' as const }),
        onSecurityViolation: (v: { description: string }) => ({
          action: 'block' as const,
          reason: v.description,
        }),
      },
    });

    // ── 宿主适配：user commands / knowledge / tools / approval ──
    // skill 发现已由 wireAgentBuilder 完成（唯一 discover 出口）
    if (wired.skillManager) {
      this.registerSkillCommands(
        wired.skillManager as import('@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/types.js').SkillManager,
      );
    }
    if (agent.home) {
      try {
        this.registerUserCommands(agent.id, join(agent.home, 'commands'));
      } catch (err) {
        console.warn(`[Gateway] user command load failed for agent "${agent.id}": ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const { resolveEmbeddingRuntime } = await import('@octopi-agent/engine/harness/memory/sqlite/embedding-from-models.js');
        const embRuntime = resolveEmbeddingRuntime({
          providers: this.config.modelProviders ?? {},
          embedding: this.config.embedding,
        });
        if (wired.memoryStore) {
          const { createMemoryRestorer } = await import('@octopi-agent/engine');
          this.memoryRestorers.set(
            agent.id,
            createMemoryRestorer(wired.memoryStore as never),
          );
        }
        try {
          const agentIdForCatalog = agent.id;
          const kn = this.config.knowledge;
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
              maxEntries: kn?.catalog?.maxEntries,
              groupByScope: kn?.catalog?.groupByScope,
              showProgress: kn?.catalog?.showProgress,
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
          console.log('[Gateway] memory embedding not configured → keyword retrieval');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Gateway] context stores unavailable for agent "${agent.id}": ${msg}`);
      }
    }

    console.log(`[Gateway] Building agent "${agent.id}" with ${this.tools.length} global tools: ${this.tools.map(t => t.definition.name).join(', ')}`);
    for (const tool of this.tools) {
      const name = tool.definition.name;
      if (name === 'memory_store' || name === 'memory_search') continue;
      try {
        builder.tool(tool);
      } catch (err) {
        console.warn(
          `[Gateway] tool register failed (${name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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

    builder.confirmEffect(async (intent) => {
      const { getRunScope } = await import('@octopi-agent/engine/harness');
      const scope = getRunScope();
      // 无 run scope ≠ 人工拒绝：带来源标注回给引擎（错误面不得冒充人工拒绝）
      if (!scope?.sessionId) return { decision: 'deny', reason: 'no_session_scope' };
      const sessionId = scope.sessionId;
      const agentId = scope.agentId ?? 'default';
      const desc =
        intent.kind === 'shell'
          ? `shell: ${String(intent.command ?? '').slice(0, 120)}`
          : intent.kind === 'file.write'
            ? `write ${intent.path} (${intent.mode ?? 'overwrite'})`
            : (intent.description ?? intent.kind);
      return this.requestApproval({
        sessionId,
        agentId,
        request: {
          kind: 'effect',
          toolName: intent.kind,
          arguments: {
            path: intent.path,
            command: intent.command,
            mode: intent.mode,
            cwd: intent.cwd,
            domain: intent.domain,
            description: intent.description,
          },
          riskLevel: intent.kind === 'shell' ? 'high' : 'medium',
          riskDescription: desc,
          actionDescription: desc,
        },
        // 引擎确认窗原样作为卡片决策截止（deadlineAt）与 settle 时刻——引擎 askWithTimeout
        // 先注册必先定案，超时标签如实是 confirm_timeout；窗口后的点击只得 rejected/late
        ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
      });
    });

    builder.confirmHighRisk(async (req) => {
      if (!req.sessionId) return 'deny';
      const sessionId = req.sessionId;
      const agentId = req.agentId ?? 'default';
      const toolName = req.toolCall?.name ?? 'tool';
      const args = (req.toolCall?.arguments ?? {}) as Record<string, unknown>;
      const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
      const outcome = await this.requestApproval({
        sessionId,
        agentId,
        request: {
          kind: 'high_risk',
          toolName,
          arguments: args,
          riskLevel: normalizeRiskLevel(req.severity),
          riskDescription: req.reason,
          actionDescription: purpose ? `${toolName}: ${purpose}` : toolName,
        },
      });
      // high_risk 契约只认决策；确认人归因随审批记录走（PendingApprovalView）
      return typeof outcome === 'string' ? outcome : outcome.decision;
    });

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

    // ── Run 级模型快照解析（方案 B 唯一入口）──
    // 每 run 调一次；provider 缺失返回 null，Runner 回退 Agent 实例默认
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

    // 会话任务事件 → WebSocket（UI 只读实时面板）
    const forwardTaskEvent = (event: { sessionId?: string; type: string; data?: unknown; agentId?: string }) => {
      if (!event.sessionId) return;
      for (const adapter of this.streamingAdapters) {
        adapter.broadcastEvent(event.sessionId, event as any, event.agentId);
      }
    };
    for (const type of ['session.task.created', 'session.task.updated', 'session.task.snapshot']) {
      built.events.on(type, forwardTaskEvent);
    }

    // Client Tool 会话可见性：无 live client 的 tool 不进该 session 的 LLM tool 面
    built.agent.setToolVisibilityFilter(this.clientTools.createVisibilityFilter());

    // 委派编排（arch/delegation.md §7/§14）：惰性构建，attach 后该 agent 可被委派/可发委派。
    // notify 通道：接收端 AgentSignalSource 默认随委派接线补挂（ensureDelegationRuntime），
    // 与 notifier 同源同生命周期；显式 agentSignal:false 时退化为 poll + 状态提示。
    (await this.ensureDelegationRuntime())?.attach({
      agentId: agent.id,
      agent: built.agent,
      runner: built.runner,
      store: this.store,
      traits: agent.traits,
      delegation: agent.delegation,
      persona: typeof agent.persona === 'string' ? agent.persona : undefined,
      registerTools: built.registerTools,
    });

    return {
      agent: built.agent,
      runner: built.runner,
      contextEngine: built.contextEngine,
      contextHealth: built.contextHealth,
      registerTools: built.registerTools,
    };
  }

  private resolveAgent(msg: ChannelMessage): AgentDefinition | undefined {
    // 显式寻址优先（WebUI 侧栏选中的 agent / 触发器指定 agent）：metadata.agentId
    // 命中注册表即用——否则向导新建的 agent 永远被 channelBindings/fallback 遮蔽（#14）。
    const explicitId = msg.metadata?.agentId as string | undefined;
    if (explicitId) {
      const explicit = this.agents.get(explicitId);
      if (explicit) return explicit;
    }
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
    // 使用消息中的原始 agentId（而非 Gateway 解析后的 agent.id）
    // 这样 sessionKey 和 WS session 的 agentId 一致，broadcastEvent 能正确匹配
    const agentId = (msg.metadata?.agentId as string) ?? agent.id;

    // 优先使用客户端传来的 sessionId（WebUI 通过 REST API 创建的 session）
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
        // listener 错误不应中断流程
      }
    }
  }

  /**
   * 获取或创建 provider 熔断器
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
   * 获取所有熔断器状态
   */
  getCircuitBreakerStatus(): Record<string, { state: string; failureCount: number }> {
    const result: Record<string, { state: string; failureCount: number }> = {};
    for (const [name, cb] of this.circuitBreakers) {
      result[name] = cb.snapshot();
    }
    return result;
  }
}

/**
 * WS 广播前剥离 context.layers.assembled 里的层正文 content
 *
 * Gateway 缓存/REST 仍保留全文；UI 点选层时经 REST 拉取。
 * preview 保留在 WS，便于未点选时浏览摘要。
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
