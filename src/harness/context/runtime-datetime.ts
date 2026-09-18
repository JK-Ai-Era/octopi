/**
 * Runtime datetime 注入 — 每轮 system prompt 的时间锚点
 *
 * LLM 不感知墙上时钟；时间敏感任务（搜新闻、算截止日）需要引擎
 * 在 Runtime 层给出可更新的当前时间，而不是依赖模型训练截止日。
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
  const timeBlock = formatRuntimeDatetimeInjection(now);
  const base = (injectedContext ?? '').trim();
  return base ? `${timeBlock}\n\n${base}` : timeBlock;
}
