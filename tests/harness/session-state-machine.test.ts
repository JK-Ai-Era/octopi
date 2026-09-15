/**
 * createSessionStateMachine — Harness Session 策略
 */

import { describe, it, expect } from 'vitest';
import { createSessionStateMachine } from '../../src/harness/session-state-machine.js';

describe('createSessionStateMachine', () => {
  it('idle → processing → idle', () => {
    const sm = createSessionStateMachine();
    sm.transition('processing');
    sm.transition('idle');
    expect(sm.state).toBe('idle');
  });

  it('processing → waiting_human → processing', () => {
    const sm = createSessionStateMachine();
    sm.transition('processing');
    sm.transition('waiting_human');
    sm.transition('processing');
    expect(sm.state).toBe('processing');
  });

  it('processing → error → idle', () => {
    const sm = createSessionStateMachine();
    sm.transition('processing');
    sm.transition('error');
    sm.transition('idle');
    expect(sm.state).toBe('idle');
  });

  it('idle 不能直接到 error', () => {
    const sm = createSessionStateMachine();
    expect(sm.canTransition('error')).toBe(false);
  });
});
