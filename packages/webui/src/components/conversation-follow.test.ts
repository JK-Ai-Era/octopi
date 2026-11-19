import { describe, it, expect } from 'vitest';
import {
  BOTTOM_FOLLOW_THRESHOLD_PX,
  PIN_ANCHOR_TOLERANCE_PX,
  reduceScrollEvent,
  type ScrollFollowState,
} from './conversation-follow';

/** 模拟钉底后的容器：scrollTop 已被浏览器钳到 scrollHeight - clientHeight */
function pinned(height: number, clientHeight = 800): ScrollFollowState & { bottom: number } {
  const bottom = height - clientHeight;
  return { stickToBottom: true, pinnedScrollTop: bottom, bottom };
}

describe('reduceScrollEvent（会话流粘底跟随意图）', () => {
  it('钉底回响在内容长高后仍保持跟随（批量工具卡片竞态回归）', () => {
    // 钉底时高 1000（bottom=200），随后多个工具卡片插入长到 1300；
    // 钉底 scroll 事件此刻才派发：距底 300 > 阈值，但位置与锚点一致，不得判定为用户上滑
    const state = pinned(1000);
    const next = reduceScrollEvent(state, {
      scrollTop: state.bottom,
      scrollHeight: 1300,
      clientHeight: 800,
    });
    expect(next.stickToBottom).toBe(true);
    expect(next.pinnedScrollTop).toBe(state.bottom);
  });

  it('用户滚离底部则打断跟随并清空锚点', () => {
    const state = pinned(1000);
    const next = reduceScrollEvent(state, {
      scrollTop: state.bottom - 300,
      scrollHeight: 1000,
      clientHeight: 800,
    });
    expect(next.stickToBottom).toBe(false);
    expect(next.pinnedScrollTop).toBeNull();
  });

  it('用户手动回到底部恢复跟随', () => {
    const state: ScrollFollowState = { stickToBottom: false, pinnedScrollTop: null };
    const next = reduceScrollEvent(state, {
      scrollTop: 500,
      scrollHeight: 1300,
      clientHeight: 800,
    });
    expect(next.stickToBottom).toBe(true);
    expect(next.pinnedScrollTop).toBeNull();
  });

  it(`锚点 ±${PIN_ANCHOR_TOLERANCE_PX}px 内视为程序滚动，之外按用户滚动重算`, () => {
    const state = pinned(1000);
    // 内容长高 300：只有程序回响能保住跟随，任何真实位移都按距底距离判定
    const atAnchor = reduceScrollEvent(state, {
      scrollTop: state.bottom - PIN_ANCHOR_TOLERANCE_PX,
      scrollHeight: 1300,
      clientHeight: 800,
    });
    expect(atAnchor.stickToBottom).toBe(true);

    const beyondAnchor = reduceScrollEvent(state, {
      scrollTop: state.bottom - PIN_ANCHOR_TOLERANCE_PX - 1,
      scrollHeight: 1300,
      clientHeight: 800,
    });
    expect(beyondAnchor.stickToBottom).toBe(false);
  });

  it('无待归属程序滚动时按距底距离判定（阈值边界含端点）', () => {
    const state: ScrollFollowState = { stickToBottom: true, pinnedScrollTop: null };
    const atThreshold = reduceScrollEvent(state, {
      scrollTop: 1800 - 800 - BOTTOM_FOLLOW_THRESHOLD_PX,
      scrollHeight: 1800,
      clientHeight: 800,
    });
    expect(atThreshold.stickToBottom).toBe(true);

    const pastThreshold = reduceScrollEvent(state, {
      scrollTop: 1800 - 800 - BOTTOM_FOLLOW_THRESHOLD_PX - 1,
      scrollHeight: 1800,
      clientHeight: 800,
    });
    expect(pastThreshold.stickToBottom).toBe(false);
  });

  it('跟随中但无锚点的普通事件按距离重算，不吞用户意图', () => {
    const state: ScrollFollowState = { stickToBottom: true, pinnedScrollTop: null };
    const next = reduceScrollEvent(state, {
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 800,
    });
    expect(next.stickToBottom).toBe(false);
    expect(next.pinnedScrollTop).toBeNull();
  });

  it('回响不推进锚点：慢速 1px 滚轮棘轮超出阈值后仍会打断跟随', () => {
    // 钉底在 bottom=5000（scrollHeight 5800 / clientHeight 800）；用户以 1px/事件向上滚
    let state: ScrollFollowState = { stickToBottom: true, pinnedScrollTop: 5000 };
    // 前两次事件落在 ±2px 容差内：视为钉底回响，锚点保持 5000（不得跟着推进）
    state = reduceScrollEvent(state, { scrollTop: 4999, scrollHeight: 5800, clientHeight: 800 });
    expect(state).toEqual({ stickToBottom: true, pinnedScrollTop: 5000 });
    state = reduceScrollEvent(state, { scrollTop: 4998, scrollHeight: 5800, clientHeight: 800 });
    expect(state).toEqual({ stickToBottom: true, pinnedScrollTop: 5000 });
    // 超出容差后按距底距离判定：48px 阈值耗尽前保持跟随
    for (let scrollTop = 4996; scrollTop > 4951; scrollTop -= 1) {
      state = reduceScrollEvent(state, { scrollTop, scrollHeight: 5800, clientHeight: 800 });
    }
    expect(state.stickToBottom).toBe(true); // 距底 48 仍在阈值内
    state = reduceScrollEvent(state, { scrollTop: 4951, scrollHeight: 5800, clientHeight: 800 });
    expect(state.stickToBottom).toBe(false); // 距底 49 打断跟随
  });

  it('follow=false 时残留锚点不得吞事件：一律按用户滚动重算（可回底恢复）', () => {
    // 钉底/切会话等路径可能留下 follow=false + 锚点残留 的组合
    const stale: ScrollFollowState = { stickToBottom: false, pinnedScrollTop: 5000 };
    // 位置恰好等于残留锚点，但意图已是“不跟随”：必须按距离重算，不得当作回响
    const away = reduceScrollEvent(stale, { scrollTop: 5000, scrollHeight: 6300, clientHeight: 800 });
    expect(away.stickToBottom).toBe(false);
    expect(away.pinnedScrollTop).toBeNull();
    const backToBottom = reduceScrollEvent(stale, { scrollTop: 5500, scrollHeight: 6300, clientHeight: 800 });
    expect(backToBottom.stickToBottom).toBe(true);
    expect(backToBottom.pinnedScrollTop).toBeNull();
  });
});
