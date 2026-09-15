/**
 * StateMachine 机制测试（Core）
 * Session 策略工厂见 tests/harness/session-state-machine.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { StateMachine } from '../../src/core/primitives/state-machine.js';

describe('StateMachine', () => {
  it('初始状态正确', () => {
    const sm = new StateMachine({
      initial: 'idle',
      transitions: [{ from: 'idle', to: 'busy' }],
    });
    expect(sm.state).toBe('idle');
    expect(sm.previousState).toBeNull();
  });

  it('合法转换成功并记录 previousState', () => {
    const sm = new StateMachine({
      initial: 'idle',
      transitions: [
        { from: 'idle', to: 'busy' },
        { from: 'busy', to: 'idle' },
      ],
    });
    sm.transition('busy');
    expect(sm.state).toBe('busy');
    expect(sm.previousState).toBe('idle');
  });

  it('非法转换抛错并保持状态', () => {
    const sm = new StateMachine({
      initial: 'idle',
      transitions: [{ from: 'idle', to: 'busy' }],
    });
    expect(() => sm.transition('error')).toThrow(/Illegal state transition/);
    expect(sm.state).toBe('idle');
  });

  it('canTransition / allowedTransitions', () => {
    const sm = new StateMachine({
      initial: 'a',
      transitions: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'a' },
      ],
    });
    expect(sm.canTransition('b')).toBe(true);
    expect(sm.allowedTransitions().sort()).toEqual(['b', 'c']);
  });

  it('onTransition 回调收到 from/to', () => {
    const onTransition = vi.fn();
    const sm = new StateMachine({
      initial: 'idle',
      transitions: [{ from: 'idle', to: 'busy' }],
      onTransition,
    });
    sm.transition('busy');
    expect(onTransition).toHaveBeenCalledWith('idle', 'busy');
  });

  it('force 绕过检查', () => {
    const sm = new StateMachine({
      initial: 'idle',
      transitions: [{ from: 'idle', to: 'busy' }],
    });
    sm.force('error');
    expect(sm.state).toBe('error');
  });
});
