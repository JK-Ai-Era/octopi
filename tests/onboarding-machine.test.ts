/**
 * 向导状态机回归（批 2-1 / 评审 M2 抽取）：nextStep 纯转移——
 * 步骤图 / 回退栈 / goto 精确落点 / commit 时机（B2 测通后、m5 exit save、
 * 走完防御、EOF 半截不组装）。
 */

import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_STEPS,
  initialOnboardingState,
  nextStep,
} from '../packages/engine/src/config-admin/onboarding.js';
import type { OnboardingMachineState } from '../packages/engine/src/config-admin/onboarding.js';

/** 驱动到指定步骤（全 next） */
function walkTo(step: string): OnboardingMachineState {
  let state = initialOnboardingState();
  while (state.current !== null && state.current !== step) {
    state = nextStep(state, { kind: 'next' }).state;
  }
  return state;
}

describe('nextStep 状态机', () => {
  it('next 顺序推进九步，走完 completed 且 commit=on-done', () => {
    let state = initialOnboardingState();
    const visited: string[] = [];
    let finalCommit = '';
    while (state.current !== null) {
      visited.push(state.current);
      const t = nextStep(state, { kind: 'next' });
      state = t.state;
      if (t.commit !== 'none') finalCommit = t.commit;
    }
    expect(visited).toEqual([...ONBOARDING_STEPS]);
    expect(state.completed).toBe(true);
    expect(state.aborted).toBe(false);
    expect(finalCommit).toBe('on-done');
  });

  it('B2：probe 步 next 的 commit=after-probe（services 动作前落盘）', () => {
    const state = walkTo('probe');
    const t = nextStep(state, { kind: 'next' });
    expect(t.commit).toBe('after-probe');
    expect(t.state.current).toBe('services');
  });

  it('back 沿回退栈精确回上一步；空栈提示 back-at-first 不动状态', () => {
    let state = walkTo('provider');
    const t1 = nextStep(state, { kind: 'back' });
    expect(t1.state.current).toBe('deployment-mode');
    expect(t1.commit).toBe('none');
    state = nextStep(t1.state, { kind: 'back' }).state;
    state = nextStep(state, { kind: 'back' }).state;
    state = nextStep(state, { kind: 'back' }).state; // welcome
    const t4 = nextStep(state, { kind: 'back' });
    expect(t4.notice).toBe('back-at-first'); // m13
    expect(t4.state.current).toBe('welcome');
    expect(t4.state.stack).toEqual([]);
  });

  it('goto 精确落点并入栈（M1：rekey→api-key / reprovider→provider）', () => {
    const state = walkTo('probe');
    const t = nextStep(state, { kind: 'goto', step: 'api-key' });
    expect(t.state.current).toBe('api-key');
    expect(t.state.stack[t.state.stack.length - 1]).toBe('probe');
    // 从 goto 点 back 能回到 probe
    const back = nextStep(t.state, { kind: 'back' });
    expect(back.state.current).toBe('probe');
  });

  it('exit save=true → commit=on-exit-save；save=false → 无 commit（m5 文案=行为）', () => {
    const state = walkTo('probe');
    const t1 = nextStep(state, { kind: 'exit', save: true });
    expect(t1.state.current).toBeNull();
    expect(t1.state.exitSave).toBe(true);
    expect(t1.commit).toBe('on-exit-save');
    const t2 = nextStep(walkTo('probe'), { kind: 'exit', save: false });
    expect(t2.commit).toBe('none');
    expect(t2.state.exitSave).toBe(false);
  });

  it('eof → aborted 且无 commit（半截状态不组装——批 1 EOF 尾巴）', () => {
    const t = nextStep(walkTo('model'), { kind: 'eof' });
    expect(t.state.current).toBeNull();
    expect(t.state.aborted).toBe(true);
    expect(t.state.completed).toBe(false);
    expect(t.commit).toBe('none');
  });

  it('终态吸收：结束后任何事件都不再改变状态', () => {
    const done = nextStep(walkTo('first-chat'), { kind: 'next' }).state;
    expect(done.current).toBeNull();
    const again = nextStep(done, { kind: 'next' });
    expect(again.state).toBe(done);
    expect(again.commit).toBe('none');
    const eof = nextStep(done, { kind: 'eof' });
    expect(eof.state).toBe(done); // 已 completed 不改判 aborted
  });
});
