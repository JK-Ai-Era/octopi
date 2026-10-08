/**
 * AgentBuilder — Fluent API 组装器
 *
 * 集成方的主要入口。一行代码启动 Agent。
 *
 * 使用示例：
 * ```ts
 * const { engine, runner } = new AgentBuilder()
 *   .model('gpt-5.5')
 *   .persona('./personas/my-agent')
 *   .tool(myTool)
 *   .budget({ maxIterations: 15 })
 *   .build();
 * ```
 */

import type {

  RegisteredTool,
  Message,
  ToolCall,
} from '@octopi-agent/core/types.js';
import { DefaultToolBus } from '../extension/plugin-ecosystem/tools/tool-bus.js';
import type {
  ModelProvider,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type {
  AgentTool as LoopAgentTool,
} from '@octopi-agent/core/loop/types.js';
import { Agent } from '../run/agent/index.js';
import type { AgentOptions } from '../run/agent/index.js';
import { DEFAULT_RELIABILITY_CONFIG } from '../run/reliability/run-agent.js';
import type { ReliabilityConfig, ReliabilityHarness } from '../run/reliability/run-agent.js';
import type {
  ContextEngine,
  SummarizeFunction,
} from '../context/types.js';
import type {
  ErrorStrategy,
  ClassifiedError,
  ErrorAction,
  OverflowAction,
} from '@octopi-agent/core/interfaces/error-strategy.js';
import type { SecurityViolation, SecurityAction } from '@octopi-agent/core/security-guard.js';
import type {
  RunGuard,
} from '@octopi-agent/core/interfaces/run-guard.js';
import type { RunGuardConfig } from '../run/run-guard/default-run-guard.js';
import { DefaultRunGuard } from '../run/run-guard/default-run-guard.js';
import type {
  Observer,
} from '@octopi-agent/core/interfaces/observer.js';
import { summarizeLlmMessages } from '../observability/observer/types.js';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';
import { SessionTaskService } from '../session/tasks/service.js';
import { createSessionTaskTools } from '../session/tasks/tools.js';
import type { SessionData } from '../session/types.js';
import { InMemorySessionStore } from '../session/in-memory-store.js';

import {
  DefaultEventBus,
} from '@octopi-agent/core/primitives/event-bus.js';
import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import {
  DefaultSecurityGuard,
} from '../governance/security/default-security-guard.js';
import type { SecurityGuard, SecurityGuardConfig } from '@octopi-agent/core/security-guard.js';
import {
  BudgetPolicyEngine,
} from '../run/budget/budget.js';
import type { BudgetPolicyConfig } from '../run/budget/budget.js';

import { PersonaSource } from './persona.js';
import { getRunScope } from '../run/run-scope.js';
import { DefaultContextEngine } from '../context/default-context-engine.js';
import { createProviderSummarize } from '../context/summarize.js';
import { createDefaultSystemPromptAssembler } from '../context/system-prompt-assembler.js';
import { SessionAwareRunner } from '../run/runner.js';
import type { SessionAwareRunnerConfig } from '../run/runner.js';
import { DefaultMcpManager } from '../extension/plugin-ecosystem/mcp/manager.js';
import type { McpManagerCallbacks, McpClientFactory } from '../extension/plugin-ecosystem/mcp/manager.js';
import type { McpServerConfig, McpManager } from '../extension/plugin-ecosystem/mcp/types.js';

// ── 默认实现 ──

/** 默认错误策略（简单重试 + 中止） */
class DefaultErrorStrategy implements ErrorStrategy {
  onModelError(error: ClassifiedError, attempt: number): ErrorAction {
    // ── 可重试错误：限流、超时、网络、服务端 ──
    if (error.reason === 'rate_limit' && attempt < 3) {
      const delayMs = error.retryAfterMs ?? (attempt + 1) * 1000;
      return { action: 'retry', delayMs };
    }
    if (error.reason === 'timeout' && attempt < 3) {
      return { action: 'retry', delayMs: (attempt + 1) * 1000 };
    }
    if (error.reason === 'network' && attempt < 3) {
      return { action: 'retry', delayMs: (attempt + 1) * 1500 };
    }
    if (error.reason === 'server' && attempt < 2) {
      return { action: 'retry', delayMs: (attempt + 1) * 2000 };
    }
    // ── context_length：由引擎尝试 compact，这里返回 abort 让引擎决定 ──
    if (error.reason === 'context_length') {
      return { action: 'abort', reason: `Context length exceeded: ${error.message}` };
    }
    // ── 不可重试错误：认证、计费 ──
    if (error.reason === 'auth') {
      return { action: 'abort', reason: `Authentication failed: ${error.message}` };
    }
    if (error.reason === 'billing') {
      return { action: 'abort', reason: `Billing issue: ${error.message}` };
    }
    // ── 默认：终止 ──
    return { action: 'abort', reason: error.message };
  }

  onToolError(error: ClassifiedError, _call: any): ErrorAction {
    // 工具错误默认跳过，让 LLM 看到错误信息后自行调整
    return { action: 'skip', reason: error.message || 'Tool execution failed' };
  }

  onContextOverflow(_tokenCount: number, _limit: number): OverflowAction {
    return { action: 'compact' };
  }

  onSecurityViolation(violation: SecurityViolation): SecurityAction {
    if (violation.severity === 'critical') {
      return { action: 'block', reason: violation.description };
    }
    return { action: 'warn', reason: violation.description };
  }
}


/** 工具运行时上下文提供者 */
export interface ToolContextProvider {
  get(): {
    sessionId: string;
    agentId: string;
    messages: import('@octopi-agent/core/types.js').Message[];
    cwd?: string;
    attachmentRoots?: string[];
  };
  setRuntime(sessionId: string, agentId: string, messages: import('@octopi-agent/core/types.js').Message[]): void;
}

class RuntimeToolContextProvider implements ToolContextProvider {
  private sessionId = '';
  private agentId = '';
  private messages: import('@octopi-agent/core/types.js').Message[] = [];
  private cwd?: string;

  constructor(defaults?: { cwd?: string }) {
    this.cwd = defaults?.cwd?.trim() ? defaults.cwd : undefined;
  }

  setRuntime(sessionId: string, agentId: string, messages: import('@octopi-agent/core/types.js').Message[]): void {
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.messages = messages;
  }

  get() {
    // I1：优先 RunScope ALS（并发 session 下不可依赖单槽 setRuntime）
    const scope = getRunScope();
    if (scope?.toolRuntime) {
      return {
        sessionId: scope.toolRuntime.sessionId,
        agentId: scope.toolRuntime.agentId,
        messages: scope.toolRuntime.messages,
        cwd: scope.toolRuntime.cwd ?? this.cwd,
        attachmentRoots: scope.toolRuntime.attachmentRoots,
      };
    }
    if (scope) {
      return {
        sessionId: scope.sessionId,
        agentId: scope.agentId,
        messages: this.messages,
        cwd: this.cwd,
      };
    }
    return { sessionId: this.sessionId, agentId: this.agentId, messages: this.messages, cwd: this.cwd };
  }
}

/**
 * 将 RegisteredTool 转换为 AgentTool（新循环格式）
 */
function convertToAgentTool(tool: RegisteredTool, contextProvider: ToolContextProvider): LoopAgentTool {
  return {
    name: tool.definition.name,
    description: tool.definition.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.definition.parameters).map(([key, param]) => [
          key,
          { type: param.type, description: param.description, ...(param.enum && { enum: param.enum }) },
        ]),
      ),
      required: Object.entries(tool.definition.parameters)
        .filter(([, param]) => param.required)
        .map(([key]) => key),
    },
    execute: async (toolCallId: string, args: unknown, signal?: AbortSignal) => {
      const startTime = Date.now();
      try {
        const context = contextProvider.get();
        const result = await tool.handler(args as Record<string, unknown>, { ...context, abortSignal: signal });
        return {
          toolCallId,
          name: tool.definition.name,
          content: result,
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

// ── Builder ──

/** ModelProvider 未声明 contextWindow 时的默认窗口（产品默认 200k） */
/**
 * 配置层历史常量。禁止用作引擎运行时 contextWindow 预算（未声明 = 未知）。
 */
import { DEFAULT_CONTEXT_WINDOW } from '@octopi-agent/core/types/model-info.js';
export { DEFAULT_CONTEXT_WINDOW };

// ── Build options / result ──

export interface AgentBuildOptions {
  /**
   * `full`（默认）：agent + runner + 子系统装配
   * `core`：仅 Agent + harness + mcpManager
   */
  mode?: 'full' | 'core';
  /**
   * 是否自动发现并加载子系统目录。full 模式默认 true；core 模式不装配子系统。
   * 注册范围用 subsystemAllowlist / subsystemDenylist 过滤。
   */
  autoLoadSubsystems?: boolean;
  /**
   * 允许注册的子系统 id / packageId / `memory.steward.*` 前缀列表。
   * 未设置 = 不限制。
   */
  subsystemAllowlist?: string[];
  /**
   * 禁止注册的子系统 id / packageId / 前缀。与 allowlist 同时出现时 deny 优先。
   */
  subsystemDenylist?: string[];
  /** 子系统搜索目录覆盖 */
  subsystemDirs?: {
    builtin?: string;
    user?: string;
    project?: string;
    npm?: string;
  };
}

/** 按允许/禁止列表判断子系统是否可注册；deny 优先；支持 packageId 与 `id`/`id.*` 前缀 */
export function isSubsystemAllowed(
  id: string,
  allowlist?: string[],
  denylist?: string[],
  packageId?: string,
): boolean {
  const match = (list: string[] | undefined, key: string, pkg?: string): boolean => {
    if (!list || list.length === 0) return false;
    return list.some((entry) => {
      if (!entry) return false;
      if (entry === key) return true;
      if (pkg && entry === pkg) return true;
      if (entry.endsWith('.*') && key.startsWith(entry.slice(0, -1))) return true;
      if (entry.endsWith('*') && !entry.endsWith('.*') && key.startsWith(entry.slice(0, -1))) return true;
      return false;
    });
  };
  if (match(denylist, id, packageId)) return false;
  if (allowlist && allowlist.length > 0 && !match(allowlist, id, packageId)) return false;
  return true;
}

export interface AgentBuildCoreResult {
  agent: Agent;
  harness: ReliabilityHarness;
  mcpManager: McpManager;
  events: EventBus;
  contextEngine?: import('../context/types.js').ContextEngine;
  contextHealth?: (agentId?: string) => Promise<import('../context/layer-health.js').ContextLayerHealth>;
}

export interface AgentBuildResult {
  agent: Agent;
  harness: ReliabilityHarness;
  runner: SessionAwareRunner;
  mcpManager: McpManager;
  /** 子系统运行时（memory.steward.* 等）；无子系统时为 undefined */
  runtime?: import('../collaboration/autonomous-subsystem/runtime.js').SubsystemRuntime;
  events: EventBus;
  /** ContextEngine 实例（手动压缩入口） */
  contextEngine?: import('../context/types.js').ContextEngine;
  contextHealth: (agentId?: string) => Promise<import('../context/layer-health.js').ContextLayerHealth>;
}

/** 缺省子系统搜索：cwd + 包根（兼容 src 开发态与 dist 发布态） */
async function defaultSubsystemSearchDirs(override?: AgentBuildOptions['subsystemDirs']): Promise<{
  builtin?: string;
  user?: string;
  project?: string;
  npm?: string;
}> {
  const { existsSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { homedir } = await import('node:os');

  const here = dirname(fileURLToPath(import.meta.url));
  // builder 在 <root>/src|dist/harness/agent/
  const pkgRoot = resolve(here, '../../..');
  const cwd = process.cwd();
  const sep = here.includes('\\') ? '\\' : '/';
  const runningFromDist = here.includes(`${sep}dist${sep}`) || here.endsWith(`${sep}dist`);

  const { readdirSync } = await import('node:fs');
  const hasLoadableSubsystem = (dir: string): boolean => {
    try {
      if (!existsSync(dir)) return false;
      return readdirSync(dir, { withFileTypes: true }).some((e) => {
        if (!e.isDirectory() || e.name.startsWith('.')) return false;
        const pkg = join(dir, e.name);
        if (existsSync(join(pkg, 'config.yaml')) || existsSync(join(pkg, 'SUBSYSTEM.md'))) {
          return true;
        }
        // 多 spec 包：子目录含 config/SUBSYSTEM.md
        try {
          return readdirSync(pkg, { withFileTypes: true }).some((c) => {
            if (!c.isDirectory() || c.name.startsWith('.') || c.name === 'shared' || c.name === 'lib') {
              return false;
            }
            const child = join(pkg, c.name);
            return existsSync(join(child, 'config.yaml')) || existsSync(join(child, 'SUBSYSTEM.md'));
          });
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  };

  const builtinCandidates = override?.builtin
    ? [override.builtin]
    : runningFromDist
      ? [
          resolve(pkgRoot, 'dist', 'subsystems'),
          join(here, '..', '..', 'subsystems'),
          resolve(cwd, 'dist', 'subsystems'),
          resolve(pkgRoot, 'src', 'subsystems'),
          resolve(cwd, 'src', 'subsystems'),
        ]
      : [
          resolve(cwd, 'src', 'subsystems'),
          resolve(pkgRoot, 'src', 'subsystems'),
          join(here, '..', '..', 'subsystems'),
          resolve(pkgRoot, 'dist', 'subsystems'),
          resolve(cwd, 'dist', 'subsystems'),
        ];

  // 选第一个「目录下至少有一个含 config.yaml / SUBSYSTEM.md 的子系统包」的路径
  let builtin: string | undefined;
  for (const candidate of builtinCandidates) {
    if (hasLoadableSubsystem(candidate)) {
      builtin = candidate;
      break;
    }
  }

  return {
    builtin,
    user: override?.user ?? join(homedir(), '.octopi', 'subsystems'),
    project: override?.project ?? join(cwd, '.octopi', 'subsystems'),
    npm: override?.npm ?? join(cwd, 'node_modules'),
  };
}

/** 缺省子系统搜索并加载 spec（供 build 自动发现与 serve 启动日志共用） */
export async function discoverSubsystemSpecs(override?: AgentBuildOptions['subsystemDirs']): Promise<{
  specs: import('../collaboration/autonomous-subsystem/types.js').SubsystemSpec[];
  errors: Array<{ path: string; error: string }>;
}> {
  const dirs = await defaultSubsystemSearchDirs(override);
  const { SubsystemLoader } = await import('../collaboration/autonomous-subsystem/loader.js');
  const loader = new SubsystemLoader({
    builtinDir: dirs.builtin,
    userDir: dirs.user,
    projectDir: dirs.project,
    npmDir: dirs.npm,
  });
  return loader.loadAll();
}

// wireMemoryExtraction 已移除：Memory Steward 取代 ETL（docs/memory.md）

export type { AgentTraceOptions } from '../observability/run-telemetry.js';
import type { AgentTraceOptions, RunTelemetry, RunTelemetryFactory } from '../observability/run-telemetry.js';
import { getRunTelemetryFactory } from '../observability/run-telemetry.js';

/**
 * AgentBuilder — Fluent API
 */
export class AgentBuilder {
  // Core 组件
  private _model?: ModelProvider;
  private _toolBus = new DefaultToolBus();
  private _contextEngine?: ContextEngine;
  private _summarize?: SummarizeFunction;
  /** 最新的 context 压力信息（由 convertToLlm 更新） */
  private _lastContextPressure?: { estimatedTokens: number; contextWindow?: number };
  /** 为 true 时禁止自动挂默认 summarize（测试/特殊场景） */
  private _disableAutoSummarize = false;
  private _events?: EventBus;
  private _security?: SecurityGuard;
  private _riskPolicy?: import('@octopi-agent/core/security-guard.js').ToolCallRiskPolicy;
  private _budget?: BudgetPolicyEngine;
  private _errorStrategy?: ErrorStrategy;
  private _confirmHighRisk?: NonNullable<import('@octopi-agent/core/interfaces/reliability.js').ReliabilityHarness['confirmHighRisk']>;
  private _observer?: Observer;
  private _runGuard?: RunGuard;
  private _runGuardConfig?: RunGuardConfig;
  private _checkpointInterval?: number;
  private _reliabilityConfig?: ReliabilityConfig;

  // Harness 组件
  private _personaWorkspaces: string[] = [];
  private _systemPrompt?: string;
  /** Skill 目录（SKILL.md）；build 时 discover 并注入 system prompt 索引 */
  private _skillDirectory?: string;
  private _skillManager?: import('../extension/plugin-ecosystem/skills/types.js').SkillManager;
  /** 记忆检索（注入 system prompt MemoryLayer） */
  private _memoryStore?: import('../memory/types.js').MemoryStore;
  private _backfillCoverage?: import('../memory/backfill-coverage.js').BackfillCoverageStore;
  private _constitutionConfig?: import('../../config.js').ConstitutionConfig | null;
  private _memoryConfig?: import('../../config.js').HarnessConfig['memory'];
  /** Knowledge Tier 0 catalog（system 注入「有哪些源」） */
  private _knowledgeCatalog?: import('../knowledge/catalog-types.js').KnowledgeCatalogProvider;
  private _knowledgeCatalogOpts?: {
    maxEntries?: number;
    groupByScope?: boolean;
    showProgress?: 'off' | 'bucket' | 'exact';
  };
  /** Knowledge 检索（P4 grounding + 工具） */
  private _knowledgeRetriever?: import('../knowledge/retriever.js').KnowledgeRetriever;
  private _knowledgeIndexStore?: import('../knowledge/index-store.js').KnowledgeIndexStore;
  private _knowledgeSourceStore?: import('../knowledge/source-store.js').KnowledgeSourceStore;
  private _knowledgeHitLog?: import('../knowledge/hit-log.js').KnowledgeHitLog;
  /** 独立 Service 路径：仅 grounding（工具走 client tools） */
  private _knowledgeGroundingPort?: import('../knowledge/retriever.js').AutoGroundPort;
  private _knowledgeGrounding?: {
    budgetTokens?: number;
    budgetRatio?: number;
    maxBudgetTokens?: number;
    maxChunks?: number;
    skipIfUserTokensBelow?: number;
    includePriorUserTurns?: number;
  };
  /** 智慧（注入 system prompt WisdomLayer） */
  private _wisdomStore?: import('../memory/types.js').WisdomStore;
  /** 认知图谱（注入 system prompt CognitionLayer） */
  private _cognitionStore?: import('../memory/types.js').ConceptGraphStore;
  /** system prompt 装配器调参 */
  private _contextAssemblerConfig?: {
    systemBudgetRatio?: number;
    /** 显式 system 预算 token（窗口未知时仍可用） */
    systemBudgetTokens?: number;
    /** 显式压缩目标 token（窗口未知时的手动/结构压缩目标） */
    compactTargetTokens?: number;
    includeLayerPreview?: boolean;
    layerPreviewChars?: number;
    includeLayerContent?: boolean;
    layerShares?: Partial<Record<import('../context/layer-types.js').ContextLayerId, number>>;
  };
  /** 文件式 persona 的 run 时解析器（指纹缓存，改文件下一轮生效） */
  private _personaResolver?: () => Promise<string>;
  /** build 时从磁盘读到的纯 persona（可能为空；不含默认 tools prompt） */
  private _initialPersonaContent?: string;
  private _securityConfig?: SecurityGuardConfig;

  /** 产品级观测采集意图（具体后端用 .observer() 或已注册 RunTelemetryFactory） */
  private _traceOptions?: AgentTraceOptions;
  /** 观测装配工厂（宿主注入；`octopi` 入口默认注册） */
  private _telemetryFactory?: RunTelemetryFactory;
  /** build 时装配出的观测句柄 */
  private _telemetry?: RunTelemetry;

  // Runner 配置
  private _store?: SessionStore<SessionData>;
  private _runnerConfig?: SessionAwareRunnerConfig;
  /** 产品 Observer Hub（ContextEngine 出口 → LLM 视图） */
  private _observerHub?: import('../observability/observer/hub.js').ObserverHub;
  /** 工具效应隔离（I5）；Runner 解析 toolRuntime.cwd */
  private _toolIsolation?: import('../extension/execution-environment/isolation.js').ToolIsolationMode;

  // MCP 配置
  private _mcpConfigs: import('../extension/plugin-ecosystem/mcp/types.js').McpServerConfig[] = [];
  /** MCP client 工厂（Integration 适配器由宿主注入） */
  private _mcpClientFactory?: McpClientFactory;

  // 自主子系统配置
  private _subsystemSpecs: import('../collaboration/autonomous-subsystem/types.js').SubsystemSpec[] = [];
  private _subsystemAuditDir?: string;
  private _modelLevels?: import('../collaboration/autonomous-subsystem/types.js').ModelLevelMap;
  private _subsystemDir?: string;
  private _subsystemAllowlist?: string[];
  private _subsystemDenylist?: string[];

  // 注册的 named providers（用于 ProviderPool）
  private _namedProviders = new Map<string, ModelProvider>();

  // 并发控制配置
  private _concurrencyConfig?: import('../../config.js').HarnessConfig['concurrency'];
  /** Agent 沙箱工作目录（工具 cwd 注入） */
  private _workspace?: string;
  /** agent 文件态 home（persona 可不同；extract / agent.db 用此路径） */
  private _agentHome?: string;
  /** 逻辑 agentId（观测 / 子系统审计用） */
  private _agentId?: string;


  // ── Core 组件 ──

  /** 设置模型提供者 */
  model(provider: ModelProvider): this;
  model(name: string): this;
  model(providerOrName: ModelProvider | string): this {
    if (typeof providerOrName === 'string') {
      // 字符串形式：创建一个简单的 wrapper（需要外部注册实际 provider）
      this._model = {
        name: providerOrName,
        chat: async () => { throw new Error(`Model provider "${providerOrName}" not configured`); },
        stream: async function* () { throw new Error(`Model provider "${providerOrName}" not configured`); },
        isAvailable: async () => false,
        getModelInfo: () => null,
        getModelInfos: () => [],
      };
    } else {
      this._model = providerOrName;
    }
    return this;
  }

  /** 注册工具 */
  tool(tool: RegisteredTool): this {
    this._toolBus.register(tool);
    return this;
  }

  /** 批量注册工具 */
  tools(...tools: RegisteredTool[]): this {
    for (const t of tools) this.tool(t);
    return this;
  }

  private _contextProvider = new RuntimeToolContextProvider();

  /** 获取运行时上下文提供者 */
  getContextProvider(): ToolContextProvider {
    return this._contextProvider;
  }

  /**
   * 配置 MCP Server 连接
   *
   * 构建时自动连接，工具注册到 ToolBus。
   * 支持多次调用，连接多个 MCP Server。
   * 需同时注入 `mcpClientFactory`（Integration 的 `createSdkMcpClient` 或自定义实现）。
   *
   * @example
   * ```ts
   * const { engine, runner } = await new AgentBuilder()
   *   .model('gpt-5.5')
   *   .mcpClientFactory(createSdkMcpClient)
   *   .mcp({
   *     id: 'filesystem',
   *     transport: 'stdio',
   *     command: 'npx',
   *     args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
   *   })
   *   .build();
   * ```
   */
  mcp(config: import('../extension/plugin-ecosystem/mcp/types.js').McpServerConfig): this {
    this._mcpConfigs.push(config);
    return this;
  }

  /** 注入 MCP client 工厂（Integration 适配；Harness 不 import Integration） */
  mcpClientFactory(factory: McpClientFactory): this {
    this._mcpClientFactory = factory;
    return this;
  }

  /** 注册自主子系统（仍受 allow/deny 列表约束） */
  withSubsystem(spec: import('../collaboration/autonomous-subsystem/types.js').SubsystemSpec): this {
    this._subsystemSpecs.push(spec);
    return this;
  }

  /** 设置子系统目录（用于自动加载） */
  withSubsystemDir(dir: string): this {
    this._subsystemDir = dir;
    return this;
  }

  /**
   * 子系统允许列表：仅这些 id 可注册。
   * 可多次调用（追加）；build(options.subsystemAllowlist) 时整体覆盖。
   */
  subsystemAllowlist(...ids: string[]): this {
    this._subsystemAllowlist = [...(this._subsystemAllowlist ?? []), ...ids];
    return this;
  }

  /**
   * 子系统禁止列表：这些 id 不注册（优先于允许列表）。
   * 可多次调用（追加）；build(options.subsystemDenylist) 时整体覆盖。
   */
  subsystemDenylist(...ids: string[]): this {
    this._subsystemDenylist = [...(this._subsystemDenylist ?? []), ...ids];
    return this;
  }

  /** 设置子系统审计日志目录 */
  withSubsystemAuditDir(dir: string): this {
    this._subsystemAuditDir = dir;
    return this;
  }

  /**
   * 设置模型级别映射（来自 config.models.level）
   *
   * 子系统通过 think.model: 'mini' 引用，运行时自动解析到具体 provider/model。
   */
  withModelLevels(levels: import('../collaboration/autonomous-subsystem/types.js').ModelLevelMap): this {
    this._modelLevels = levels;
    return this;
  }

  /** 设置上下文引擎 */
  contextEngine(engine: ContextEngine): this {
    this._contextEngine = engine;
    return this;
  }

  /**
   * 设置 Skill 目录（子目录内含 SKILL.md）
   *
   * build 时 discover，每轮以索引形式注入 system prompt（formatForPrompt）。
   */
  skillDirectory(dir: string): this {
    this._skillDirectory = dir;
    return this;
  }

  /** 直接注入 SkillManager（跳过目录 discover） */
  skills(manager: import('../extension/plugin-ecosystem/skills/types.js').SkillManager): this {
    this._skillManager = manager;
    return this;
  }

  /** 注入 MemoryStore（每轮按 query 召回进 system prompt） */
  memoryStore(store: import('../memory/types.js').MemoryStore): this {
    this._memoryStore = store;
    return this;
  }

  /** 注入补录覆盖表（默认：SqliteMemoryStore→agent.db，否则内存） */
  backfillCoverage(store: import('../memory/backfill-coverage.js').BackfillCoverageStore): this {
    this._backfillCoverage = store;
    return this;
  }

  /** 全局宪法（product | custom | off） */
  constitution(config: import('../../config.js').ConstitutionConfig | null): this {
    this._constitutionConfig = config;
    return this;
  }

  /** Memory 策略配置（profile / backfill / decay / health / confidence / gates） */
  memoryConfig(config: import('../../config.js').HarnessConfig['memory']): this {
    this._memoryConfig = config;
    return this;
  }

  /** 注入 Knowledge catalog（Tier 0；内容命中不进 system） */
  knowledgeCatalog(
    provider: import('../knowledge/catalog-types.js').KnowledgeCatalogProvider,
    opts?: {
      maxEntries?: number;
      groupByScope?: boolean;
      showProgress?: 'off' | 'bucket' | 'exact';
    },
  ): this {
    this._knowledgeCatalog = provider;
    this._knowledgeCatalogOpts = opts;
    return this;
  }

  /**
   * 注入 Knowledge 检索（grounding + knowledge_search/read）
   */
  knowledgeRetriever(deps: {
    retriever: import('../knowledge/retriever.js').KnowledgeRetriever;
    indexStore: import('../knowledge/index-store.js').KnowledgeIndexStore;
    sourceStore: import('../knowledge/source-store.js').KnowledgeSourceStore;
    hitLog?: import('../knowledge/hit-log.js').KnowledgeHitLog;
    grounding?: {
      budgetTokens?: number;
      budgetRatio?: number;
      maxBudgetTokens?: number;
      maxChunks?: number;
      skipIfUserTokensBelow?: number;
      includePriorUserTurns?: number;
    };
  }): this {
    this._knowledgeRetriever = deps.retriever;
    this._knowledgeIndexStore = deps.indexStore;
    this._knowledgeSourceStore = deps.sourceStore;
    this._knowledgeHitLog = deps.hitLog;
    this._knowledgeGrounding = deps.grounding;
    return this;
  }

  /**
   * 仅注入 turn 级 grounding（Knowledge Service client 路径）。
   * 工具面请另用 createKnowledgeClientTools；本地 store 路径请用 knowledgeRetriever。
   */
  knowledgeGrounding(
    port: import('../knowledge/retriever.js').AutoGroundPort,
    opts?: {
      budgetTokens?: number;
      budgetRatio?: number;
      maxBudgetTokens?: number;
      maxChunks?: number;
      skipIfUserTokensBelow?: number;
      includePriorUserTurns?: number;
    },
  ): this {
    this._knowledgeGroundingPort = port;
    this._knowledgeGrounding = opts;
    return this;
  }

  /** 注入 WisdomStore（半静态思维范式，进 system prompt WisdomLayer） */
  wisdomStore(store: import('../memory/types.js').WisdomStore): this {
    this._wisdomStore = store;
    return this;
  }

  /** 注入 ConceptGraphStore（spreadingActivate 召回概念子图，进 system prompt CognitionLayer） */
  cognitionStore(store: import('../memory/types.js').ConceptGraphStore): this {
    this._cognitionStore = store;
    return this;
  }

  /**
   * system prompt 装配器调参
   *
   * @param config.systemBudgetRatio - system 预算占 contextWindow 比例
   * @param config.layerShares - 单层硬顶（仅配置的层生效；默认不配额）
   * @param config.includeLayerPreview - 是否在 manifest 写入层 preview
   * @param config.layerPreviewChars - preview 最大字符数
   * @param config.includeLayerContent - 是否在 manifest 写入层正文全文
   */
  contextAssembler(config: {
    systemBudgetRatio?: number;
    systemBudgetTokens?: number;
    compactTargetTokens?: number;
    includeLayerPreview?: boolean;
    layerPreviewChars?: number;
    includeLayerContent?: boolean;
    layerShares?: Partial<Record<import('../context/layer-types.js').ContextLayerId, number>>;
  }): this {
    this._contextAssemblerConfig = { ...this._contextAssemblerConfig, ...config };
    return this;
  }

  /** 设置摘要函数（用于 LLM 摘要压缩） */
  summarize(fn: SummarizeFunction): this {
    this._summarize = fn;
    return this;
  }

  /**
   * 关闭「未显式 summarize 时用主模型自动挂接」
   *
   * 默认开启自动挂接，保证长会话能走 LLM 摘要而非纯截断。
   */
  disableAutoSummarize(disabled = true): this {
    this._disableAutoSummarize = disabled;
    return this;
  }

  /** 设置事件总线 */
  events(bus: EventBus): this {
    this._events = bus;
    return this;
  }

  /** 设置安全守卫 */
  security(guard: SecurityGuard): this {
    this._security = guard;
    return this;
  }

  /** 设置安全策略配置 */
  securityPolicy(config: SecurityGuardConfig): this {
    this._securityConfig = config;
    return this;
  }

  /** 注入工具调用风险策略（由 Harness 层实现，注入到 Core 的 SecurityGuard） */
  withRiskPolicy(policy: import('@octopi-agent/core/security-guard.js').ToolCallRiskPolicy): this {
    this._riskPolicy = policy;
    return this;
  }

  /**
   * high 风险人工确认通道
   *
   * 未设置时 high 回退 reject（无人值守 fail-safe）。
   * Gateway 可接到 ask_user / pendingApproval UI。
   */
  confirmHighRisk(fn: NonNullable<import('@octopi-agent/core/interfaces/reliability.js').ReliabilityHarness['confirmHighRisk']>): this {
    this._confirmHighRisk = fn;
    return this;
  }

  /** 设置迭代预算 */
  budget(config: Partial<BudgetPolicyConfig>): this {
    this._budget = new BudgetPolicyEngine(config);
    return this;
  }

  /** 设置错误策略 */
  errorStrategy(strategy: ErrorStrategy): this {
    this._errorStrategy = strategy;
    return this;
  }

  // ── 并发控制 ──

  /** 注册 named provider（用于 ProviderPool 多 key 路由） */
  provider(name: string, instance: ModelProvider): this {
    this._namedProviders.set(name, instance);
    return this;
  }

  /** 批量注册 named providers */
  providers(map: Map<string, ModelProvider>): this {
    for (const [name, instance] of map) {
      this._namedProviders.set(name, instance);
    }
    return this;
  }

  /** 设置并发控制配置（ProviderPool + SessionGate） */
  concurrency(config: import('../../config.js').HarnessConfig['concurrency']): this {
    this._concurrencyConfig = config;
    return this;
  }

  /** 设置观测器 */
  observer(observer: Observer): this {
    this._observer = observer;
    return this;
  }

  /** 设置可靠性配置（用于 buildAgent()） */
  reliability(config: Partial<ReliabilityConfig>): this {
    this._reliabilityConfig = { ...DEFAULT_RELIABILITY_CONFIG, ...config };
    return this;
  }

  /**
   * 启用可观测性采集
   *
   * 需要其一才能生效：
   * - 已注册 `RunTelemetryFactory`（`import 'octopi'` 会默认注册 createRunTelemetry）
   * - 或手动 `.telemetryFactory(...)` / `.observer(...)`
   *
   * @param options - 采集意图（tool args / stream deltas / metrics…）
   */
  trace(options?: AgentTraceOptions): this {
    this._traceOptions = {
      captureStreamDeltas: false,
      captureModelRequest: false,
      captureToolArgs: true,
      captureToolResults: false,
      enableMetrics: true,
      ...options,
    };
    return this;
  }

  /** 注入观测装配工厂（Integration 的 createRunTelemetry 或自定义） */
  telemetryFactory(factory: RunTelemetryFactory): this {
    this._telemetryFactory = factory;
    return this;
  }

  /** 读取采集意图 */
  getTraceOptions(): AgentTraceOptions | undefined {
    return this._traceOptions;
  }

  /** 设置过程监督（自动创建，使用主模型做 LLM 审查） */
  runGuard(config?: RunGuardConfig): this;
  /** 设置过程监督（手动传入实例） */
  runGuard(guard: RunGuard, checkpointInterval?: number): this;
  runGuard(guardOrConfig?: RunGuard | RunGuardConfig, checkpointInterval?: number): this {
    if (!guardOrConfig) {
      // 无参调用：使用默认配置自动创建，延迟到 buildAgent 时注入 model
      this._runGuardConfig = {};
    } else if (typeof (guardOrConfig as RunGuard).checkpoint === 'function') {
      // RunGuard 实例（含自定义实现）
      this._runGuard = guardOrConfig as RunGuard;
    } else {
      // RunGuardConfig 对象：延迟到 buildAgent 时注入 model
      this._runGuardConfig = guardOrConfig as RunGuardConfig;
    }
    if (checkpointInterval !== undefined) this._checkpointInterval = checkpointInterval;
    return this;
  }

  // ── Harness 组件 ──

  /** 加载 persona 目录 */
  persona(workspace: string): this;
  persona(...workspaces: string[]): this;
  persona(...workspaces: string[]): this {
    this._personaWorkspaces.push(...workspaces);
    return this;
  }

  /** 设置 Agent 沙箱工作目录（注入到内置工具的 cwd） */
  workspace(dir: string): this {
    this._workspace = dir;
    return this;
  }

  /** agent 文件态 home：extract 落盘、与 persona 目录解耦 */
  agentHome(dir: string): this {
    this._agentHome = dir;
    return this;
  }

  /** 逻辑 agentId（extract pending 扫描 / 观测） */
  agentId(id: string): this {
    this._agentId = id;
    return this;
  }

  /** 直接设置 systemPrompt（优先于 persona 目录） */
  systemPrompt(prompt: string): this {
    this._systemPrompt = prompt;
    return this;
  }

  // ── Runner 配置 ──

  /** 设置 Session 存储 */
  store(store: SessionStore<SessionData>): this {
    this._store = store;
    return this;
  }

  /** 设置 Runner 配置 */
  runnerConfig(config: SessionAwareRunnerConfig): this {
    this._runnerConfig = config;
    if (config.observerHub) {
      this._observerHub = config.observerHub;
    }
    return this;
  }

  /** 注入产品 Observer Hub（LLM 视图等） */
  observerHub(hub: import('../observability/observer/hub.js').ObserverHub | undefined): this {
    this._observerHub = hub;
    return this;
  }

  /**
   * 工具效应隔离策略（I5）
   *
   * @param mode - `none` | `session-subdir` | `session-lock`
   */
  toolIsolation(mode: import('../extension/execution-environment/isolation.js').ToolIsolationMode): this {
    this._toolIsolation = mode;
    return this;
  }

  // ── 构建 ──

  /**
   * 统一构建入口。
   *
   * - 默认 `mode: 'full'`：Agent + Runner + 自主子系统 + memory extraction 接线
   * - `mode: 'core'`：仅 Agent + harness + mcpManager（嵌入/单测；等价旧 `buildAgent()`）
   */
  async build(options: AgentBuildOptions & { mode: 'core' }): Promise<AgentBuildCoreResult>;
  async build(options?: AgentBuildOptions): Promise<AgentBuildResult>;
  async build(options?: AgentBuildOptions): Promise<AgentBuildResult | AgentBuildCoreResult> {
    const mode = options?.mode ?? 'full';
    const events = this._events ?? new DefaultEventBus();
    this._events = events;

    // 并发控制：ProviderPool
    if (this._concurrencyConfig?.providerPool && this._namedProviders.size > 0) {
      const { ProviderPool } = await import('../run/concurrency/provider-pool.js');
      this._model = new ProviderPool(this._concurrencyConfig.providerPool, this._namedProviders);
    }

    // 并发控制：SessionGate
    if (this._concurrencyConfig?.sessionGate) {
      const { SessionGate } = await import('../run/concurrency/session-gate.js');
      const gateConfig = this._concurrencyConfig.sessionGate;
      this._runnerConfig = {
        ...this._runnerConfig,
        sessionGate: new SessionGate({
          maxConcurrent: gateConfig.maxConcurrent,
          waitTimeoutMs: gateConfig.waitTimeoutMs,
        }),
      };
    }

    // 创建 SessionStore（须在 buildAgent 之前，以便 task_* 工具进入 Agent 的工具快照）
    const store = this._store ?? new InMemorySessionStore();
    this._store = store;

    // 会话任务：默认创建 Service；注册 task_* 工具后再 buildAgent
    const sessionTaskService =
      this._runnerConfig?.sessionTaskService ?? new SessionTaskService(store, events);
    this._runnerConfig = {
      ...this._runnerConfig,
      sessionTaskService,
    };

    if (!this._toolBus.getTool('task_list')) {
      for (const t of createSessionTaskTools(sessionTaskService)) {
        this._toolBus.register(t);
      }
    }

    // memory 工具必须在 buildCore 之前注册：Agent 构造时从 ToolBus 快照 tools
    if (this._memoryStore && !this._toolBus.getTool('memory_store')) {
      const { createMemoryTools } = await import('../extension/plugin-ecosystem/tools/memory.js');
      const { profileToConfidenceConfig } = await import('../memory/confidence.js');
      const memCfg = this._memoryConfig;
      const confidence = profileToConfidenceConfig(memCfg?.profile, {
        injectMinScore: memCfg?.confidence?.injectMinScore,
        channelPriors: memCfg?.confidence?.channelPriors,
      });
      for (const tool of createMemoryTools(this._memoryStore, {
        confidence,
        gates: memCfg?.gates?.maxLength
          ? { maxLength: memCfg.gates.maxLength }
          : undefined,
        onStored:
          this._cognitionStore && events
            ? (info) => {
                void import('../memory/cognition-trigger.js')
                  .then(({ emitConceptualizeRequest }) => {
                    emitConceptualizeRequest(events, {
                      memoryId: info.id,
                      proposition: info.proposition,
                      evidence: info.evidence,
                      memoryType: info.type,
                      memoryStatus: info.status as 'shadow' | 'active' | 'strengthened',
                      channel: info.channel,
                      sessionId: info.sessionId,
                    });
                  })
                  .catch(() => {
                    // 动态加载失败不阻断 memory 写
                  });
              }
            : undefined,
      })) {
        this._toolBus.register(tool);
      }
      console.log('[AgentBuilder] memory tools registered: memory_store, memory_search');
    } else if (!this._memoryStore) {
      console.warn('[AgentBuilder] memory tools skipped: no memoryStore injected');
    }

    // knowledge 工具（P4）：knowledge_search / knowledge_read
    if (
      this._knowledgeRetriever &&
      this._knowledgeIndexStore &&
      this._knowledgeSourceStore &&
      !this._toolBus.getTool('knowledge_search')
    ) {
      const { createKnowledgeTools } = await import('../extension/plugin-ecosystem/tools/knowledge.js');
      for (const tool of createKnowledgeTools({
        retriever: this._knowledgeRetriever,
        indexStore: this._knowledgeIndexStore,
        sourceStore: this._knowledgeSourceStore,
        hitLog: this._knowledgeHitLog,
      })) {
        this._toolBus.register(tool);
      }
      console.log('[AgentBuilder] knowledge tools registered: knowledge_search, knowledge_read');
    }

    // 核心组件（Agent 门面）；full 模式继续装配 runner / 子系统 / 提取栈
    const core = await this.buildCore();
    const { agent, harness, mcpManager, contextEngine } = core;

    if (mode === 'core') {
      return {
        agent,
        harness,
        mcpManager,
        events,
        contextHealth: async (agentId?: string) => {
          const { probeContextLayerHealth } = await import('../context/layer-health.js');
          return probeContextLayerHealth({
            agentId: agentId ?? 'default',
            skillCount: this._skillManager?.list().length,
            memoryStore: this._memoryStore,
            knowledgeCatalog: this._knowledgeCatalog,
            wisdomStore: this._wisdomStore,
            cognitionStore: this._cognitionStore,
            personaLoaded: Boolean(
              (this._systemPrompt ?? '').trim() ||
                (this._initialPersonaContent ?? '').trim() ||
                this._personaResolver,
            ),
          });
        },
      };
    }

    const runner = new SessionAwareRunner(agent, harness, store, {
      ...this._runnerConfig,
      toolIsolation: this._toolIsolation ?? this._runnerConfig?.toolIsolation,
      agentWorkspace: this._workspace?.trim() ? this._workspace : this._runnerConfig?.agentWorkspace,
      sessionLease: this._runnerConfig?.sessionLease,
      sessionAcl: this._runnerConfig?.sessionAcl,
      agentMaxSessionRights: this._runnerConfig?.agentMaxSessionRights,
      observerHub: this._observerHub ?? this._runnerConfig?.observerHub,
      sessionTaskService,
      events,
      eventSink: this._telemetry?.onEvent
        ? (event, ctx) => this._telemetry?.onEvent?.(event, ctx)
        : this._runnerConfig?.eventSink,
    });
    runner.setToolContextProvider(this._contextProvider);
    if (this._personaResolver) {
      // 传入磁盘 persona 真实内容（可能为 ''），供 runner 区分「从未有人格」与「热删除」
      runner.setSystemPromptResolver(this._personaResolver, this._initialPersonaContent ?? '');
    }
    // 层契约装配：persona + skill 索引 + wisdom/cognition/memory 召回 + knowledge catalog + runtime
    const skillManager = this._skillManager;
    const memoryStore = this._memoryStore;
    const knowledgeCatalog = this._knowledgeCatalog;
    const wisdomStore = this._wisdomStore;
    const cognitionStore = this._cognitionStore;
    const assemblerCfg = this._contextAssemblerConfig;
    const constitutionCfg = this._constitutionConfig;
    const systemPromptAssembler = createDefaultSystemPromptAssembler({
      getSkillPromptText: skillManager
        ? () => skillManager.formatForPrompt()
        : undefined,
      memoryStore,
      knowledgeCatalog,
      knowledgeMaxEntries: this._knowledgeCatalogOpts?.maxEntries,
      knowledgeGroupByScope: this._knowledgeCatalogOpts?.groupByScope,
      knowledgeShowProgress: this._knowledgeCatalogOpts?.showProgress,
      wisdomStore,
      cognitionStore,
      systemBudgetRatio: assemblerCfg?.systemBudgetRatio,
      systemBudgetTokens: assemblerCfg?.systemBudgetTokens,
      constitution: constitutionCfg,
      assemblerConfig: {
        layerShares: assemblerCfg?.layerShares,
        includeLayerPreview: assemblerCfg?.includeLayerPreview,
        layerPreviewChars: assemblerCfg?.layerPreviewChars,
        includeLayerContent: assemblerCfg?.includeLayerContent,
      },
    });
    runner.setSystemPromptAssembler(
      (input) => systemPromptAssembler.assemble(input),
      (sid) => systemPromptAssembler.clearSession(sid),
    );

    // turn 级 Knowledge grounding（消息插槽 knowledgeGrounding；不进 system）
    const groundingPort = this._knowledgeGroundingPort ?? this._knowledgeRetriever;
    if (groundingPort) {
      const { GroundingAssembler } = await import('../knowledge/grounding.js');
      const grounding = new GroundingAssembler({
        retriever: groundingPort,
        hitLog: this._knowledgeHitLog,
        budgetTokens: this._knowledgeGrounding?.budgetTokens,
        budgetRatio: this._knowledgeGrounding?.budgetRatio,
        maxBudgetTokens: this._knowledgeGrounding?.maxBudgetTokens,
        maxChunks: this._knowledgeGrounding?.maxChunks,
        skipIfUserTokensBelow: this._knowledgeGrounding?.skipIfUserTokensBelow,
        includePriorUserTurns: this._knowledgeGrounding?.includePriorUserTurns,
      });
      runner.setGroundingAssembler(async (input) => {
        const pack = await grounding.assemble(input);
        return {
          query: pack.query,
          mode: pack.mode,
          hits: pack.hits.map((h) => ({
            path: h.path,
            startLine: h.startLine,
            endLine: h.endLine,
            text: h.text,
          })),
          hint: pack.hint,
          coverage: pack.coverage,
          tokens: pack.tokens,
          text: pack.text,
        };
      });
    }

    // 子系统装配：自动发现 + allow/deny 过滤 + 注册
    const allowlist = options?.subsystemAllowlist ?? this._subsystemAllowlist;
    const denylist = options?.subsystemDenylist ?? this._subsystemDenylist;
    const allowed = (id: string, packageId?: string) => isSubsystemAllowed(id, allowlist, denylist, packageId);

    const autoLoad = options?.autoLoadSubsystems ?? true;
    if (autoLoad && !this._subsystemDir) {
      const discovered = await discoverSubsystemSpecs(options?.subsystemDirs);
      for (const spec of discovered.specs) {
        if (this._subsystemSpecs.some((s) => s.id === spec.id)) continue;
        this._subsystemSpecs.push(spec);
      }
      for (const err of discovered.errors) {
        console.warn(`[AgentBuilder] subsystem load error at ${err.path}: ${err.error}`);
      }
    }

    // 创建 SubsystemRuntime（过滤后仍有子系统，或指定了目录）
    // allowed 必须带 packageId：否则 allowlist: ["memory-steward"] 会在预滤阶段被丢掉
    const candidateSpecs = this._subsystemSpecs.filter((s) => allowed(s.id, s.packageId));
    const skipped = this._subsystemSpecs.filter((s) => !allowed(s.id, s.packageId));

    let subsystemRuntime: import('../collaboration/autonomous-subsystem/runtime.js').SubsystemRuntime | undefined;
    if (candidateSpecs.length > 0 || this._subsystemDir) {
      const { SubsystemRuntime } = await import('../collaboration/autonomous-subsystem/runtime.js');
      subsystemRuntime = new SubsystemRuntime({
        deps: {
          model: agent.model,
          events,
          errorStrategy: this._errorStrategy ?? new DefaultErrorStrategy(),
          mainTools: this._toolBus,
          modelLevels: this._modelLevels,
        },
        auditDir: this._subsystemAuditDir,
      });

      const registeredIds = new Set<string>();
      const tryRegister = (spec: import('../collaboration/autonomous-subsystem/types.js').SubsystemSpec): void => {
        if (!allowed(spec.id, spec.packageId)) return;
        const regErrors = subsystemRuntime!.register(spec);
        if (regErrors.length > 0) {
          console.warn(`[octopi] subsystem "${spec.id}" rejected: ${regErrors.join('; ')}`);
        } else {
          registeredIds.add(spec.id);
        }
      };

      for (const spec of candidateSpecs) {
        tryRegister(spec);
      }
      if (this._subsystemDir) {
        const { SubsystemLoader } = await import('../collaboration/autonomous-subsystem/loader.js');
        const loader = new SubsystemLoader({ builtinDir: this._subsystemDir });
        const loadResult = await loader.loadAll();
        for (const err of loadResult.errors) {
          console.warn(`[octopi] subsystem load failed ${err.path}: ${err.error}`);
        }
        for (const spec of loadResult.specs) {
          tryRegister(spec);
        }
      }

      // 依赖注入：memoryStore / conceptGraphStore / sessionStore / constitution / backfillCoverage
      if (this._memoryStore) {
        subsystemRuntime.registerDependency('memoryStore', this._memoryStore);
      }
      if (this._cognitionStore) {
        subsystemRuntime.registerDependency('conceptGraphStore', this._cognitionStore);
      }
      {
        const { InMemoryBackfillCoverageStore } = await import('../memory/backfill-coverage.js');
        let coverage = this._backfillCoverage;
        if (!coverage) {
          const mem = this._memoryStore as { database?: import('../memory/sqlite/agent-db.js').AgentDatabase } | undefined;
          if (mem?.database) {
            const { SqliteBackfillCoverageStore } = await import('../memory/sqlite/backfill-coverage.js');
            coverage = new SqliteBackfillCoverageStore(mem.database);
          } else {
            coverage = new InMemoryBackfillCoverageStore();
          }
          this._backfillCoverage = coverage;
        }
        subsystemRuntime.registerDependency('backfillCoverage', coverage);
        if (this._memoryConfig?.decay?.typeParams) {
          subsystemRuntime.registerDependency('memoryDecayParams', this._memoryConfig.decay.typeParams);
        }
      }
      if (this._store) {
        subsystemRuntime.registerDependency('sessionStore', this._store);
      }
      try {
        const { loadConstitution } = await import('../context/constitution/load-constitution.js');
        const loaded = loadConstitution(this._constitutionConfig ?? { mode: 'product' });
        subsystemRuntime.registerDependency('constitution', loaded.text);
      } catch {
        // custom path invalid already fails build elsewhere; steward may proceed without prompt text
      }

      const loadedIds = Array.from(registeredIds);
      console.log(
        loadedIds.length > 0
          ? `[AgentBuilder] subsystems registered: ${loadedIds.join(', ')}`
          : '[AgentBuilder] subsystems registered: (none)',
      );
      if (skipped.length > 0) {
        console.log(
          `[AgentBuilder] subsystems skipped by allowlist/denylist: ${skipped.map((s) => s.id).join(', ')}`,
        );
      }

      if (registeredIds.size > 0 || candidateSpecs.length > 0 || this._subsystemDir) {
        runner.setSubsystemRuntime(subsystemRuntime);
      }

      // 补录脉搏：硬收敛 / idle 漂移 / 覆盖差
      // `memory.backfill.enabled=false` 时不启动 Trigger（省 LLM）；denylist 不注册子系统时同样不启动
      const backfillCfg = this._memoryConfig?.backfill;
      const backfillEnabled = backfillCfg?.enabled !== false;
      if (backfillEnabled && registeredIds.has('memory.steward.backfill') && this._backfillCoverage) {
        const { BackfillTrigger } = await import('../memory/backfill-trigger.js');
        const trigger = new BackfillTrigger({
          events,
          coverage: this._backfillCoverage,
          sessionStore: store,
          idleDelayMs: backfillCfg?.idleDelayMs,
          gapScanMs: backfillCfg?.gapScanMs,
          prefilter: {
            minUserTurns: backfillCfg?.minUserTurns,
            minTotalChars: backfillCfg?.minTotalChars,
          },
        });
        trigger.start();
        runner.setBackfillTrigger(trigger);
      } else if (!backfillEnabled && registeredIds.has('memory.steward.backfill')) {
        console.log('[AgentBuilder] memory.backfill.enabled=false — auto backfill trigger off');
      }

      // health 双脉搏补充：高水位 / shadow 积压 → emit memory.health.*（govern 可监听）
      if (memoryStore && registeredIds.has('memory.steward.govern')) {
        const { MemoryHealthProbe } = await import('../memory/health-probe.js');
        const healthCfg = this._memoryConfig?.health;
        const probe = new MemoryHealthProbe({
          events,
          memoryStore,
          intervalMs: healthCfg?.intervalMs,
          shadowBacklogLimit: healthCfg?.shadowBacklogLimit,
          limits: healthCfg?.limits,
        });
        probe.start();
        runner.setMemoryHealthProbe(probe);
      }
    }

    const skillManagerForHealth = skillManager;
    const memoryStoreForHealth = memoryStore;
    const knowledgeCatalogForHealth = knowledgeCatalog;
    const wisdomStoreForHealth = wisdomStore;
    const cognitionStoreForHealth = cognitionStore;
    const personaLoadedForHealth = Boolean(
      (this._systemPrompt ?? '').trim() ||
        (this._initialPersonaContent ?? '').trim() ||
        this._personaResolver,
    );

    return {
      agent,
      harness,
      runner,
      mcpManager,
      runtime: subsystemRuntime,
      events,
      contextEngine,
      contextHealth: async (agentId?: string) => {
        const { probeContextLayerHealth } = await import('../context/layer-health.js');
        return probeContextLayerHealth({
          agentId: agentId ?? 'default',
          skillCount: skillManagerForHealth?.list().length,
          memoryStore: memoryStoreForHealth,
          knowledgeCatalog: knowledgeCatalogForHealth,
          wisdomStore: wisdomStoreForHealth,
          cognitionStore: cognitionStoreForHealth,
          personaLoaded: personaLoadedForHealth,
        });
      },
    };
  }

  /**
   * 构建 Agent 类（Harness 门面 + reliability）
   *
   * 返回已绑定 harness 的 Agent；集成方应使用 `agent.run()`。
   *
   * @deprecated 请使用 `build({ mode: 'core' })`。本方法仅为兼容保留，不再扩展。
   */
  async buildAgent(): Promise<{ agent: Agent; harness: ReliabilityHarness; mcpManager: McpManager }> {
    return this.buildCore();
  }

  /**
   * 核心构建：仅产出 Agent 门面 + ReliabilityHarness + McpManager。
   * 不创建 Runner / SubsystemRuntime / memory extraction。
   */
  private async buildCore(): Promise<AgentBuildCoreResult> {
    if (!this._model) {
      throw new Error('ModelProvider is required. Call .model() before build()');
    }

    // 单独 buildAgent() 时也保证有 bus，压缩事件不会静默丢失
    if (!this._events) {
      this._events = new DefaultEventBus();
    }

    // 观测装配：.trace() → RunTelemetry（工厂由宿主/包入口注入）
    let loopObserver: import('@octopi-agent/core/loop/types.js').LoopObserver | undefined;
    if (this._traceOptions) {
      const factory = this._telemetryFactory ?? getRunTelemetryFactory();
      if (factory) {
        this._telemetry = factory(this._traceOptions);
        loopObserver = this._telemetry.createLoopObserver(this._traceOptions);
      } else if (!this._observer) {
        throw new Error(
          'trace() requires a RunTelemetryFactory. `import { AgentBuilder } from "octopi-agent"` (or @octopi-agent/engine) registers createRunTelemetry, or call .telemetryFactory(...) / .observer(...).',
        );
      }
    }

    // 加载 systemPrompt：文件式 persona 走 PersonaSource（run 时热更新）
    let systemPrompt = this._systemPrompt ?? '';
    this._personaResolver = undefined;
    this._initialPersonaContent = undefined;
    if (!systemPrompt && this._personaWorkspaces.length > 0) {
      const source = new PersonaSource();
      const dirs = [...this._personaWorkspaces];
      this._personaResolver = () => source.load(...dirs);
      this._initialPersonaContent = await this._personaResolver();
      systemPrompt = this._initialPersonaContent;
    }
    if (!systemPrompt && this._toolBus.listForAgent('default').length > 0) {
      systemPrompt = this.buildDefaultSystemPrompt();
    }

    // Skill：目录 discover（或外部注入的 manager）
    if (!this._skillManager && this._skillDirectory) {
      const { DefaultSkillManager } = await import('../extension/plugin-ecosystem/skills/manager.js');
      const mgr = new DefaultSkillManager(this._skillDirectory);
      try {
        await mgr.discover(this._skillDirectory);
        this._skillManager = mgr;
      } catch (err) {
        console.warn(
          `[octopi] skill discover failed (${this._skillDirectory}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 构建 McpManager
    const mcpManager = await this.buildMcpManager();

    // 转换 RegisteredTool → AgentTool
    this._contextProvider = new RuntimeToolContextProvider({
      cwd: this._workspace?.trim() ? this._workspace : undefined,
    });
    const agentTools: LoopAgentTool[] = this._toolBus.listForAgent('default').map(t => convertToAgentTool(t, this._contextProvider));

    // 创建 Agent
    const agentOptions: AgentOptions = {
      model: this._model,
      systemPrompt,
      tools: agentTools,
      observer: loopObserver ?? (this._observer ? {
        onLLMStart: (p) => this._observer?.log('info', 'llm.start', p as unknown as Record<string, unknown>),
        onLLMEnd: (p) => this._observer?.log('info', 'llm.end', p as unknown as Record<string, unknown>),
        onToolStart: (p) => this._observer?.log('info', 'tool.start', p as unknown as Record<string, unknown>),
        onToolEnd: (p) => this._observer?.log('info', 'tool.end', p as unknown as Record<string, unknown>),
      } : undefined),
    };
    const agent = new Agent(agentOptions);

    // ContextEngine 接线：经 convertToLlm 调用 assemble
    // 模型快照只读 ALS（Runner 每 run resolve 一次）；无 snapshot 时才回退 agent.model
    const contextEngine = this._contextEngine ?? new DefaultContextEngine();
    const { getResolvedModel } = await import('../run/model/run-scope.js');
    const summarizeFn =
      this._summarize ??
      (!this._disableAutoSummarize && this._model
        ? async (messages: import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[], opts?: { maxTokens?: number }) => {
            const provider = getResolvedModel()?.provider ?? this._model!;
            return createProviderSummarize(provider)(messages, opts);
          }
        : undefined);
    agent.setConvertToLlm(async (messages) => {
      // I1：身份与 systemPrompt 优先读 RunScope ALS，避免共享 Agent 单例竞态
      const scope = getRunScope();
      const sessionId = scope?.sessionId ?? agent.contextSessionId;
      const agentId = scope?.agentId ?? 'default';
      const systemPrompt = scope?.systemPrompt ?? agent.context.systemPrompt;
      const tools: import('@octopi-agent/core/interfaces/model-provider.js').LLMToolDefinition[] = (agent.context.tools ?? []).map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      }));
      // 方案 B：只读 snapshot.contextWindow；未知则 undefined（跳过自动压缩）
      // 禁止再调 getModelInfo —— FallbackProvider 可能返回 chain[0] 的窗口
      const snapshot = getResolvedModel();
      const provider = snapshot?.provider ?? agent.model;
      const contextWindow =
        snapshot?.contextWindow != null && snapshot.contextWindow > 0
          ? snapshot.contextWindow
          : undefined;
      const result = await contextEngine.assemble({
        sessionId,
        agentId,
        messages,
        systemPrompt,
        tools,
        tokenBudget: contextWindow,
        contextWindow,
        compactTargetTokens: this._contextAssemblerConfig?.compactTargetTokens,
        summarize: summarizeFn,
        loadCompactState: () => agent.getSessionCompactState(sessionId, agentId),
        // 惰性读 bus：覆盖 buildAgent 之后才 setEvents 的场景
        // Observer：ContextEngine 侧事件（context.compact.* 等）不经过 Runner emitObserved，
        // 必须在此直采 Hub，否则 timeline 永远看不到 compact。
        emit: (e) => {
          const { type, sessionId, ...data } = e;
          const event = {
            type,
            timestamp: Date.now(),
            sessionId,
            data,
          };
          try {
            this._observerHub?.ingestEvent(event);
          } catch {
            // 观测 fail-open
          }
          const bus = this._events;
          if (!bus) return;
          bus.emit(event);
        },
      });
      // 压缩状态回写 Agent 内存桥（E4 键 = sessionId × agentId）
      if (result.compactState) {
        agent.setSessionCompactState(sessionId, agentId, result.compactState);
      }
      // Observer P1：LLM 实际输入视图（ContextEngine 出口）
      // 真源 = hub.recordLlmMessages；事件只带 summarizeLlmMessages，避免双套统计/覆盖全文
      if (this._observerHub?.isEnabled() && this._observerHub.getConfig().channels['context.llm']) {
        const llmInput = result.messages.map((m) => ({
          role: m.role as string,
          content: m.content as unknown,
        }));
        this._observerHub.recordLlmMessages({
          sessionId,
          agentId,
          messages: llmInput,
          estimatedTokens: result.estimatedTokens,
        });
        this._events?.emit({
          type: 'run.scope.llm',
          timestamp: Date.now(),
          sessionId,
          agentId,
          data: {
            sessionId,
            agentId,
            summary: summarizeLlmMessages(llmInput),
            estimatedTokens: result.estimatedTokens,
          },
        });
      }
      // 保存最新的 context 压力信息（供 harness.getContextPressure 使用）
      this._lastContextPressure = {
        estimatedTokens: result.estimatedTokens,
        contextWindow,
      };

      // droppedSummary：并入已有 system，避免连续两条 system（严格网关）
      const llmMessages = [...result.messages];
      if (result.droppedSummary) {
        const note = `[Context compacted] ${result.droppedSummary}`;
        const sysIdx = llmMessages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) {
          const sys = llmMessages[sysIdx]!;
          const prev = typeof sys.content === 'string' ? sys.content : '';
          llmMessages[sysIdx] = {
            ...sys,
            content: prev ? `${prev}\n\n${note}` : note,
          };
        } else {
          llmMessages.unshift({ role: 'system', content: note });
        }
      }
      return llmMessages;
    });
    agent.setOnAfterTurn(async (usage, turn) => {
      const scope = getRunScope();
      const sessionId = scope?.sessionId ?? agent.contextSessionId;
      const agentId = scope?.agentId ?? 'default';
      await contextEngine.afterTurn?.({
        sessionId,
        agentId,
        turn: turn ?? [],
        usage: usage,
      });
    });

    // 构建可靠性 harness（systemPrompt 用于泄露检测；文件式 persona 每轮由 runner 同步）
    // 统一 EventBus 实例（security / budget 共用）
    const events = this._events ?? new DefaultEventBus();
    this._events = events;
    const security = this._security ?? new DefaultSecurityGuard(events, {
      ...this._securityConfig,
      systemPrompt: this._securityConfig?.systemPrompt ?? systemPrompt,
    });
    // 风险策略永远接线（安全不可绕过）：未显式注入时用 workspace cwd 的默认实现
    if (security.setToolCallRiskPolicy) {
      const riskPolicy = this._riskPolicy ?? new (await import('../governance/security/default-risk-policy.js')).DefaultToolCallRiskPolicy({
        cwd: this._workspace?.trim() ? this._workspace : undefined,
      });
      security.setToolCallRiskPolicy(riskPolicy);
    }
    // 未注册工具硬边界：灌入工具面快照（空集 = 不校验，必须在 build 时接线）
    if (security.setRegisteredTools) {
      security.setRegisteredTools(
        new Set(this._toolBus.listForAgent('default').map((t) => t.definition.name)),
      );
    }
    const errorStrategy = this._errorStrategy ?? new DefaultErrorStrategy();

    // 自动创建 RunGuard（如果通过 config 配置但未手动传入实例）
    const runGuard = this._runGuard
      ?? (this._runGuardConfig !== undefined
        ? new DefaultRunGuard(this._runGuardConfig, this._model)
        : undefined);

    // ResourceBudget：始终挂默认实例（可被 .budget() 覆盖），保证主路径硬停生效
    const budget =
      this._budget ?? new BudgetPolicyEngine({});

    // checkpointInterval：builder.runGuard(guard, n) 或默认
    if (this._checkpointInterval !== undefined) {
      this._reliabilityConfig = {
        ...(this._reliabilityConfig ?? DEFAULT_RELIABILITY_CONFIG),
        checkpointInterval: this._checkpointInterval,
      };
    }

    // 保存 builder 引用，用于 getContextPressure 回调
    const builderRef = this;

    const harness: ReliabilityHarness = {
      config: this._reliabilityConfig ?? DEFAULT_RELIABILITY_CONFIG,
      security,
      errorStrategy,
      runGuard,
      budget,
      // P5: Context 压力回调（从 ContextEngine assemble 获取）
      getContextPressure: () => builderRef._lastContextPressure,
      // high 风险确认：有则走人工审批，无则 run-agent 回退 reject
      confirmHighRisk: this._confirmHighRisk,
    };

    // Agent.run() 需要 harness；Builder 组装期绑定
    agent.setHarness(harness);

    return { agent, harness, mcpManager, events, contextEngine };
  }

  /**
   * 构建 McpManager 并连接所有配置的 MCP Server
   */
  private async buildMcpManager(): Promise<McpManager> {
    // 创建回调，桥接到 this._toolBus
    // MCP 工具全局注册（外部 server 发现的工具天然跨 agent 共享）
    // Agent 级过滤通过 ToolPolicy.deny 实现
    const callbacks: McpManagerCallbacks = {
      registerTool: (tool) => this._toolBus.register(tool),
      unregisterTool: (name) => this._toolBus.unregister(name),
      getTool: (name) => this._toolBus.getTool(name),
    };

    const factory = this._mcpClientFactory;
    const clientFactory: McpClientFactory = (config: McpServerConfig) => {
      if (!factory) {
        throw new Error(
          'McpClientFactory not injected. Call .mcpClientFactory(createSdkMcpClient) (from @octopi-agent/engine/integration) before .mcp().',
        );
      }
      return factory(config);
    };
    const manager = new DefaultMcpManager(callbacks, clientFactory);

    // 连接所有配置的 MCP Server
    for (const config of this._mcpConfigs) {
      try {
        await manager.connectServer(config);
      } catch (err) {
        console.error(`[AgentBuilder] Failed to connect MCP Server "${config.id}": ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }

    return manager;
  }

  /**
   * 生成默认 systemPrompt，包含可用工具说明
   */
  private buildDefaultSystemPrompt(): string {
    const toolList = this._toolBus.listForAgent('default')
      .map(t => `- ${t.definition.name}: ${t.definition.description}`)
      .join('\n');

    return `You are a helpful AI assistant with access to the following tools:

${toolList}

Tool selection (strict):
1. Prefer a dedicated tool when one covers the job (file_read / file_list / file_write / file_edit / file_search / env_info, and any task-specific tool).
2. If a dedicated-tool call fails because your arguments were wrong (bad path, bad params), fix the call and retry that tool — do not switch to shell for a call you can fix.
3. Use shell only when: (a) no dedicated tool covers the operation, or (b) the dedicated tool is unavailable, or (c) it still fails after a correct retry and shell is the only remaining way to make progress.
4. Do not prefer shell over a working dedicated tool for the same job.

Examples:
- Read a file → file_read first (shell cat only if file_read is unavailable or still fails after a correct retry)
- List directory → file_list first
- Write/edit a file → file_write / file_edit first
- Search file contents → file_search first
- Operation with no dedicated tool → shell is acceptable`;
  }
}

/**
 * 快速创建 Agent
 *
 * 最简集成方式：
 * ```ts
 * const { engine, runner } = await Octopi.create({
 *   model: myProvider,
 *   persona: './my-agent',
 * });
 * ```
 */
/** createAgent 配置：使用 mcp 时必须同时注入 mcpClientFactory */
export type CreateAgentConfig = {
  model: ModelProvider;
  persona?: string;
  tools?: RegisteredTool[];
  store?: SessionStore<SessionData>;
  budget?: Partial<BudgetPolicyConfig>;
} & (
  | { mcp?: undefined; mcpClientFactory?: McpClientFactory }
  | { mcp: McpServerConfig[]; mcpClientFactory: McpClientFactory }
);

export async function createAgent(config: CreateAgentConfig): Promise<{ agent: Agent; harness: ReliabilityHarness; runner: SessionAwareRunner; mcpManager: McpManager }> {
  const builder = new AgentBuilder()
    .model(config.model);

  if (config.persona) builder.persona(config.persona);
  if (config.tools) builder.tools(...config.tools);
  if (config.store) builder.store(config.store);
  if (config.budget) builder.budget(config.budget);
  if (config.mcpClientFactory) builder.mcpClientFactory(config.mcpClientFactory);
  if (config.mcp) {
    for (const mcpConfig of config.mcp) builder.mcp(mcpConfig);
  }

  return builder.build();
}
