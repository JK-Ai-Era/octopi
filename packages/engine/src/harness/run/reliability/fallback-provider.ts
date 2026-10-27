/**
 * FallbackProvider — 模型回退提供器
 *
 * 包装多个 ModelProvider，按顺序尝试。主 provider 失败时自动切换到下一个回退 provider。
 *
 * 使用场景：
 * - 主模型不可用（circuit breaker open、限流、超时）
 * - 主模型返回错误
 * - 跨 provider 灾备（如 OpenAI -> Anthropic）
 *
 * ## 单节点首块预算（2026-10-27 修复）
 *
 * 引擎 watchdog（core/loop/call-model.ts）把**整条链**当作一次调用计时，只认内容 chunk。
 * 于是主 provider 若「连上了但长期不产首块」（上游排队 / 长 prefill，期间只发 SSE ping），
 * 会独占整个 watchdog 窗口，备选模型一次机会都拿不到——实测一次 52 分钟停滞即由此而来。
 *
 * 因此链内每个节点各有自己的「等首个内容 chunk」预算（`attemptTtftTimeoutMs`）：
 * - 仅在**还有下一个候选**时生效（最后一棒没有备选可切，交给外层 watchdog 兜底）
 * - 超时即 abort 该次尝试（子 AbortController，不波及父 signal），切下一节点
 * - 一旦首个 chunk 产出，本次调用完全委托该节点，预算不再起作用
 *   （流中途的静默由外层 idle watchdog 负责，见 stream() 注释）
 *
 * ## 失败节点降级
 *
 * 超时/失败过的节点进入降级窗口（`degradeTtlMs`，缺省等于首块预算），
 * 后续调用把它排到最后。这使「重试」不再是原地重撞同一节点——
 * 这也是条件化重试的落地方式：重试时条件（节点顺序）确实变了。
 */

import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { ModelInfo } from '@octopi-agent/core/types/agent-definition.js';
import { classifyError } from '@octopi-agent/core/loop/error-classifier.js';
import type { ModelConfig } from '../../shared/types/agent-definition.js';

/**
 * 单节点等待首个内容 chunk 的默认预算（毫秒）
 *
 * 依据：同一时段实测备选 provider 处理同体积请求 1–16s；
 * 主 provider 出现 271s / 383s 级首块延迟。90s 足以放过正常抖动，
 * 又不至于让一次用户提问白白等满 watchdog 窗口。
 */
export const DEFAULT_FALLBACK_ATTEMPT_TTFT_MS = 90_000;

/**
 * 单节点非流式（chat）尝试的默认预算（毫秒）
 *
 * chat 没有「首块」概念，预算覆盖的是**整段响应**；复用 90s 的 TTFT 值会把
 * 合法的长响应（推理型模型、长输出）误判为节点故障并降级。
 * 取 240s：低于 undici `bodyTimeout` 的 300s，从而能在被 undici 以
 * 含糊的 `terminated` 掐断之前把控制权交回引擎、切换下一节点。
 */
export const DEFAULT_FALLBACK_CHAT_ATTEMPT_MS = 240_000;

/** FallbackProvider 配置项 */
interface FallbackEntry {
  provider: ModelProvider;
  model: string;
  defaultModel?: string;
}

/** 构造选项 */
export interface FallbackProviderOptions {
  /** 单节点等待首个内容 chunk 的上限（仅 stream）；<=0 或未提供时用 DEFAULT_FALLBACK_ATTEMPT_TTFT_MS */
  attemptTtftTimeoutMs?: number;
  /** 单节点非流式整响应的上限（仅 chat）；<=0 或未提供时用 DEFAULT_FALLBACK_CHAT_ATTEMPT_MS */
  attemptChatTimeoutMs?: number;
  /** 失败节点降级窗口；缺省等于 attemptTtftTimeoutMs */
  degradeTtlMs?: number;
  /** 时钟注入（测试用） */
  now?: () => number;
}

/** 单次尝试的首块预算被耗尽的标记（用于区分「自家 abort」与父级 abort） */
const ATTEMPT_BUDGET_EXHAUSTED = Symbol('fallback.attemptBudgetExhausted');

/**
 * 回退感知的 ModelProvider
 *
 * 尝试主 provider，失败后按 fallbackModels 顺序尝试备选。
 * 每个节点有独立首块预算，失败节点在降级窗口内被排到最后。
 */
