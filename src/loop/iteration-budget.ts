/**
 * IterationBudget — 迭代预算管理器
 *
 * 线程安全的 consume/refund 计数器。
 * 基于 hermes-agent 的设计，增加 grace call 支持。
 *
 * 用途：
 * - 父 Agent 的预算来自 config.iterationBudget（默认 90）
 * - 每次迭代消耗一次，工具调用的程序化轮次可 refund
 * - 预算耗尽后给一次 grace call 机会
 */

export class IterationBudget {
  private _used = 0;
  private _graceUsed = false;

  constructor(private readonly _max: number) {}

  /** 尝试消费一次迭代。返回 true 表示允许。 */
  consume(): boolean {
    if (this._used >= this._max) return false;
    this._used++;
    return true;
  }

  /** 退还一次迭代（如 execute_code 等程序化调用）。 */
  refund(): void {
    if (this._used > 0) this._used--;
  }

  /** Grace call：预算耗尽后给一次额外机会。仅一次。 */
  consumeGrace(): boolean {
    if (this._used === this._max && !this._graceUsed) {
      this._graceUsed = true;
      this._used++;
      return true;
    }
    return false;
  }

  get used(): number { return this._used; }
  get remaining(): number { return Math.max(0, this._max - this._used); }
  get max(): number { return this._max; }
  get isExhausted(): boolean { return this._used >= this._max; }

  /** 重置预算（新 session 时）。 */
  reset(): void {
    this._used = 0;
    this._graceUsed = false;
  }
}
