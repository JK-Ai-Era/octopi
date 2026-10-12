/**
 * 记忆时间戳的 LLM 可读格式 — 与 Runtime `Current datetime` 同为本地墙上时钟
 */

/**
 * 格式化 epoch ms 为 `YYYY-MM-DD HH:mm`（本地时区）
 *
 * @param ms - epoch 毫秒
 * @returns 本地时钟字符串（分钟精度）
 */
export function formatMemoryClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 解析 memory_store 的 as_of 入参（epoch ms / 数字串 / 可被 Date.parse 的日期串）
 *
 * @param raw - 工具入参
 * @returns epoch ms；缺省返回 undefined
 * @throws 无法解析为时刻时抛出
 */
export function parseAsOf(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    throw new Error(`invalid_as_of: ${s} is not a date (use YYYY-MM-DD or epoch ms)`);
  }
  return t;
}

/**
 * 召回条目的时间后缀 — 显式标注 recorded / as of
 *
 * @param entry - 含 createdAt 与可选 asOf 的条目
 * @returns 以 ` · ` 开头的时间后缀；createdAt 缺失时返回空串
 */
export function formatMemoryTimeSuffix(entry: { createdAt?: number; asOf?: number }): string {
  if (entry.createdAt == null) return '';
  const recorded = formatMemoryClock(entry.createdAt);
  if (entry.asOf != null) {
    return ` · as of ${formatMemoryClock(entry.asOf)} · recorded ${recorded}`;
  }
  return ` · recorded ${recorded}`;
}
