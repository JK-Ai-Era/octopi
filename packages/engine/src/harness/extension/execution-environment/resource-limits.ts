/**
 * L1 资源限制 — 工具执行看门狗（ToolEffectPolicy / OP-17）
 *
 * 统一强制 `definition.timeoutMs`；与 abortSignal 联动。
 * run 级硬停（token/iteration）仍归 Budget/Run，不在此域。
 */

export class ToolTimeoutError extends Error {
  readonly timedOut = true;
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`tool_timeout: "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

export interface ToolRunLimits {
  /** 硬顶；省略则不限时（仅受 abortSignal） */
  timeoutMs?: number;
  /** 外部中止 */
  abortSignal?: AbortSignal;
  toolName?: string;
}

/**
 * 在资源限制下执行工具体
 *
 * @param fn - 工具逻辑；接收内部 AbortSignal（超时/外部中止时触发）
 * @param limits - L1 限制
 * @returns 工具结果
 */
export async function runWithToolLimits<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  limits: ToolRunLimits,
): Promise<T> {
  const toolName = limits.toolName ?? 'tool';
  const timeoutMs = limits.timeoutMs;
  const outer = limits.abortSignal;

  if (outer?.aborted) {
    throw new Error(`tool_aborted: "${toolName}"`);
  }

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener('abort', onOuterAbort, { once: true });

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let timeoutReject: ((e: Error) => void) | undefined;
  let timeoutPromise: Promise<never> | undefined;
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    timeoutPromise = new Promise<never>((_, reject) => {
      timeoutReject = reject;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ToolTimeoutError(toolName, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  try {
    const running = fn(controller.signal);
    // 防 timeout 胜出后 running 的 reject 变成 unhandled
    running.catch(() => undefined);
    // race：handler 可能不尊重 abort，仍须在 timeoutMs 拒绝
    return timeoutPromise
      ? await Promise.race([running, timeoutPromise])
      : await running;
  } catch (err) {
    if (timedOut) {
      throw new ToolTimeoutError(toolName, timeoutMs!);
    }
    if (outer?.aborted) {
      throw new Error(`tool_aborted: "${toolName}"`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    timeoutReject = undefined;
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * 从工具定义解析 timeoutMs
 *
 * @param definition - 工具定义
 * @returns 硬顶毫秒；未声明则 undefined
 */
export function resolveToolTimeoutMs(definition?: {
  timeoutMs?: number;
}): number | undefined {
  const t = definition?.timeoutMs;
  return typeof t === 'number' && t > 0 ? t : undefined;
}