export class FallbackProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel?: string;

  private chain: FallbackEntry[];
  private readonly attemptTtftTimeoutMs: number;
  private readonly attemptChatTimeoutMs: number;
  private readonly degradeTtlMs: number;
  private readonly now: () => number;
  /** 节点下标 → 降级截止时间戳 */
  private readonly degradedUntil = new Map<number, number>();

  constructor(
    mainProvider: ModelProvider,
    mainModel: string,
    fallbackModels: ModelConfig[],
    providerMap: Map<string, ModelProvider>,
    options: FallbackProviderOptions = {},
  ) {
    this.name = mainProvider.name;
    this.attemptTtftTimeoutMs =
      options.attemptTtftTimeoutMs && options.attemptTtftTimeoutMs > 0
        ? options.attemptTtftTimeoutMs
        : DEFAULT_FALLBACK_ATTEMPT_TTFT_MS;
    this.attemptChatTimeoutMs =
      options.attemptChatTimeoutMs && options.attemptChatTimeoutMs > 0
        ? options.attemptChatTimeoutMs
        : DEFAULT_FALLBACK_CHAT_ATTEMPT_MS;
    this.degradeTtlMs = options.degradeTtlMs && options.degradeTtlMs > 0
      ? options.degradeTtlMs
      : this.attemptTtftTimeoutMs;
    this.now = options.now ?? Date.now;

    this.chain = [{ provider: mainProvider, model: mainModel, defaultModel: mainProvider.defaultModel }];

    for (const fb of fallbackModels) {
      const fbProvider = providerMap.get(fb.provider);
      if (!fbProvider) {
        console.warn(`[FallbackProvider] Fallback provider "${fb.provider}" not found, skipping`);
        continue;
      }
      this.chain.push({ provider: fbProvider, model: fb.model });
    }

    this.defaultModel = mainModel;
  }

  /**
   * 本次调用的尝试顺序：未降级节点保持原相对顺序在前，降级节点在后。
   *
   * @returns 带原下标与「是否仍有下一候选」的尝试序列
   */
  private attemptOrder(): Array<{ entry: FallbackEntry; index: number }> {
    const nowTs = this.now();
    const active: Array<{ entry: FallbackEntry; index: number }> = [];
    const degraded: Array<{ entry: FallbackEntry; index: number }> = [];

    for (let i = 0; i < this.chain.length; i++) {
      const item = { entry: this.chain[i], index: i };
      const until = this.degradedUntil.get(i);
      if (until !== undefined && until > nowTs) degraded.push(item);
      else {
        // 过期条目顺手清理，避免 Map 长期增长
        if (until !== undefined) this.degradedUntil.delete(i);
        active.push(item);
      }
    }

    return [...active, ...degraded];
  }

  /** 标记节点失败（进入降级窗口） */
  private markDegraded(index: number): void {
    this.degradedUntil.set(index, this.now() + this.degradeTtlMs);
  }

  /** 标记节点恢复（成功一次即解除降级） */
  private markHealthy(index: number): void {
    this.degradedUntil.delete(index);
  }

  /**
   * 仅在「节点健康类」错误上降级
   *
   * 401/403（鉴权）、400（上下文超长/请求非法）、billing 等是**请求级**问题，
   * 换节点不会变好；把它们算作节点故障会让主节点被无谓地排后，
   * 并在下一次调用里静默换到别的模型（计费/缓存口径随之错位）。
   *
   * @param index - 节点下标
   * @param err - 该节点的错误
   */
  private degradeIfNodeUnhealthy(index: number, err: unknown): void {
    const { reason } = classifyError(err);
    if (reason === 'timeout' || reason === 'network' || reason === 'server' || reason === 'rate_limit') {
      this.markDegraded(index);
    }
  }

  /**
   * 由备选节点服务时留下一行可检索的提示
   *
   * 换模型对调用方不可见（响应里的 model 由各 provider 自填，用量/计费口径仍在主模型名下），
   * 若不显式记一笔，「为什么这次的回答风格/质量变了」将无从追查。
   *
   * @param entry - 实际服务的节点
   * @param pos - 其在本次尝试顺序中的位置（0 = 主节点）
   */
  private warnIfServedByFallback(entry: FallbackEntry, pos: number): void {
    if (pos === 0) return;
    console.warn(
      `[FallbackProvider] served by fallback node ${pos}: ${entry.provider.name}/${entry.model} ` +
        `(primary ${this.name}/${this.defaultModel} unavailable or degraded)`,
    );
  }

  /**
   * 在预算内等待一个 promise；超时则 reject 预算耗尽标记
   *
   * @param work - 待等待的 promise
   * @param budgetMs - 预算；undefined 表示不限（最后一个候选）
   * @param onTimeout - 预算耗尽时的清理动作（abort 子 signal）
   * @returns work 的结果
   */
  private async withBudget<T>(
    work: Promise<T>,
    budgetMs: number | undefined,
    onTimeout: () => void,
  ): Promise<T> {
    if (budgetMs === undefined) return work;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(ATTEMPT_BUDGET_EXHAUSTED);
      }, budgetMs);
    });

    try {
      return await Promise.race([work, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const order = this.attemptOrder();
    let lastError: unknown;

    for (let pos = 0; pos < order.length; pos++) {
      const { entry, index } = order[pos];
      const hasNext = pos < order.length - 1;
      // 子 controller：预算耗尽时只取消本次尝试，不波及父级 signal
      const attempt = new AbortController();
      const onParentAbort = () => attempt.abort();
      if (request.signal?.aborted) attempt.abort();
      else request.signal?.addEventListener('abort', onParentAbort, { once: true });

      try {
        const response = await this.withBudget(
          entry.provider.chat({ ...request, model: entry.model, signal: attempt.signal }),
          // chat 是非流式：预算覆盖整段响应，与 stream 的「首块」语义不同（见 DEFAULT_FALLBACK_CHAT_ATTEMPT_MS）
          hasNext ? this.attemptChatTimeoutMs : undefined,
          () => attempt.abort(),
        );
        this.markHealthy(index);
        this.warnIfServedByFallback(entry, pos);
        return response;
      } catch (err) {
        if (request.signal?.aborted) throw err;
        if (err === ATTEMPT_BUDGET_EXHAUSTED) {
          this.markDegraded(index);
          // 消息显式带 "timeout"：classifyError 依文本归类时才能落到 timeout
          //（否则落 unknown → 直接中止，丢掉了「换节点后再试一次」的机会）
          lastError = new Error(
            `FallbackProvider: ${entry.provider.name}/${entry.model} response timeout after ${this.attemptChatTimeoutMs}ms (no response received)`,
          );
          attachAttemptBudgetExhausted(lastError, this.attemptChatTimeoutMs);
          console.warn(`[FallbackProvider] ${entry.provider.name}/${entry.model} attempt budget exhausted (${this.attemptChatTimeoutMs}ms), trying next`);
          continue;
        }
        lastError = err;
        this.degradeIfNodeUnhealthy(index, err);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[FallbackProvider] ${entry.provider.name}/${entry.model} failed: ${msg}`);
      } finally {
        request.signal?.removeEventListener('abort', onParentAbort);
      }
    }

    throw lastError ?? new Error('All fallback providers exhausted');
  }

  /**
   * 流式生成回复
   *
   * 每个节点在独立首块预算内等待首个 chunk；超时切下一节点。
   *
   * 注意：一旦某个 provider 成功产出第一个 chunk，后续就完全委托给该 provider。
   * 如果该 provider 在流中途抛异常，错误会直接传递给调用方，不会触发回退。
   * 这是流式生成的固有限制——已产出的内容无法撤回。
   * 流中途的静默由外层 idle watchdog 负责（它会 abort 父 signal）。
   */
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    const order = this.attemptOrder();
    let lastError: unknown;

    for (let pos = 0; pos < order.length; pos++) {
      const { entry, index } = order[pos];
      const hasNext = pos < order.length - 1;

      // 子 controller：预算耗尽时取消本次尝试的 HTTP，不波及父级 signal
      const attempt = new AbortController();
      const onParentAbort = () => attempt.abort();
      if (request.signal?.aborted) attempt.abort();
      else request.signal?.addEventListener('abort', onParentAbort, { once: true });

      let gen: AsyncGenerator<LLMStreamChunk> | undefined;
      let first: IteratorResult<LLMStreamChunk>;

      // try/catch 仅覆盖初始化阶段（创建 stream + 获取首个 chunk）。
      // 一旦首个 chunk 成功产出，后续 yield* 在 try/catch 之外执行，
      // 确保流中途错误直接向上传播，不会被吞掉后静默回退。
      try {
        gen = entry.provider.stream({ ...request, model: entry.model, signal: attempt.signal });
        first = await this.withBudget(
          gen.next(),
          hasNext ? this.attemptTtftTimeoutMs : undefined,
          () => attempt.abort(),
        );
      } catch (err) {
        // 放弃被预算掐断的尝试：abort 底层 HTTP 并回收 generator
        void gen?.return?.(undefined as never)?.catch(() => undefined);
        request.signal?.removeEventListener('abort', onParentAbort);

        // 父级中止：不是本节点的问题，直接上抛（不降级、不切下一个）
        if (request.signal?.aborted) throw err;

        if (err === ATTEMPT_BUDGET_EXHAUSTED) {
          this.markDegraded(index);
          lastError = new Error(
            `FallbackProvider: ${entry.provider.name}/${entry.model} first-chunk timeout after ${this.attemptTtftTimeoutMs}ms (no chunk received)`,
          );
          attachAttemptBudgetExhausted(lastError, this.attemptTtftTimeoutMs);
          console.warn(`[FallbackProvider] ${entry.provider.name}/${entry.model} attempt budget exhausted (${this.attemptTtftTimeoutMs}ms), trying next`);
        } else {
          lastError = err;
          this.degradeIfNodeUnhealthy(index, err);
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[FallbackProvider] ${entry.provider.name}/${entry.model} stream failed: ${msg}`);
        }
        continue;
      }

      if (first.done) {
        // 空流：本轮不算成功，交给下一节点（与旧行为一致）
        request.signal?.removeEventListener('abort', onParentAbort);
        this.markDegraded(index);
        continue;
      }

      this.markHealthy(index);
      this.warnIfServedByFallback(entry, pos);
      // 首个 chunk 成功，完全委托给当前 provider（无 try/catch 包裹）。
      // finally 里必须 abort：消费者 break / 提前 return 时 gen.return() 打断不了
      // 挂在 reader.read() 上的 await，只有 abort 子 signal 才能真正关掉底层 HTTP。
      // 对已完成/正常的流 abort 是无害的（provider 侧 signal 已不再被等待）。
      try {
        yield first.value;
        yield* gen;
      } finally {
        attempt.abort();
        request.signal?.removeEventListener('abort', onParentAbort);
      }
      return;
    }

    throw lastError ?? new Error('All fallback providers exhausted');
  }

  async isAvailable(): Promise<boolean> {
    // 任一 provider 可用即可
    for (const entry of this.chain) {
      try {
        if (await entry.provider.isAvailable()) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  getModelInfo(modelName: string) {
    // 只返回该模型名的声明；未命中返回 null（禁止回退到 chain[0] 窗口）
    for (const entry of this.chain) {
      const info = entry.provider.getModelInfo(modelName);
      if (info) return info;
    }
    return null;
  }

  getModelInfos(): ModelInfo[] {
    // 合并所有 provider 的 model info
    const infos: ReturnType<ModelProvider['getModelInfos']> = [];
    for (const entry of this.chain) {
      infos.push(...entry.provider.getModelInfos());
    }
    return infos;
  }
}

/**
 * 「单节点预算耗尽」标记（观测用，与 STREAM_DIAG 同属 Symbol 通道，不影响错误分类）
 *
 * 定义在 harness（产生方）；`integration/providers/wire-dump` 作为外层读取它落盘。
 */
export const ATTEMPT_BUDGET_EXHAUSTED_DIAG = Symbol.for(
  '@octopi-agent/engine.provider.attemptBudgetExhausted',
);

/**
 * 在错误对象上标记「单节点预算耗尽」
 *
 * @param err - 待标记错误
 * @param budgetMs - 被耗尽的预算
 */
export function attachAttemptBudgetExhausted(err: unknown, budgetMs: number): void {
  if (typeof err !== 'object' || err === null) return;
  (err as Record<symbol, unknown>)[ATTEMPT_BUDGET_EXHAUSTED_DIAG] = budgetMs;
}

/**
 * 读取「单节点预算耗尽」标记
 *
 * @param err - 任意错误
 * @returns 被耗尽的预算毫秒数；未标记时 undefined
 */
export function readAttemptBudgetExhausted(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const v = (err as Record<symbol, unknown>)[ATTEMPT_BUDGET_EXHAUSTED_DIAG];
  return typeof v === 'number' ? v : undefined;
}
