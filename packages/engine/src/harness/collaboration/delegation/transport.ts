/**
 * DelegateTransport — 委派调用的唯一分布式缝
 *
 * @layer harness/collaboration/delegation
 * 设计权威：`arch/delegation.md` §5 / §11。
 *
 * 上层（`DelegateService` / 工具）只见 `call(request) → result`，不见实现。
 * v1 实现 `InProcessTransport`（直接 async 调用）；
 * 将来换 `NetworkTransport` / `WorkerTransport` 上层一行不改。
 *
 * **协议 = L2 的消息 schema + 信封语义，不是 wire format**（§5）。
 * 因此本文件不得出现 socket / worker_threads / child_process 等传输细节。
 *
 * v1 交付语义 = **at-most-once**（进程内天然可靠）；
 * 持久化 / 顺序 / 重投 / 共识留待分布式议题（`arch/delegation.md` O5）。
 */

import type { DelegateRequest, DelegateResult } from './types.js';
import { DELEGATION_SCHEMA_VERSION } from './types.js';

/**
 * 本地委派执行器（由 `DelegateService` 提供）
 *
 * 职责：真正起子 Run、收结果、产出 `DelegateResult`。
 * 与 transport 分离，使 `InProcessTransport` 只做"直调"这一件事。
 *
 * @param request - 委派请求（D1：纯 JSON）
 * @param signal - 本地中止信号（D4：只是 `deadlineAt` / `cancelable` 的本地投影）
 * @returns 委派结果（D5：可序列化）
 */
export type LocalDelegateExecutor = (
  request: DelegateRequest,
  signal?: AbortSignal,
) => Promise<DelegateResult>;

/**
 * DelegateTransport 接口
 *
 * 唯一的分布式缝。实现方负责把远端 agent 当作本地 handle 调用。
 */
export interface DelegateTransport {
  /**
   * 调用委派（request-reply 语义）
   *
   * @param request - 委派请求
   * @param signal - 本地中止信号
   * @returns 委派结果
   * @throws 目标不可达 / 请求非法 / schema 版本不兼容
   */
  call(request: DelegateRequest, signal?: AbortSignal): Promise<DelegateResult>;

  // 将来可扩：send（fire-and-forget）、stream（流式）
}

/**
 * InProcessTransport — 进程内直调实现
 *
 * 不序列化（同进程无必要），但**入参出参仍必须是纯 JSON**（D1/D5），
 * 以保证换成 `NetworkTransport` 时上层行为一致。
 */
export class InProcessTransport implements DelegateTransport {
  /**
   * @param executor - 本地委派执行器（起子 Run 的实际入口）
   */
  constructor(private readonly executor: LocalDelegateExecutor) {}

  /**
   * 直调本地执行器
   *
   * @param request - 委派请求
   * @param signal - 本地中止信号
   * @returns 委派结果
   * @throws schema 版本不兼容，或执行器抛错
   */
  async call(request: DelegateRequest, signal?: AbortSignal): Promise<DelegateResult> {
    assertCompatibleSchema(request);
    return this.executor(request, signal);
  }
}

/**
 * 断言消息 schema 版本兼容（§11：消息必须版本化）
 *
 * @param request - 委派请求
 * @throws 版本缺失或主版本不兼容
 */
export function assertCompatibleSchema(request: DelegateRequest): void {
  if (typeof request.schemaVersion !== 'number') {
    throw new Error('delegate_request: missing schemaVersion');
  }
  // 主版本不兼容才拒绝；同主版本的次级演进视为兼容
  const major = Math.trunc(request.schemaVersion);
  const currentMajor = Math.trunc(DELEGATION_SCHEMA_VERSION);
  if (major !== currentMajor) {
    throw new Error(
      `delegate_request: incompatible schemaVersion ${request.schemaVersion} (current ${DELEGATION_SCHEMA_VERSION})`,
    );
  }
}
