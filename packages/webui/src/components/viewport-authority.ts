/**
 * 会话滚动容器的「视口写权威」协议（纯逻辑）。
 *
 * 同一时刻只允许一个持有者程序性写 scrollTop（分页 prepend 回顶 restore /
 * turn 跳转定位）：后取者胜，旧持有者的补偿写仅当「现持有者尚未执行视口写」
 * 才允许落地，否则丢弃——防止旧 restore 掐断新持有者的平滑滚动，也防止
 * 拒绝滚动的持有者让补偿永久丢失。reset（会话切换）作废一切世代：早于本次
 * 世代的补偿一律让路（补偿属于旧会话视口，不得落到新会话）。
 */
export interface ViewportAuthority {
  /** 取得视口写权威；返回持有标记（后取者胜，此前标记全部失效） */
  take(): symbol;
  /** 标记持有者已执行视口写（scrollTo 等）：此后旧持有者的补偿写一律丢弃 */
  markScrolled(owner: symbol): void;
  /** 交还权威；标记已过期则不越权解锁。返回是否实际交还 */
  release(owner: symbol): boolean;
  /** 当前是否有持有者（临近顶部自动加载的入口闸据此自抑；钉底不据此自抑） */
  isHeld(): boolean;
  /**
   * 持有者 owner 的补偿写（prepend 回顶）是否应丢弃：
   * - take 之后发生过 reset（会话切换）：一律丢弃；
   * - 否则仅当现持有者是他人且已执行过视口写（自己补偿自己、
   *   或接手者还没滚动则照常执行）。
   */
  shouldDropCompensation(owner: symbol): boolean;
  /** 程序滚动进行中（持有者已执行视口写）：其 scroll 回响不得参与跟随意图判定 */
  isProgrammaticScroll(): boolean;
  /** 复位（会话切换）：作废一切在途持有与标记，旧持有者的后续动作全部落空 */
  reset(): void;
}

/** 补偿写「仍停留原位」判定的容差：scroll anchoring 残差与亚像素漂移的允许量 */
export const COMPENSATION_STAY_TOLERANCE_PX = 24;

/**
 * prepend 回顶补偿是否应落地：仅当视口仍停在原阅读位（±容差）。
 * 候选一 = 原位未动（无 scroll anchoring 浏览器）；候选二 = 浏览器 anchoring
 * 已把视口补偿到 prevTop+delta（此时写入只消除 ≤容差的下方长高残差，并非
 * 严格无操作）。用户在加载期间移动过视口（回到最底部、点了回到底部）→ 不得
 * 落地——盲写（含 0 条加载的 prevTop+0）会把人拽回旧位置，其 scroll 事件
 * 还会误杀粘底跟随。钉底与本补偿的冲突也由本判定裁决（钉底挪过视口即让路）。
 */
export function shouldApplyCompensation(input: {
  scrollTop: number;
  prevTop: number;
  delta: number;
  tolerancePx?: number;
}): boolean {
  const tolerance = input.tolerancePx ?? COMPENSATION_STAY_TOLERANCE_PX;
  return (
    Math.abs(input.scrollTop - input.prevTop) <= tolerance ||
    Math.abs(input.scrollTop - (input.prevTop + input.delta)) <= tolerance
  );
}

/**
 * @returns 新的视口写权威状态机（组件级单实例，ref 持有）
 */
export function createViewportAuthority(): ViewportAuthority {
  let current: symbol | null = null;
  let scrolled = false;
  /** 世代号：reset 即 +1；早于当前世代 take 的补偿写一律过期让路 */
  let generation = 0;
  const takenGeneration = new Map<symbol, number>();
  return {
    take() {
      current = Symbol('viewport');
      scrolled = false;
      takenGeneration.set(current, generation);
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
      if (takenGeneration.get(owner) !== generation) return true;
      return current !== null && current !== owner && scrolled;
    },
    isProgrammaticScroll() {
      return current !== null && scrolled;
    },
    reset() {
      current = null;
      scrolled = false;
      generation += 1;
      takenGeneration.clear();
    },
  };
}
