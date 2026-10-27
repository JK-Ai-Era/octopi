/**
 * 模型超时口径一致性检查
 *
 * 背景（2026-10-27 事故）：三个超时各自为政，配置写了 900s 却完全不生效——
 * - engine watchdog `modelCall.idleTimeoutMs`（默认 300s）只认内容 chunk
 * - provider `timeoutSeconds`（按任意字节重置，SSE ping 也算）
 * - undici fetch 默认 headersTimeout / bodyTimeout 各 300s，绕过上述两者直接掐断
 *
 * 结果：chat 兜底请求实测 301s 失败，而配置里写的是 900s；用户与排查者都被误导。
 * 本模块把这些隐含关系显式化成启动期告警——只告警、不改变行为，也不擅自改配置。
 *
 * @module integration/providers/timeout-coherence
 */

import { DEFAULT_MODEL_CALL_IDLE_TIMEOUT_MS } from '@octopi-agent/core/loop/agent-loop.js';

/**
 * undici（Node 内置 fetch）默认超时
 *
 * `headersTimeout` 与 `bodyTimeout` 默认均为 300s，且不受 provider 层
 * `timeoutSeconds` 影响。高于此值的 provider 超时在 Node 内置 fetch 下无效。
 */
export const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;

/** 一条配置一致性问题 */
export interface TimeoutCoherenceIssue {
  /** 稳定机器码，供测试与文档引用 */
  code: 'provider_timeout_capped' | 'provider_timeout_exceeds_engine' | 'idle_above_undici_default' | 'fallback_chain_exceeds_idle';
  message: string;
}

/** 检查输入 */
export interface TimeoutCoherenceInput {
  /** `modelCall.idleTimeoutMs`（未配置时用引擎默认） */
  idleTimeoutMs?: number;
  /** provider 名 → 其 `timeoutSeconds` */
  providerTimeouts: Record<string, number | undefined>;
  /** `modelCall.fallbackAttemptTtftMs` */
  fallbackAttemptTtftMs?: number;
  /** 各 agent 的最长回退链节点数（含主模型）；未提供则跳过该检查 */
  maxFallbackChainLength?: number;
}

/**
 * 检查模型超时配置是否自洽
 *
 * @param input - 待检查的配置快照
 * @returns 问题清单（空数组 = 自洽）
 */
export function checkTimeoutCoherence(input: TimeoutCoherenceInput): TimeoutCoherenceIssue[] {
  const issues: TimeoutCoherenceIssue[] = [];
  const idle = input.idleTimeoutMs ?? DEFAULT_MODEL_CALL_IDLE_TIMEOUT_MS;

  for (const [name, timeoutSeconds] of Object.entries(input.providerTimeouts)) {
    if (timeoutSeconds === undefined) continue;
    const providerTimeoutMs = timeoutSeconds * 1000;

    if (providerTimeoutMs > UNDICI_DEFAULT_TIMEOUT_MS) {
      issues.push({
        code: 'provider_timeout_capped',
        message:
          `provider "${name}" timeoutSeconds=${timeoutSeconds} (${providerTimeoutMs}ms) 超过 Node 内置 fetch 的 300000ms 默认上限，` +
          `实际会被截断为 300000ms；若期望更长的连接寿命请调低该值并显式配置 modelCall.idleTimeoutMs。`,
      });
    }

    if (providerTimeoutMs > idle) {
      issues.push({
        code: 'provider_timeout_exceeds_engine',
        message:
          `provider "${name}" timeoutSeconds=${timeoutSeconds} (${providerTimeoutMs}ms) 大于 modelCall.idleTimeoutMs (${idle}ms)，` +
          `引擎 watchdog 会先断开：该 provider 超时配置不会生效。`,
      });
    }
  }

  if (idle > UNDICI_DEFAULT_TIMEOUT_MS) {
    issues.push({
      code: 'idle_above_undici_default',
      message:
        `modelCall.idleTimeoutMs (${idle}ms) 不小于 Node 内置 fetch 的 300000ms 默认 bodyTimeout：` +
        `两者同级，实测会是 undici 先断开且错误信息更含糊（如 "terminated"），建议设为 240000ms 以下。`,
    });
  }

  const chainLength = input.maxFallbackChainLength ?? 0;
  if (chainLength > 1) {
    const attempt = input.fallbackAttemptTtftMs;
    if (attempt !== undefined && attempt * chainLength >= idle) {
      issues.push({
        code: 'fallback_chain_exceeds_idle',
        message:
          `回退链最坏耗时 ${attempt}ms × ${chainLength} = ${attempt * chainLength}ms 已达/超过 modelCall.idleTimeoutMs (${idle}ms)：` +
          `整条链无法在外层 watchdog 内跑完，最后一个候选可能拿不到机会。`,
      });
    }
  }

  return issues;
}

/**
 * 打印检查结果（启动期调用）
 *
 * @param issues - `checkTimeoutCoherence` 的返回值
 * @param logger - 输出函数（默认 console.warn）
 */
export function logTimeoutCoherence(
  issues: TimeoutCoherenceIssue[],
  logger: (msg: string) => void = (msg) => console.warn(msg),
): void {
  for (const issue of issues) {
    logger(`[modelCall.timeout] ${issue.code}: ${issue.message}`);
  }
}
