/**
 * Protocol Layer — 将 Agent Harness 暴露为 HTTP API
 *
 * 设计原则：薄协议，只做格式转换和路由，不加业务逻辑
 */

import type { AgentHarness, Message, AgentConfig, AgentEventListener } from '../core/types.js';

export interface ProtocolServer {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
}

/**
 * HTTP 协议适配器（占位）
 *
 * 将暴露以下端点：
 * POST   /sessions           — 创建 session
 * POST   /sessions/:id/send  — 发送消息
 * GET    /sessions/:id       — 获取 session 状态
 * DELETE /sessions/:id       — 结束 session
 * GET    /health             — 健康检查
 * GET    /tools              — 列出可用工具
 */
export class HttpProtocol implements ProtocolServer {
  constructor(private harness: AgentHarness) {}

  async start(_port: number): Promise<void> {
    // TODO: 实现 HTTP server（使用原生 node:http 或 hono）
    console.log('[HttpProtocol] Server placeholder — not yet implemented');
  }

  async stop(): Promise<void> {
    // TODO
  }
}

/**
 * 适配器工厂 — 让应用层选择协议
 */
export function createHttpProtocol(harness: AgentHarness): HttpProtocol {
  return new HttpProtocol(harness);
}
