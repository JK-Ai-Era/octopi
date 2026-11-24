/**
 * 归档保留任务调度对齐（纯函数；gateway 生命周期装配在
 * `gateway/gateway.ts` → `startArchiveRetention`）
 *
 * 语义（arch/session-archive-recycle.md §7）：每日固定本地时刻（04:30）触发；
 * 任务体以 `purge_at`/时间比较实现、幂等，因此**漏跑可补、重复无副作用**。
 * 调度器只负责"什么时候跑"：以「最近一个已到时刻槽」比较 `retention.lastRun`
 * （注册表 meta 落盘），槽内重复启动不会重复跑，停机跨槽则启动补跑。
 *
 * @module
 */

/** 每日触发时刻（本地时区）：04:30 */
export const RETENTION_HOUR_LOCAL = 4;
/** 每日触发分钟（本地时区） */
export const RETENTION_MINUTE_LOCAL = 30;

/**
 * 以 now 所在自然日偏移 offsetDays 天的本地触发时刻（04:30:00.000）
 *
 * @param now - 参考时间戳
 * @param offsetDays - 天偏移（负=过去）
 * @returns 该日触发时刻时间戳
 */
function slotAt(now: number, offsetDays: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(RETENTION_HOUR_LOCAL, RETENTION_MINUTE_LOCAL, 0, 0);
  return d.getTime();
}

/**
 * 下一次触发时刻（严格晚于 now 的最近本地 04:30）
 *
 * @param now - 当前时间戳
 * @returns 下一触发时刻
 */
export function nextRetentionRunAt(now: number): number {
  const today = slotAt(now, 0);
  return today > now ? today : slotAt(now, 1);
}

/**
 * 最近一个已到时刻槽（<= now 的最近本地 04:30）
 *
 * @param now - 当前时间戳
 * @returns 已到槽时刻
 */
export function lastRetentionSlotAt(now: number): number {
  const today = slotAt(now, 0);
  return today <= now ? today : slotAt(now, -1);
}

/**
 * 是否需要跑一轮保留任务（补跑判定）
 *
 * @param lastRun - 上次完成任务时间戳（meta 落盘；null=从未跑过）
 * @param now - 当前时间戳
 * @returns true=需要跑（从未跑过 / 停机跨槽漏跑）；false=本槽已跑，跳过
 */
export function shouldRunRetention(lastRun: number | null, now: number): boolean {
  return lastRun === null || lastRun < lastRetentionSlotAt(now);
}
