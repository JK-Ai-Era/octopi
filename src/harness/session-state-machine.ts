/**
 * Session 状态机工厂
 *
 * @layer harness — Session 生命周期**策略**，非 Core。
 * 通用 StateMachine 机制见 core/primitives/state-machine.ts。
 */

import { StateMachine } from '../core/primitives/state-machine.js';
import type { SessionStatus } from '../core/types.js';

/**
 * Session 状态机
 *
 * 合法转换：
 * - idle → processing
 * - processing → idle | waiting_human | error
 * - waiting_human → processing | idle
 * - error → idle
 */
export function createSessionStateMachine(
  onTransition?: (from: SessionStatus, to: SessionStatus) => void,
): StateMachine<SessionStatus> {
  return new StateMachine({
    initial: 'idle',
    transitions: [
      { from: 'idle', to: 'processing', description: '开始处理消息' },
      { from: 'processing', to: 'idle', description: '处理完成' },
      { from: 'processing', to: 'waiting_human', description: '需要人工介入' },
      { from: 'processing', to: 'error', description: '处理出错' },
      { from: 'waiting_human', to: 'processing', description: '人工回复后继续' },
      { from: 'waiting_human', to: 'idle', description: '人工取消' },
      { from: 'error', to: 'idle', description: '恢复/重试' },
    ],
    onTransition,
  });
}
