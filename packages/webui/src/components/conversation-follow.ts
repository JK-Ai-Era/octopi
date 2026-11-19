/**
 * 会话流“粘底跟随”状态归约（纯逻辑；DOM 滚动由 ChatWorkspace 执行）。
 *
 * 语义：stickToBottom 表达用户意图“跟随最新输出”。只有用户滚离底部才打断跟随。
 * 程序滚动（钉底）自身也会派发 scroll 事件，若在事件里一律按“距底距离”重算，
 * 会把自家钉底误判成用户上滑——一批多个工具卡片快速插入时，钉底事件派发前内容
 * 已长高，误判会让最后一条消息卡在视口下方且跟随永久停摆。故 scroll 事件必须先
 * 归属（自家钉底 / 用户滚动）再决定是否更新跟随意图。
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollFollowState {
  /** 用户意图：跟随输出滚到底（用户上滑后 false；回到底部或新一轮回复恢复 true） */
  stickToBottom: boolean;
  /** 最近一次程序滚动钉底后的实际 scrollTop；null 表示没有待归属的程序滚动 */
  pinnedScrollTop: number | null;
}

/** 距底部 ≤ 该阈值视为“在底部”：轻微布局抖动不打断跟随 */
export const BOTTOM_FOLLOW_THRESHOLD_PX = 48;

/** 与钉底锚点误差 ≤ 该阈值的 scroll 事件视为程序滚动（自家钉底）触发 */
export const PIN_ANCHOR_TOLERANCE_PX = 2;

/**
 * scroll 事件的跟随意图归约。
 *
 * @param state 当前跟随状态
 * @param metrics 事件发生时滚动容器的度量
 * @returns 归约后的跟随状态（不可变；调用方整体替换）
 */
export function reduceScrollEvent(
  state: ScrollFollowState,
  metrics: ScrollMetrics,
): ScrollFollowState {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  const anchor = state.pinnedScrollTop;
  if (
    state.stickToBottom &&
    anchor !== null &&
    Math.abs(scrollTop - anchor) <= PIN_ANCHOR_TOLERANCE_PX
  ) {
    // 自家钉底的回响：内容中途长高会拉大距底距离，不能据此判定用户上滑。
    // 锚点保持不动：若随回响推进，慢速滚轮（1–2px/帧）会棘轮式吞掉真实滚动
    return { stickToBottom: true, pinnedScrollTop: anchor };
  }
  return {
    stickToBottom: scrollHeight - scrollTop - clientHeight <= BOTTOM_FOLLOW_THRESHOLD_PX,
    pinnedScrollTop: null,
  };
}
