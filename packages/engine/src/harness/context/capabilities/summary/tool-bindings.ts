/**
 * resolveSummaryToolBindings — `config.summary.tools` → tool 名绑定覆盖表。
 *
 * 自 src/cli/daemon.ts 迁入（B1 工具面单源化：装配工厂与 CLI 共用）。
 */

import type { ToolSummaryBinding } from './index.js';

/**
 * 解析 `config.summary.tools` 的 per-tool 绑定覆盖表（跳过 maxReturnChars 标量）。
 *
 * @param toolsCfg - `config.summary.tools`（形状经 config-schema 校验）
 * @returns tool 名 → binding 覆盖表
 */
export function resolveSummaryToolBindings(
  toolsCfg: Record<string, unknown> | undefined,
): Record<string, Partial<ToolSummaryBinding>> {
  const out: Record<string, Partial<ToolSummaryBinding>> = {};
  for (const [tool, value] of Object.entries(toolsCfg ?? {})) {
    if (tool === 'maxReturnChars') continue;
    if (value !== null && typeof value === 'object') {
      out[tool] = value as Partial<ToolSummaryBinding>;
    }
  }
  return out;
}
