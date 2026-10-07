/**
 * HTTP 桥 — 主线程 ↔ Engine Worker 的请求/响应 DTO
 *
 * 主线程不得跑 Knowledge 业务/SQLite；只转发，保证 /health 在引擎忙时仍可答。
 */

export interface KnowledgeTokenInfo {
  token: string;
  tenantId: string;
  gatewayId: string;
}

/**
 * Token → (tenant, gateway)。主线程 401 快速拒绝 + Engine 再验（同一实现）。
 */
export function matchKnowledgeToken(
  tokens: readonly KnowledgeTokenInfo[],
  authorizationHeader: string | string[] | undefined,
): KnowledgeTokenInfo | null {
  const header = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return tokens.find((t) => t.token === token) ?? null;
}

export interface HttpBridgeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** utf8；GET/HEAD 为空 */
  body?: string;
}

export type HttpBridgeOutbound =
  | {
      type: 'end';
      status: number;
      headers: Record<string, string | number | string[]>;
      body: string;
    }
  | {
      type: 'sse-start';
      status: number;
      headers: Record<string, string | number | string[]>;
    }
  | { type: 'sse-write'; chunk: string }
  | { type: 'sse-end' };

export interface HttpBridgeWorkerInbound {
  id: number;
  type: 'http';
  req: HttpBridgeRequest;
}

export interface HttpBridgeWorkerReady {
  type: 'ready';
  portHint?: number;
}

export interface HttpBridgeWorkerError {
  type: 'error';
  message: string;
}
