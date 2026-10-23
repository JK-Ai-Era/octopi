/**
 * Config Schema 组合入口（套件职责）
 *
 * - 按包拥有片段：engine / webui / gateway（见 arch/npm-package-split.md §5）
 * - 用户仍只维护一份 `octopi.json`
 * - 本模块负责：组合 schema、整文件校验、跨段交叉校验
 *
 * @module
 */
import { z } from 'zod';

import { engineConfigSchema } from '@octopi-agent/engine/config-schema/engine.js';
import { expandHomePath } from '@octopi-agent/engine/paths.js';
import { GatewayOverrideConfigSchema } from '@octopi-agent/gateway/config-schema/gateway.js';
import { WebConfigSchema } from './webui.js';

// ── 公开片段 re-export（兼容旧 import 路径）──

export {
  AgentConfigSchema,
  ChannelConfigSchema,
  PluginConfigSchema,
} from '@octopi-agent/engine/config-schema/agent.js';
export {
  DefaultsSchema,
  ModelsConfigSchema,
  ModelDefinitionSchema,
} from '@octopi-agent/engine/config-schema/models.js';
export {
  AgentRuntimeJsonConfigSchema,
  BudgetPolicyJsonConfigSchema,
  ConcurrencyConfigSchema,
  RunGuardJsonConfigSchema,
} from '@octopi-agent/engine/config-schema/run.js';
export {
  CompactCapabilityConfigSchema,
  ConstitutionConfigSchema,
  ContextAssemblerConfigSchema,
  ContextEngineConfigSchema,
  SummaryConfigSchema,
} from '@octopi-agent/engine/config-schema/context.js';
export {
  KnowledgeConfigSchema,
  MemoryConfigSchema,
  WisdomConfigSchema,
} from '@octopi-agent/engine/config-schema/substrate.js';
export {
  SecurityConfigSchema,
  SessionAclConfigSchema,
  SessionConfigSchema,
  SessionRightsSchema,
  ToolIsolationConfigSchema,
  FileSendConfigSchema,
} from '@octopi-agent/engine/config-schema/governance.js';
export {
  ObservabilityConfigSchema,
  ObserverConfigSchema,
} from '@octopi-agent/engine/config-schema/observability.js';
export { WebSearchConfigSchema } from '@octopi-agent/engine/config-schema/web-search.js';
export { SubsystemsConfigSchema } from '@octopi-agent/engine/config-schema/subsystems.js';
export { WebConfigSchema } from './webui.js';
export { GatewayOverrideConfigSchema } from '@octopi-agent/gateway/config-schema/gateway.js';
export { engineConfigSchema } from '@octopi-agent/engine/config-schema/engine.js';
export { NetworkHostSchema } from '@octopi-agent/engine/config-schema/shared.js';

/**
 * 完整配置 Schema（单文件）
 *
 * = engine 段 + 可选 `web`（webui）+ 可选 `gateway` 覆盖（进程面）。
 * 历史名 `HarnessConfigSchema` 保留为兼容别名。
 */
export const OctopiConfigSchema = engineConfigSchema.extend({
  /** 未来 @octopi-agent/gateway 进程面覆盖；无键时由 toGatewayConfig() 派生 */
  gateway: GatewayOverrideConfigSchema.optional(),
  /** 未来 @octopi-agent/webui */
  web: WebConfigSchema.optional(),
});

/** @deprecated 使用 {@link OctopiConfigSchema}；历史名保留 */
export const HarnessConfigSchema = OctopiConfigSchema;

export type OctopiConfig = z.infer<typeof OctopiConfigSchema>;

// ── 校验结果类型 ──

export interface ConfigValidationResult {
  success: boolean;
  data?: z.infer<typeof OctopiConfigSchema>;
  errors?: ConfigValidationError[];
}

export interface ConfigValidationError {
  path: string;
  message: string;
  code: string;
}

/**
 * 路径归一化后置条件：`~` 形态展开为主目录（Windows/Linux/macOS 通用，幂等，
 * trim → expand）。`validateConfig` / `validateConfigOrThrow` / `loadConfig` 的
 * 返回值都过这里——校验 API 与加载 API 后置条件一致，库调用方组合
 * 「validate + buildFromConfig」不再踩未展开的 `~`（留观②）。
 *
 * @param config - 校验通过的配置对象（就地展开）
 */
export function normalizeConfigPaths(config: z.infer<typeof OctopiConfigSchema>): void {
  const cfg = config as unknown as {
    effectPolicy?: { transactionRoots?: string[] };
    agents?: Array<{ workspace?: string; effectPolicy?: { transactionRoots?: string[] } }>;
  };
  const expandPolicy = (policy?: { transactionRoots?: string[] }): void => {
    if (policy?.transactionRoots) {
      policy.transactionRoots = policy.transactionRoots.map((p) => expandHomePath(p.trim()));
    }
  };
  expandPolicy(cfg.effectPolicy);
  for (const agent of cfg.agents ?? []) {
    if (agent.workspace) agent.workspace = expandHomePath(agent.workspace.trim());
    expandPolicy(agent.effectPolicy);
  }
}

/**
 * 校验配置数据
 *
 * @param raw - 原始 JSON 对象
 * @returns 校验结果（包含结构化错误信息；成功时 data 已路径归一化）
 */
export function validateConfig(raw: unknown): ConfigValidationResult {
  const result = OctopiConfigSchema.safeParse(raw);

  if (result.success) {
    normalizeConfigPaths(result.data);
    return { success: true, data: result.data };
  }

  const errors: ConfigValidationError[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: extractBestMessage(issue),
    code: issue.code,
  }));

  return { success: false, errors };
}

/**
 * 校验并抛出（用于 loadConfig 内部）
 *
 * @param raw - 原始 JSON 对象
 * @returns 校验后的配置
 * @throws 校验失败时抛出格式化错误
 */
export function validateConfigOrThrow(raw: unknown): z.infer<typeof OctopiConfigSchema> {
  const result = validateConfig(raw);
  if (result.success) {
    const config = result.data!;

    // ── 交叉校验：slot 引用的 provider 必须存在 ──
    if (config.concurrency?.providerPool && config.models?.providers) {
      const providerNames = new Set(Object.keys(config.models.providers));
      for (const slot of config.concurrency.providerPool.slots) {
        if (!providerNames.has(slot.provider)) {
          throw new Error(
            `Config validation failed:\n  concurrency.providerPool.slots: ` +
            `provider "${slot.provider}" not found in models.providers. ` +
            `Available: ${[...providerNames].join(', ')}`,
          );
        }
      }
    }

    return config;
  }

  const lines = result.errors!.map((e) => `  ${e.path || '(root)'}: ${e.message}`);
  throw new Error(
    `Config validation failed:\n${lines.join('\n')}`,
  );
}

/**
 * 从 Zod issue 中提取最具体的错误消息
 *
 * 对于 union 类型的错误，深入到子错误中找到最相关的消息。
 */
function extractBestMessage(issue: z.ZodIssue): string {
  if (issue.code === 'invalid_union' && 'errors' in issue && Array.isArray(issue.errors)) {
    let best = 'Invalid input';
    for (const group of issue.errors) {
      if (Array.isArray(group)) {
        for (const sub of group) {
          if (sub.message && sub.message !== 'Invalid input' && !sub.message.startsWith('Invalid input:')) {
            return sub.message;
          }
          if (sub.message && sub.message.startsWith('Invalid input:')) {
            best = sub.message;
          }
        }
      }
    }
    return best;
  }
  return issue.message;
}
