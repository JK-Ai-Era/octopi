/**
 * engine 段组合（→ 未来 @octopi-agent/engine 的 engineConfigSchema）
 *
 * @module
 */
import { z } from 'zod';
import { AgentConfigSchema, ChannelConfigSchema, PluginConfigSchema } from './agent.js';
import { DefaultsSchema, ModelsConfigSchema } from './models.js';
import {
  AgentRuntimeJsonConfigSchema,
  BudgetPolicyJsonConfigSchema,
  ConcurrencyConfigSchema,
  RunGuardJsonConfigSchema,
} from './run.js';
import {
  CompactCapabilityConfigSchema,
  ConstitutionConfigSchema,
  ContextAssemblerConfigSchema,
  ContextEngineConfigSchema,
  DocumentsConfigSchema,
  SummaryConfigSchema,
} from './context.js';
import { CognitionConfigSchema, KnowledgeConfigSchema, MemoryConfigSchema } from './substrate.js';
import {
  SecurityConfigSchema,
  SessionAclConfigSchema,
  SessionConfigSchema,
  ToolIsolationConfigSchema,
} from './governance.js';
import { ObservabilityConfigSchema, ObserverConfigSchema } from './observability.js';
import { WebSearchConfigSchema } from './web-search.js';
import { SubsystemsConfigSchema } from './subsystems.js';

/** engine 拥有的顶层配置段（不含 web / gateway 外挂段） */
export const engineConfigSchema = z.object({
  subsystems: SubsystemsConfigSchema.optional(),
  agents: z.array(AgentConfigSchema).min(1, 'Config must define at least one agent'),
  models: ModelsConfigSchema,
  defaults: z.object({
    contextWindow: z.number().positive().optional(),
  }).optional(),
  plugins: PluginConfigSchema.optional(),
  budgetPolicy: BudgetPolicyJsonConfigSchema.optional(),
  runGuard: RunGuardJsonConfigSchema.optional(),
  agentRuntime: AgentRuntimeJsonConfigSchema.optional(),
  contextEngine: ContextEngineConfigSchema.optional(),
  contextAssembler: ContextAssemblerConfigSchema.optional(),
  /** 公用能力 summary（capabilities） */
  summary: SummaryConfigSchema.optional(),
  /** 公用能力 compact 缺省 */
  compact: CompactCapabilityConfigSchema.optional(),
  /** 公用能力 documents（DocumentPort 读抽取） */
  documents: DocumentsConfigSchema.optional(),
  /** Knowledge 全局缺省（agents[].knowledge.recall 覆盖） */
  knowledge: KnowledgeConfigSchema.optional(),
  context: z
    .object({
      constitution: ConstitutionConfigSchema.optional(),
      contextAssembler: ContextAssemblerConfigSchema.optional(),
    })
    .optional(),
  constitution: ConstitutionConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  cognition: CognitionConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
  channels: z.array(ChannelConfigSchema).optional(),
  session: SessionConfigSchema.optional(),
  /** 工具效应隔离策略（宪法 I5）；默认 none */
  toolIsolation: ToolIsolationConfigSchema.optional(),
  /** Session ACL 角色目录（E6）；缺省 = 内置五角色 */
  sessionAcl: SessionAclConfigSchema.optional(),
  observability: ObservabilityConfigSchema.optional(),
  observer: ObserverConfigSchema,
  concurrency: ConcurrencyConfigSchema.optional(),
  webSearch: WebSearchConfigSchema.optional(),
});

export type EngineConfig = z.infer<typeof engineConfigSchema>;
