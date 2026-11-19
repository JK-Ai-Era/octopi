import { describe, expect, it } from 'vitest';
import {
  COMPENSATION_STAY_TOLERANCE_PX,
  createViewportAuthority,
  shouldApplyCompensation,
} from './viewport-authority';

describe('viewport authority（视口写权威协议）', () => {
  it('take/release 基本语义：持有期间 isHeld，交还后释放', () => {
    const authority = createViewportAuthority();
    expect(authority.isHeld()).toBe(false);
    const owner = authority.take();
    expect(authority.isHeld()).toBe(true);
    expect(authority.release(owner)).toBe(true);
    expect(authority.isHeld()).toBe(false);
  });

  it('后取者胜：旧持有者的交还不越权解锁（C8 回归）', () => {
    const authority = createViewportAuthority();
    const first = authority.take();
    const second = authority.take();
    expect(authority.release(first)).toBe(false);
    expect(authority.isHeld()).toBe(true); // 仍在第二持有者手上
    expect(authority.release(second)).toBe(true);
    expect(authority.isHeld()).toBe(false);
  });

  it('markScrolled：只有现持有者能置位，过期标记无效', () => {
    const authority = createViewportAuthority();
    const first = authority.take();
    const second = authority.take();
    authority.markScrolled(first); // 过期持有者：无效
    expect(authority.shouldDropCompensation(first)).toBe(false);
    authority.markScrolled(second);
    expect(authority.shouldDropCompensation(first)).toBe(true);
  });

  it('补偿写丢弃规则（C7 回归）：只丢「他人已滚动」场景', () => {
    const authority = createViewportAuthority();
    // 自己补偿自己：照常执行（分页回顶 restore 修复自己的 prepend）
    const wrapper = authority.take();
    expect(authority.shouldDropCompensation(wrapper)).toBe(false);
    // 跳转接管但尚未滚动：被吞掉的 restore 仍可落地修补（拒绝跳转也不丢补偿）
    const jump = authority.take();
    expect(authority.shouldDropCompensation(wrapper)).toBe(false);
    // 跳转已滚动：旧 restore 必须让路，不得掐断平滑滚动
    authority.markScrolled(jump);
    expect(authority.shouldDropCompensation(wrapper)).toBe(true);
    // 跳转自己的补偿不受影响
    expect(authority.shouldDropCompensation(jump)).toBe(false);
    // 交还后无人持有：补偿照常（普通滚动触发的 prepend 回顶）
    authority.release(jump);
    const later = authority.take();
    authority.release(later);
    expect(authority.shouldDropCompensation(later)).toBe(false);
  });

  it('reset（会话切换）作废世代：陈旧补偿一律让路（评审#2 回归）', () => {
    const authority = createViewportAuthority();
    const stale = authority.take();
    authority.markScrolled(stale);
    authority.reset();
    expect(authority.isHeld()).toBe(false);
    expect(authority.release(stale)).toBe(false); // 过期交还不得解锁他人后续的持有
    // 陈旧补偿属于旧会话视口：一律让路，不得落到新会话（此前误放行）
    expect(authority.shouldDropCompensation(stale)).toBe(true);
    const fresh = authority.take();
    expect(authority.release(stale)).toBe(false);
    expect(authority.shouldDropCompensation(fresh)).toBe(false); // 新世代自己的补偿照常
    expect(authority.release(fresh)).toBe(true);
  });

  it('无主时 release / markScrolled 均为安全 no-op', () => {
    const authority = createViewportAuthority();
    expect(authority.release(Symbol('ghost'))).toBe(false);
    authority.markScrolled(Symbol('ghost'));
    expect(authority.isHeld()).toBe(false);
  });

  it('isProgrammaticScroll：仅持有者已执行视口写时为真（scroll 回响归属判据）', () => {
    const authority = createViewportAuthority();
    expect(authority.isProgrammaticScroll()).toBe(false);
    const owner = authority.take();
    // 持有但尚未写视口（加载在途）：用户滚动是真实意图，仍须判定
    expect(authority.isProgrammaticScroll()).toBe(false);
    authority.markScrolled(owner);
    expect(authority.isProgrammaticScroll()).toBe(true);
    authority.release(owner);
    expect(authority.isProgrammaticScroll()).toBe(false);
  });
});

describe('shouldApplyCompensation（回顶补偿落地判定）', () => {
  it('原位未动（无 scroll anchoring 浏览器）→ 落地', () => {
    expect(shouldApplyCompensation({ scrollTop: 100, prevTop: 100, delta: 500 })).toBe(true);
  });

  it('浏览器 anchoring 已补偿到 prevTop+delta → 落地', () => {
    expect(shouldApplyCompensation({ scrollTop: 600, prevTop: 100, delta: 500 })).toBe(true);
  });

  it('用户在加载期间回到最底部 → 不得拽回（回归：盲写误杀粘底跟随）', () => {
    expect(shouldApplyCompensation({ scrollTop: 5000, prevTop: 40, delta: 500 })).toBe(false);
  });

  it('0 条加载（delta=0）且用户已离开 → 不得把人拽回顶部', () => {
    expect(shouldApplyCompensation({ scrollTop: 5000, prevTop: 40, delta: 0 })).toBe(false);
  });

  it('容差边界取默认常量，可显式覆盖', () => {
    expect(
      shouldApplyCompensation({ scrollTop: 100 + COMPENSATION_STAY_TOLERANCE_PX, prevTop: 100, delta: 999 }),
    ).toBe(true);
    expect(
      shouldApplyCompensation({ scrollTop: 100 + COMPENSATION_STAY_TOLERANCE_PX + 1, prevTop: 100, delta: 999 }),
    ).toBe(false);
    expect(shouldApplyCompensation({ scrollTop: 130, prevTop: 100, delta: 999, tolerancePx: 40 })).toBe(true);
  });

  it('短滚动条（候选二≈真实底部）→ 落地', () => {
    // maxScroll=120；anchoring 后 scrollTop=110，prevTop=10、delta=100 → 候选二在容差内
    expect(shouldApplyCompensation({ scrollTop: 110, prevTop: 10, delta: 100 })).toBe(true);
  });
});
