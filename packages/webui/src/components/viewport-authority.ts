/**
 * 会话滚动容器的「视口写权威」协议（纯逻辑）。
 *
 * 同一时刻只允许一个持有者程序性写 scrollTop（分页 prepend 回顶 restore /
 * turn 跳转定位）：后取者胜，旧持有者的补偿写仅当「现持有者尚未执行视口写」
 * 才允许落地，否则丢弃——防止旧 restore 掐断新持有者的平滑滚动，也防止
 * 拒绝滚动的持有者让补偿永久丢失。
 */
export interface ViewportAuthority {
  /** 取得视口写权威；返回持有标记（后取者胜，此前标记全部失效） */
  take(): symbol;
  /** 标记持有者已执行视口写（scrollTo 等）：此后旧持有者的补偿写一律丢弃 */
  markScrolled(owner: symbol): void;
  /** 交还权威；标记已过期则不越权解锁。返回是否实际交还 */
  release(owner: symbol): boolean;
  /** 当前是否有持有者（粘底钉底 / 临近顶部自动加载据此自抑） */
  isHeld(): boolean;
  /**
   * 持有者 owner 的补偿写（prepend 回顶）是否应丢弃：
   * 仅当现持有者是他人且已执行过视口写（自己补偿自己、或接手者还没滚动则照常执行）。
   */
  shouldDropCompensation(owner: symbol): boolean;
  /** 复位（会话切换）：作废一切在途持有与标记，旧持有者的后续动作全部落空 */
  reset(): void;
}

/**
 * @returns 新的视口写权威状态机（组件级单实例，ref 持有）
 */
export function createViewportAuthority(): ViewportAuthority {
  let current: symbol | null = null;
  let scrolled = false;
  return {
    take() {
      current = Symbol('viewport');
      scrolled = false;
      return current;
    },
    markScrolled(owner) {
      if (current === owner) scrolled = true;
    },
    release(owner) {
      if (current !== owner) return false;
      current = null;
      scrolled = false;
      return true;
    },
    isHeld() {
      return current !== null;
    },
    shouldDropCompensation(owner) {
      return current !== null && current !== owner && scrolled;
    },
    reset() {
      current = null;
      scrolled = false;
    },
  };
}
