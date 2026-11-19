import { describe, expect, it } from 'vitest';
import { createViewportAuthority } from './viewport-authority';

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
    // 无人持有时补偿照常执行（普通滚动触发的 prepend 回顶不受影响）
    expect(authority.shouldDropCompensation(wrapperOwner())).toBe(false);
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
  });

  it('reset（会话切换）作废在途持有：旧持有者动作全部落空（C5 回归）', () => {
    const authority = createViewportAuthority();
    const stale = authority.take();
    authority.markScrolled(stale);
    authority.reset();
    expect(authority.isHeld()).toBe(false);
    expect(authority.release(stale)).toBe(false); // 过期交还不得解锁他人后续的持有
    expect(authority.shouldDropCompensation(stale)).toBe(false);
    const fresh = authority.take();
    expect(authority.release(stale)).toBe(false);
    expect(authority.release(fresh)).toBe(true);
  });

  it('无主时 release / markScrolled 均为安全 no-op', () => {
    const authority = createViewportAuthority();
    expect(authority.release(Symbol('ghost'))).toBe(false);
    authority.markScrolled(Symbol('ghost'));
    expect(authority.isHeld()).toBe(false);
  });
});

/** 用独立 symbol 模拟「分页回顶」持有者 */
function wrapperOwner(): symbol {
  return Symbol('wrapper');
}
