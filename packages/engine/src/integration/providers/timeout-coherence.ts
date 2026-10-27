/**
 * 模型超时口径一致性检查
 *
 * 背景（2026-10-27 事故）：三个超时各自为政，配置写了 900s 却完全不生效——
 * engine watchdog `modelCall.idleTimeoutMs`（默认 300s）只认内容 chunk、
 * provider `timeoutSeconds`（按任意字节重置）、undici fetch 默认
 * headersTimeout / bodyTimeout 各 300s 三者互相踩踏。
 *
 * 其中 transport 层已修复（`fetch-timeout.ts`：provider 为 fetch 显式传入
 * dispatcher，headers/body 超时对齐自身 `timeoutMs`）。本模块负责剩余的
 * **配置口径**自检——只告警、不改变行为，也不擅自改配置。
 *
 * 口径原则：只对「写了也永远不会生效」的配置告警。provider 总超时与引擎的
 * `absoluteTimeoutMs`（单次调用总上限）是同一量纲；`idleTimeoutMs` 是按内容
 * chunk 重置的空闲窗口，与 provider 计时不可直接比较（谁更小谁先生效都属
 * 正常设计），因此不在此制造互相矛盾的双向建议。默认配置绝不告警。
 *
 * @module integration/providers/timeout-coherence
 */

import {
  DEFAULT_MODEL_CALL_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_MODEL_CALL_IDLE_TIMEOUT_MS,
} from '@octopi-agent/core/loop/agent-loop.js';

/** 一条配置一致性问题 */
export interface TimeoutCoherenceIssue {
  /** 稳定机器码，供测试与文档引用 */
  code: 'provider_timeout_exceeds_absolute' | 'fallback_chain_exceeds_idle';
  message: string;
}

/** 检查输入 */
export interface TimeoutCoherenceInput {
  /** `modelCall.idleTimeoutMs`（未配置时用引擎默认） */
  idleTimeoutMs?: number;
  /** `modelCall.absoluteTimeoutMs`（未配置时用引擎默认） */
  absoluteTimeoutMs?: number;
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
  const absolute = input.absoluteTimeoutMs ?? DEFAULT_MODEL_CALL_ABSOLUTE_TIMEOUT_MS;

  for (const [name, timeoutSeconds] of Object.entries(input.providerTimeouts)) {
    if (timeoutSeconds === undefined) continue;
    const providerTimeoutMs = timeoutSeconds * 1000;

    // 同量纲比较：provider 总超时 vs 引擎单次调用总上限。
    // 超过 absolute 意味着该 provider 超时在模型调用上永远不会生效——写了也是死配置。
    if (providerTimeoutMs > absolute) {
      issues.push({
        code: 'provider_timeout_exceeds_absolute',
        message:
          `provider "${name}" timeoutSeconds=${timeoutSeconds} (${providerTimeoutMs}ms) 大于 modelCall.absoluteTimeoutMs (${absolute}ms)，` +
          `引擎会先达到单次调用总上限：该 provider 超时在模型调用上永远不会生效。`,
      });
    }
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
