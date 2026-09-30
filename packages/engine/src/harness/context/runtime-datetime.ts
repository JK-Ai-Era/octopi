/**
 * Runtime 环境锚点注入 — 每轮 system prompt 的时间与工作目录
 *
 * LLM 不感知墙上时钟，也不默认知道工具相对路径解析到哪。
 * 时间敏感任务（搜新闻、算截止日）与文件检索任务都需要引擎
 * 在 Runtime 层给出可更新的锚点，而不是依赖模型猜测或全盘扫描。
 */

/**
 * 格式化当前时间的 runtime 注入文案
 *
 * 精度到分钟，避免秒级抖动拖垮 assembler fingerprint 观测；
 * 时区取进程本地 IANA 名，与 Date 本地字段一致。
 *
 * @param now - 参考时刻，默认当前时间
 * @returns 注入字符串（单行时间锚点）
 */
export function formatRuntimeDatetimeInjection(now: Date = new Date()): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `Current datetime: ${date} ${time} (${timeZone})`;
}

/**
 * 格式化工作目录的 runtime 注入文案
 *
 * 工具相对路径解析到该目录；模型检索用户文件时应优先在此搜索，
 * 而不是扫全盘或猜项目根。
 *
 * @param cwd - 本 Run 的工具 cwd（agent.workspace / RunConfig.cwd）
 * @returns 注入字符串（工作目录锚点块；cwd 为空时返回空串）
 */
export function formatRuntimeWorkspaceInjection(cwd: string | undefined): string {
  const trimmed = cwd?.trim();
  if (!trimmed) return '';
  return [
    `Workspace: ${trimmed}`,
    'Relative tool paths resolve against this directory.',
    'Prefer searching here first for user files and task materials; do not scan the whole disk unless the user asks.',
    'User documents often live in subdirectories (e.g. docs/). To find a file by name, use file_list with a pattern (recursive by default) or give file_read the path under Workspace.',
  ].join('\n');
}

/**
 * 将 datetime（+ 可选 workspace）块拼入既有 injectedContext
 *
 * 锚点在前：datetime → workspace → 既有注入（tasks / guidance）。
 * 保留 `withRuntimeDatetimeInjection` 作为仅时间锚点的兼容入口。
 *
 * @param injectedContext - 本轮已有的注入（tasks / guidance 等），可为空
 * @param options - now 参考时刻；cwd 工具工作目录
 * @returns 组合后的 injectedContext
 */
export function withRuntimeEnvironmentInjection(
  injectedContext: string | undefined,
  options?: { now?: Date; cwd?: string | undefined },
): string {
  const now = options?.now ?? new Date();
  const blocks = [formatRuntimeDatetimeInjection(now)];
  const ws = formatRuntimeWorkspaceInjection(options?.cwd);
  if (ws) blocks.push(ws);
  const base = (injectedContext ?? '').trim();
  if (base) blocks.push(base);
  return blocks.join('\n\n');
}

/**
 * 将 datetime 块拼入既有 injectedContext（datetime 在前）
 *
 * @param injectedContext - 本轮已有的注入（tasks / guidance 等），可为空
 * @param now - 参考时刻，默认当前时间
 * @returns 组合后的 injectedContext
 */
export function withRuntimeDatetimeInjection(
  injectedContext: string | undefined,
  now: Date = new Date(),
): string {
  return withRuntimeEnvironmentInjection(injectedContext, { now });
}
