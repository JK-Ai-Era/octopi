/**
 * 模型调用错误的重试上限（单一事实源）
 *
 * 为什么集中在一处：生产链路由 `AgentBuilder` 注入 `DefaultErrorStrategy`，
 * `runAgentWithReliability` 的兜底分支只在未注入时生效。两处各写一套数字，
 * 很容易出现「改了一处、线上还是旧策略」的漂移。
 *
 * ## 为什么 timeout 保持 3 次（2026-10-27 修正）
 *
 * 曾经把它降到 1 次，理由是「一次 timeout 已耗掉整个 watchdog 窗口，再赌 3 轮就是
 * 52 分钟黑屏」。那是把**症状**当成了**病因**：52 分钟来自「单次尝试耗时过长」
 * 叠加「全程零反馈」，不是来自重试次数。砍次数只是让最坏时长变小，代价是
 * 削弱了上游抖动时的自愈能力——这正是「让系统看起来好了」而不是修好了。
 *
 * 真正的修复在别处：
 * - 单次尝试有界：回退链单节点预算（`fallbackAttemptTtftMs`）使有备选时 90s 即切换
 * - 重试过程可见：`engine.model_retry` 事件 + WebUI 角标，用户知道在第几次、还要等多久
 * - 重试过程可中止：退避等待响应 abort，用户不必等满整个序列
 *
 * 三者俱备后，3 次重试是安全的：用户全程看得到、随时能停。
 *
 * @module harness/run/reliability/model-error-policy
 */

/** 各错误原因的最大重试次数（不含首次尝试） */
export const MODEL_ERROR_MAX_ATTEMPTS: Readonly<Record<string, number>> = {
  rate_limit: 3,
  timeout: 3,
  network: 3,
  server: 2,
  // 内容过滤拒答多为阈值型误杀（同请求重试常过）；给 2 次原样重试，
  // 仍被拦则如实收口（不教模型换说法绕过审核）
  content_filter: 2,
};

/**
 * 查询某错误原因允许的重试次数
 *
 * @param reason - `classifyError` 给出的错误原因
 * @returns 最大重试次数；不可重试的原因返回 0
 */
export function maxAttemptsFor(reason: string): number {
  return MODEL_ERROR_MAX_ATTEMPTS[reason] ?? 0;
}
