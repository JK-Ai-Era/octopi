/**
 * TUI 断线重连策略（纯函数）。
 *
 * 语义：指数退避 + 连续次数上限。重连期间输入不丢（发送时连接未就绪
 * 会明确报错），放弃后退出由调用方处理。
 */

export interface ReconnectPlan {
  /** 连续尝试上限（超出即放弃） */
  maxAttempts: number;
  /** 首次重连延迟（ms） */
  baseDelayMs: number;
  /** 单次延迟上限（ms） */
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT_PLAN: ReconnectPlan = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 16_000,
};

/**
 * 第 n 次重连的等待时长（指数退避：base × 2^(n-1)，封顶 maxDelayMs）。
 *
 * @param attempt - 第几次重连（1 起；非正数按 1 处理）
 * @param plan - 策略参数（缺省 DEFAULT_RECONNECT_PLAN）
 * @returns 等待毫秒数
 */
export function reconnectDelay(
  attempt: number,
  plan: ReconnectPlan = DEFAULT_RECONNECT_PLAN,
): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(plan.baseDelayMs * 2 ** (n - 1), plan.maxDelayMs);
}
