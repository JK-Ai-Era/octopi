/**
 * Gateway 配置类型
 *
 * Integration 层类型。Gateway 是 Integration 层组件。
 */

import type { AgentDefinition } from '../../harness/types/agent-definition.js';

export interface GatewayConfig {
  port?: number;
  agents: AgentDefinition[];
  /** Run 安全阀/策略；见 arch/budget-redesign.md（无 nominal token hard） */
  budgetPolicy?: {
    maxIterations?: number;
    maxToolCalls?: number;
    maxWallClockMs?: number;
  };
  session?: {
    dmScope?: 'main' | 'per-peer' | 'per-channel-peer';
    reset?: {
      dailyHour?: number;
      idleMinutes?: number;
    };
    maintenance?: {
      mode?: 'warn' | 'enforce';
      pruneAfter?: string;
      maxEntries?: number;
    };
  };
  /** 工具效应隔离策略（宪法 I5）；默认 none */
  toolIsolation?: 'none' | 'session-subdir' | 'session-lock';
  /** Session ACL 角色目录（E6）；缺省内置五角色 */
  sessionAcl?: import('../../harness/session-acl/types.js').SessionAclConfig;
  trace?: {
    outputDir?: string;
    level?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';
    captureToolArgs?: boolean;
    captureToolResults?: boolean;
  };
  modelCallIdleTimeoutMs?: number;
  /**
   * 激活宿主构造参数（coalesce 窗口在 new AgentRuntime 时固定）。
   * Schedule/Escalate 由 daemon 经 configureAgentRuntime 挂载。
   */
  agentRuntime?: {
    coalesceWindowMs?: number;
    expectedMaxConcurrentRuns?: number;
    coalesceBufferLimit?: number;
  };
  /** 产品 Observer 通道（Run 观测；生产可 summary/off） */
  observer?: import('../../harness/observer/types.js').ObserverConfig;
  /** system prompt 七层装配器调参（preview / content / budget ratio） */
  contextAssembler?: import('../../config.js').ContextAssemblerConfig;
  context?: import('../../config.js').HarnessConfig['context'];
  constitution?: import('../../config.js').ConstitutionConfig;
  memory?: import('../../config.js').HarnessConfig['memory'];
  /** Knowledge 全局缺省（agents[].knowledge.recall 覆盖） */
  knowledge?: import('../../config.js').HarnessConfig['knowledge'];
  /** models.embedding — 向量检索配置（memory 等共用） */
  embedding?: import('../../config.js').EmbeddingModelConfig;
  /** models.providers — 供 embedding 继承 baseUrl/apiKey */
  modelProviders?: Record<string, import('../../config.js').ModelProviderConfig>;
  /** models.level — 模型分级名（WebUI 模型目录） */
  levels?: Record<string, { primary: string; fallback?: string[] }>;
}
