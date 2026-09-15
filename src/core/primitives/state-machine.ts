/**
 * 轻量状态机（纯机制）
 *
 * 定义合法状态转换路径，非法转换自动拦截。
 * Session 等领域策略见 harness/session-state-machine.ts。
 *
 * @module
 */

/**
 * 状态转换定义
 */
export interface StateTransition<S extends string> {
  from: S;
  to: S;
  /** 转换描述（用于错误消息和日志） */
  description?: string;
}

/**
 * 状态机配置
 */
export interface StateMachineConfig<S extends string> {
  /** 初始状态 */
  initial: S;
  /** 合法转换列表 */
  transitions: StateTransition<S>[];
  /** 状态变更回调（用于日志和可观测性） */
  onTransition?: (from: S, to: S) => void;
}

/**
 * 轻量状态机
 *
 * @example
 * ```ts
 * const sm = new StateMachine({
 *   initial: 'idle',
 *   transitions: [
 *     { from: 'idle', to: 'processing' },
 *     { from: 'processing', to: 'idle' },
 *     { from: 'processing', to: 'error' },
 *     { from: 'error', to: 'idle' },
 *   ],
 * });
 *
 * sm.transition('processing'); // OK
 * sm.transition('idle');       // OK
 * sm.transition('processing'); // OK
 * sm.transition('idle');       // OK
 * sm.transition('error');      // throws: illegal transition idle → error
 * ```
 */
export class StateMachine<S extends string> {
  private _state: S;
  private _previousState: S | null = null;
  private readonly transitionMap: Map<S, Set<S>>;
  private readonly config: StateMachineConfig<S>;

  constructor(config: StateMachineConfig<S>) {
    this.config = config;
    this._state = config.initial;
    this.transitionMap = new Map();

    for (const t of config.transitions) {
      if (!this.transitionMap.has(t.from)) {
        this.transitionMap.set(t.from, new Set());
      }
      this.transitionMap.get(t.from)!.add(t.to);
    }
  }

  /** 当前状态 */
  get state(): S {
    return this._state;
  }

  /** 上一个状态（如果没有转换过则为 null） */
  get previousState(): S | null {
    return this._previousState;
  }

  /**
   * 执行状态转换
   *
   * @param to - 目标状态
   * @throws 非法转换时抛出错误
   */
  transition(to: S): void {
    const allowed = this.transitionMap.get(this._state);
    if (!allowed?.has(to)) {
      const allowedList = allowed ? [...allowed].join(', ') : '(none)';
      throw new Error(
        `Illegal state transition: ${this._state} → ${to}. ` +
        `Allowed transitions from "${this._state}": ${allowedList}`
      );
    }

    const from = this._state;
    this._previousState = from;
    this._state = to;
    this.config.onTransition?.(from, to);
  }

  /**
   * 检查是否可以转换到目标状态（不实际执行）
   */
  canTransition(to: S): boolean {
    const allowed = this.transitionMap.get(this._state);
    return allowed?.has(to) ?? false;
  }

  /**
   * 获取当前状态的所有合法目标状态
   */
  allowedTransitions(): S[] {
    const allowed = this.transitionMap.get(this._state);
    return allowed ? [...allowed] : [];
  }

  /**
   * 强制设置状态（用于恢复/初始化，绕过转换检查）
   * 谨慎使用。
   */
  force(state: S): void {
    this._previousState = this._state;
    this._state = state;
  }
}
