/**
 * Provider 诊断载体 — 把「观测事实」挂在错误对象上而不改变错误语义
 *
 * 为什么不用普通属性（`err.status` / `err.code`）：
 * `classifyError`（core/loop/error-classifier.ts）会用字符串键 `status` / `statusCode`
 * / `code` / `httpStatus` 提取状态码，进而改变错误分类与重试决策。诊断信息只服务观测，
 * 不能顺带改变行为，因此全部走 Symbol 键 —— 错误对象的字符串键形状与分类结果保持原样。
 *
 * 背景：一次 52 分钟的停滞只能靠「耗时 300s」反推原因，因为 result 记录只有
 * `outcome: 'error'` 一个词。本模块补齐状态码、错误文本与流内保活计数。
 *
 * @module integration/providers/provider-diagnostics
 */

/** HTTP 状态码（响应非 2xx 时由 provider 附加） */
export const HTTP_STATUS = Symbol.for('@octopi-agent/engine.provider.httpStatus');

/** 流内诊断（流异常收尾时由 provider 附加） */
export const STREAM_DIAG = Symbol.for('@octopi-agent/engine.provider.streamDiag');

/**
 * 流式调用中的观测事实
 *
 * 用于区分两种沉默：
 * - `keepalives > 0`：上游连接活着，只是不产出内容（排队 / 长 prefill）
 * - `keepalives === 0`：上游既无内容也无心跳，更像连接已死
 */
export interface ProviderStreamDiag {
  /** SSE ping / keepalive 心跳数（不计入内容 chunk；SSE 注释行同口径计入） */
  keepalives: number;
  /** 已产出的内容 chunk 数（content / reasoning / tool_call） */
  contentChunks: number;
  /** 已读取的原始字节数 */
  bytes: number;
  /** 首个 wire 字节到达时刻（epoch ms）：区分「首包前静默」与「中段断流」 */
  firstBytesAt?: number;
  /** 最后一个 wire 字节到达时刻（epoch ms）：回答「被掐前 wire 到底动没动」 */
  lastBytesAt?: number;
  /** 是否读到协议终止（done / [DONE] / EOF） */
  sawEnd: boolean;
}

/** 创建一个空诊断累加器（原地累加，异常路径读同一对象） */
export function createStreamDiag(): ProviderStreamDiag {
  return { keepalives: 0, contentChunks: 0, bytes: 0, sawEnd: false };
}

/**
 * 记录一次 wire 读取（字节数 + 首末字节时刻）
 *
 * 时间戳是失败取证的关键：聚合计数回答不了「静默的 300s 里 wire 动没动」——
 * 10-27 事故就卡在这个问题上（streamBytes 与生成速率物理上不相容）。
 *
 * @param diag - 诊断累加器
 * @param byteLength - 本次读取的字节数
 */
export function recordWireBytes(diag: ProviderStreamDiag, byteLength: number): void {
  const now = Date.now();
  if (diag.firstBytesAt === undefined) diag.firstBytesAt = now;
  diag.lastBytesAt = now;
  diag.bytes += byteLength;
}

/** 非对象无法挂载 Symbol（`throw 'string'` 一类），静默跳过 */
function canAttach(target: unknown): target is Record<symbol, unknown> {
  return typeof target === 'object' && target !== null;
}

/**
 * 在错误对象上附加 HTTP 状态码
 *
 * @param err - provider 抛出的错误
 * @param status - 上游响应状态码
 */
export function attachHttpStatus(err: unknown, status: number): void {
  if (!canAttach(err)) return;
  err[HTTP_STATUS] = status;
}

/**
 * 在错误对象上附加流诊断快照
 *
 * 传引用即可：读取方（wire-dump）在 catch 中同步取值，不保留到下一次调用。
 *
 * @param err - provider 抛出的错误
 * @param diag - 当前调用的诊断累加器
 */
export function attachStreamDiag(err: unknown, diag: ProviderStreamDiag): void {
  if (!canAttach(err)) return;
  err[STREAM_DIAG] = diag;
}

/**
 * 读取附加的 HTTP 状态码
 *
 * @param err - 任意错误值
 * @returns 状态码；未附加时为 undefined
 */
export function readHttpStatus(err: unknown): number | undefined {
  if (!canAttach(err)) return undefined;
  const status = err[HTTP_STATUS];
  return typeof status === 'number' ? status : undefined;
}

/**
 * 读取附加的流诊断
 *
 * @param err - 任意错误值
 * @returns 诊断快照；未附加时为 undefined
 */
export function readStreamDiag(err: unknown): ProviderStreamDiag | undefined {
  if (!canAttach(err)) return undefined;
  const diag = err[STREAM_DIAG];
  return diag != null && typeof diag === 'object' ? (diag as ProviderStreamDiag) : undefined;
}
