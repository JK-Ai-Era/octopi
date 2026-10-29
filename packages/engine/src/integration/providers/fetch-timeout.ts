/**
 * 模型调用 HTTP transport 超时对齐
 *
 * 背景（2026-10-27 事故）：Node 内置 fetch（undici）的 `headersTimeout` /
 * `bodyTimeout` 默认各 300s，不受 provider `timeoutSeconds` 影响。非流式 chat
 * 一次超过 300s 的正常长生成（实测 380–447s）必被 transport 掐死成
 * `TypeError: fetch failed`，sync fallback 对长生成模型恢复率为 0。
 *
 * 方案：provider 为 fetch 显式传入 dispatcher，把 transport 两级超时对齐到
 * provider 自身的 `timeoutMs`（= `timeoutSeconds`）。引擎层（modelCall
 * idle/absolute watchdog、sync fallback 预算）仍是上位预算；transport 只保证
 * 不再在配置值之下提前掐断连接。
 *
 * @module integration/providers/fetch-timeout
 */

import { Agent, fetch as undiciFetch } from 'undici';

/**
 * 模型调用专用 fetch
 *
 * 必须用 undici 自带 fetch：Node 内置 fetch 的 dispatcher 接口与 npm undici 的
 * Agent 版本不兼容（直接报 `invalid onRequestStart method` / `UND_ERR_INVALID_ARG`），
 * 自定义 dispatcher 只能搭配 undici 自己的 fetch 使用。错误形态与内置 fetch 一致
 * （`TypeError: fetch failed` + cause），错误分类行为不变。
 */
export const providerFetch = undiciFetch;

/**
 * 创建与 provider 超时对齐的 fetch dispatcher
 *
 * 显式关闭 HTTP/2（`allowH2: false`）。undici 8.x 的 `allowH2` 默认为 true，
 * 只要端点 ALPN 协商到 h2 就走 `client-h2.js`；2026-10-30 网关僵死事故即由该
 * 路径触发：进程 footprint 涨到 30.5G，主线程冻结在原生
 * `Http2Session::SendPendingData → CopyDataIntoOutgoing` 的
 * `std::vector<NgHttp2StreamWrite>` 扩容循环里，事件循环再未恢复。
 *
 * 该路径的代价在任何配置下都不划算：模型调用是「单请求 + 单条流式响应」，
 * 用不到 h2 的多路复用，却要承担首部压缩/流控窗口状态机带来的额外失败面；
 * HTTP/1.1 路径有成熟且线性的 socket 背压。
 *
 * @param timeoutMs - provider 级超时毫秒数（headers / body 同值）
 * @returns undici Agent，作为 fetch 的 `dispatcher` 传入
 */
export function createTimeoutDispatcher(timeoutMs: number): Agent {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    // 见上方事故说明：h2 发送路径曾无对应输入地放大到 30.5G，禁用优先于调参
    allowH2: false,
    // connect 保持 undici 默认（10s）：死主机/不可达端点要快速失败进入重试，
    // 而不是把连接建立也拖到 provider 超时量级
  });
}
