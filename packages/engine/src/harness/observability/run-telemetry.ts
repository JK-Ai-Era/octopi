/**
 * RunTelemetry — Harness 观测装配端口
 *
 * 分层：Harness 只定义采集意图与装配契约；具体后端
 * （ObserverBridge / TraceCollector / MetricsAggregator）在 Integration，
 * 由宿主经 `setRunTelemetryFactory` 注入（`octopi` 包入口默认注册）。
 *
 * 两套互补采集：
 * - **push** `createLoopObserver()` → LoopObserver（agentLoop 回调）
 * - **pull** `onEvent()` → Runner 事件流旁路（不改 yield）
 */

import type { LoopObserver } from '@octopi-agent/core/loop/types.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

/** 产品级观测采集意图 */
export interface AgentTraceOptions {
  captureStreamDeltas?: boolean;
  captureModelRequest?: boolean;
  captureToolArgs?: boolean;
  captureToolResults?: boolean;
  enableMetrics?: boolean;
}

/** Runner 事件旁路上下文 */
export interface RunTelemetryEventCtx {
  sessionId: string;
  agentId: string;
}

/**
 * 一次装配的观测句柄
 */
export interface RunTelemetry {
  /** 推送路径：挂到 AgentLoopConfig.observer */
  createLoopObserver(options: AgentTraceOptions): LoopObserver;
  /** 拉取路径：Runner 每条适配后事件调用（含 llm_stream_delta） */
  onEvent?(event: AgentEvent, ctx: RunTelemetryEventCtx): void;
  /** run 结束后 flush（可选） */
  finalize?(): void | Promise<void>;
}

/** 由 Integration 实现；Harness 不感知后端 */
export type RunTelemetryFactory = (options: AgentTraceOptions) => RunTelemetry;

let registeredFactory: RunTelemetryFactory | undefined;

/**
 * 注册 RunTelemetry 工厂（Integration / 包入口调用）
 *
 * @param factory - 创建 RunTelemetry 的工厂
 */
export function setRunTelemetryFactory(factory: RunTelemetryFactory | undefined): void {
  registeredFactory = factory;
}

/**
 * 读取已注册工厂
 *
 * @returns 工厂；未注册时 undefined
 */
export function getRunTelemetryFactory(): RunTelemetryFactory | undefined {
  return registeredFactory;
}
