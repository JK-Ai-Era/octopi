/**
 * Gateway 配置类型
 *
 * Integration 层类型。Gateway 是 Integration 层组件。
 */

import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';

export interface GatewayConfig {
  port?: number;
  agents: AgentDefinition[];
  /**
   * 委派编排（arch/delegation.md §8）。
   * `maxActiveDelegationsPerSession` 是失控防护，不是并发闸（D9）。
   */
  delegation?: {
    maxActiveDelegationsPerSession?: number;
  };
  /** Run 安全阀/策略；见 arch/budget-redesign.md（无 nominal token hard） */
  budgetPolicy?: {
    maxIterations?: number;
    maxToolCalls?: number;
    maxWallClockMs?: number;
  };
  session?: {
    dmScope?: 'main' | 'per-peer' | 'per-channel-peer';
    /** 上下文租约（毫秒）；显式配置才生效 */
    idleExpiryMs?: number;
  };
  /** 工具效应隔离策略（宪法 I5）；默认 none */
  toolIsolation?: 'none' | 'session-subdir' | 'session-lock';
  /** ToolEffectPolicy（P3/P4）；onClose 用于会话关闭时残留 undo */
  effectPolicy?: import('@octopi-agent/engine').EffectPolicyConfig;
  /** ops P2 §4.3/§8.4：安全配置漂移守卫（宿主锚定 + run 起点复核，漂移拒新 run） */
  securityIntegrity?: import('@octopi-agent/engine/harness/run/runner.js').SessionAwareRunnerConfig['securityIntegrity'];
  /** 命名凭证库策略（SEC-3c）；requireBindings=true 时无绑定凭证不可 resolve */
  credentials?: {
    requireBindings?: boolean;
  };
  /** Session ACL 角色目录（E6）；缺省内置五角色 */
  sessionAcl?: import('@octopi-agent/engine/harness/governance/session-acl/types.js').SessionAclConfig;
  /** send_file 外发限额；缺省 maxBytes=2GB，maxReleasesPerSession 不限 */
  fileSend?: {
    maxBytes?: number;
    maxReleasesPerSession?: number;
  };
  /** 可观测性（trace 落盘 / 采集意图）；与 config-bridge 同源，接线见 engine `wireObservability` */
  observability?: import('@octopi-agent/engine/config.js').HarnessConfig['observability'];
  /** 模型调用空闲超时（chunk 间最大静默，含首 token 等待），毫秒 */
  modelCallIdleTimeoutMs?: number;
  /** 模型调用绝对超时（单次调用总时长上限），毫秒 */
  modelCallAbsoluteTimeoutMs?: number;
  /**
   * 激活宿主构造参数（coalesce 窗口在 new AgentRuntime 时固定）。
   * Schedule/Escalate 由 daemon 经 configureAgentRuntime 挂载。
   */
  agentRuntime?: {
    coalesceWindowMs?: number;
    expectedMaxConcurrentRuns?: number;
    coalesceBufferLimit?: number;
  };
  /** SessionSchedule 预算与兜底 tick */
  schedules?: {
    maxOpenPerSession?: number;
    maxWakesPerHour?: number;
    tickIntervalMs?: number;
  };
  /** 产品 Observer 通道（Run 观测；生产可 summary/off） */
  observer?: import('@octopi-agent/engine/harness/observability/observer/types.js').ObserverConfig;
  /** system prompt 七层装配器调参（preview / content / budget ratio） */
  contextAssembler?: import('@octopi-agent/engine/config.js').ContextAssemblerConfig;
  context?: import('@octopi-agent/engine/config.js').HarnessConfig['context'];
  /** contextEngine 段（主动压缩 / 老化 / 工作目标）；与 config-bridge 同源 */
  contextEngine?: import('@octopi-agent/engine/config.js').ContextEngineConfig;
  /** runGuard 段；与 config-bridge 同源 */
  runGuard?: import('@octopi-agent/engine/config.js').RunGuardJsonConfig;
  /** security 段；与 config-bridge 同源 */
  security?: import('@octopi-agent/engine/config.js').HarnessConfig['security'];
  constitution?: import('@octopi-agent/engine/config.js').ConstitutionConfig;
  memory?: import('@octopi-agent/engine/config.js').HarnessConfig['memory'];
  /** 子系统框架配置（审计目录 / allow / deny）；与 config-bridge 同源 */
  subsystems?: import('@octopi-agent/engine/config.js').HarnessConfig['subsystems'];
  /** 认知图（cognition.steward.* 子系统参数）；与 config-bridge 同源 */
  cognition?: import('@octopi-agent/engine/config.js').HarnessConfig['cognition'];
  /** Wisdom 判断范式（wisdom.steward.* 子系统参数）；与 config-bridge 同源 */
  wisdom?: import('@octopi-agent/engine/config.js').HarnessConfig['wisdom'];
  /** 插件段（docs/plugin-system.md：启动时扫描 loadPaths）；整段透传，子键不丢 */
  plugins?: import('@octopi-agent/engine/config.js').HarnessConfig['plugins'];
  /** 并发控制（ProviderPool / SessionGate）；与 config-bridge 同源 */
  concurrency?: import('@octopi-agent/engine/config.js').HarnessConfig['concurrency'];
  /** Knowledge 全局缺省（agents[].knowledge.recall 覆盖） */
  knowledge?: import('@octopi-agent/engine/config.js').HarnessConfig['knowledge'];
  /** 公用能力 documents（DocumentPort 读抽取） */
  documents?: import('@octopi-agent/engine/config.js').HarnessConfig['documents'];
  /** models.embedding — 向量检索配置（memory 等共用） */
  embedding?: import('@octopi-agent/engine/config.js').EmbeddingModelConfig;
  /** models.providers — 供 embedding 继承 baseUrl/apiKey */
  modelProviders?: Record<string, import('@octopi-agent/engine/config.js').ModelProviderConfig>;
  /** models.level — 模型分级名（WebUI 模型目录） */
  levels?: Record<string, { primary: string; fallback?: string[] }>;
}
