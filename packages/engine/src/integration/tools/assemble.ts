/**
 * assemble-global-tools — 全局工具面装配单源（daemon 与 run 节点共用）。
 *
 * 面分割（arch/service-topology.md §4/§10）：工具（tool）面随执行节点——生产执行在
 * run 实例进程内，工具必须在该进程构建（gateway 侧 `globalTools: []` 不是缺省而是无面）。
 * 本工厂把原 daemon 内联装配（summary L1/L2 端口 → session 历史端口 → 凭证库 →
 * web search → createToolSet）抽为共用单源，daemon 与 run-serve-child 各带一套调用点。
 *
 * 失败降级形态随原装配冻结（每块 try/catch + 显式 warn：L1-only / scan-only / 无凭证），
 * 降级是「真实尝试失败后」的兜底，不是占位返回。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { SessionHistoryOptions } from '../../harness/session/history/index.js';
import type { ToolSetConfig } from '../../harness/extension/plugin-ecosystem/tools/tool-set.js';
import type { AskUserCallback } from '../../harness/extension/plugin-ecosystem/tools/ask-user.js';
import { resolveSummaryToolBindings } from '../../harness/context/capabilities/summary/tool-bindings.js';

export interface GlobalToolSetContext {
  /** LLM provider 注册表（summary 压缩模型面；fallback = 首个注册值） */
  providers: Map<string, ModelProvider>;
  /** session_search / session_read 历史端口依赖（store 必填；index 缺省 = scan-only） */
  sessionHistory: SessionHistoryOptions;
  /** DocumentPort（gateway 共享实例 / run 节点自建）；null = document_* 不注册 */
  documentPort: NonNullable<ToolSetConfig['documentPort']> | null;
  /** ask_user 桥（daemon: gateway.askUser；run 节点: 跨通道配对） */
  askUser: AskUserCallback;
  /** OCTOPI_HOME（凭证库位置） */
  octopiHome: string;
  /** octopi.json summary 块（形状透传；内部按原装配收窄） */
  summary?: unknown;
  /** octopi.json models.level（summary 档位表） */
  levelMap?: unknown;
  /** octopi.json webSearch 块 */
  webSearch?: Parameters<
    typeof import('../web-search/factory.js').resolveWebSearchProviders
  >[0];
  /** credentials.requireBindings */
  requireCredentialBindings?: boolean;
  /** security.network.allowPrivateNetwork */
  allowPrivateNetwork?: boolean;
}

/**
 * 装配全局工具面。
 *
 * @param ctx - 装配依赖（provider/store/端口/配置块）
 * @returns 全局工具清单（builtin + extensions，形态同 createToolSet().all）
 */
export async function assembleGlobalTools(ctx: GlobalToolSetContext): Promise<RegisteredTool[]> {
  // ── Summary L1/L2 端口（http_request / file_read 压缩） ──
  let summarySupport: ToolSetConfig['summary'];
  try {
    const { createSummaryPort, createToolSummarySupport, createMemorySummaryCache } = await import(
      '../../harness/context/capabilities/summary/index.js'
    );
    const fallbackProvider = [...ctx.providers.values()][0];
    if (fallbackProvider) {
      const summaryCfg = ctx.summary as
        | {
            model?: string;
            modelLevel?: string;
            gate?: unknown;
            defaultInputBudgetTokens?: number;
            safetyMarginTokens?: number;
            oversizedStrategy?: unknown;
            cache?: { enabled?: boolean; maxEntries?: number; ttlMs?: number };
            policies?: Record<string, unknown>;
            tools?: {
              maxReturnChars?: number;
              http_request?: Record<string, unknown>;
              file_read?: Record<string, unknown>;
            };
          }
        | undefined;
      const toolsCfg = summaryCfg?.tools;

      let cache:
        | import('../../harness/context/capabilities/summary/index.js').SummaryCachePort
        | undefined;
      let cacheEnabled = false;
      if (summaryCfg?.cache?.enabled) {
        cache = createMemorySummaryCache({
          maxEntries: summaryCfg.cache.maxEntries,
          defaultTtlMs: summaryCfg.cache.ttlMs,
        });
        cacheEnabled = true;
      }

      const portOptions = {
        providers: ctx.providers,
        levelMap: ctx.levelMap as never,
        fallbackProvider,
        model: summaryCfg?.model,
        modelLevel: summaryCfg?.modelLevel,
        gate: summaryCfg?.gate as never,
        defaultInputBudgetTokens: summaryCfg?.defaultInputBudgetTokens,
        safetyMarginTokens: summaryCfg?.safetyMarginTokens,
        oversizedStrategy: summaryCfg?.oversizedStrategy as never,
        policyOverrides: summaryCfg?.policies as never,
        cache,
        cacheEnabled,
        cacheTtlMs: summaryCfg?.cache?.ttlMs,
        maxReturnCharsDefault: toolsCfg?.maxReturnChars,
        toolBindings: resolveSummaryToolBindings(toolsCfg as Record<string, unknown> | undefined),
      };
      const port = createSummaryPort(portOptions);
      summarySupport = createToolSummarySupport(port, portOptions);
    }
  } catch (err) {
    // 降级 = L1-only tools（真实尝试失败）；显式 warn 不静默
    console.warn(
      `[tools] summary capability wiring failed (L1-only tools): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── session_search / session_read（Information 历史检索） ──
  let sessionHistory: ToolSetConfig['sessionHistory'];
  try {
    const { createSessionHistoryPort } = await import('../../harness/session/history/index.js');
    sessionHistory = createSessionHistoryPort(ctx.sessionHistory);
  } catch (err) {
    console.warn(
      `[tools] session history tools unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── SEC-3c: named credentials（http_request.credential） ──
  let credentialStore: ToolSetConfig['credentials'] = null;
  try {
    const { CredentialStore } = await import('../../harness/governance/credentials/store.js');
    credentialStore = await CredentialStore.openDefault(ctx.octopiHome, {
      requireBindings: ctx.requireCredentialBindings ?? false,
    });
  } catch (err) {
    console.warn(
      `[tools] CredentialStore unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── web_search（未配置不注册） ──
  let webSearch: ToolSetConfig['webSearch'];
  if (ctx.webSearch?.providers && Object.keys(ctx.webSearch.providers).length > 0) {
    const { resolveWebSearchProviders, createWebSearchWithFallback } = await import(
      '../web-search/factory.js'
    );
    const resolved = resolveWebSearchProviders(ctx.webSearch);
    if (resolved.primary) {
      webSearch = {
        provider: createWebSearchWithFallback(resolved.primary, resolved.fallbacks),
        defaultLimit: resolved.defaultLimit,
        timeoutMs: resolved.timeoutMs,
      };
    }
  }

  const { createToolSet } = await import('../../harness/extension/plugin-ecosystem/tools/tool-set.js');
  const { all } = createToolSet({
    webSearch,
    summary: summarySupport,
    sessionHistory,
    documentPort: ctx.documentPort,
    credentials: credentialStore,
    network: { allowPrivateNetwork: ctx.allowPrivateNetwork ?? false },
    requireCredentialBindings: ctx.requireCredentialBindings ?? false,
    askUser: ctx.askUser,
  });
  return all;
}
