/**
 * HTTP 桥 — 主线程 ↔ Engine Worker 的请求/响应 DTO
 *
 * 主线程不得跑 Knowledge 业务/SQLite；只转发，保证 /health 在引擎忙时仍可答。
 */

import { PLATFORM_TENANT_ID } from '@octopi-agent/core/types.js';

export interface KnowledgeTokenInfo {
  token: string;
  tenantId: string;
  gatewayId: string;
}

/**
 * 租户断言（受信 gateway 上行，arch/multi-tenancy.md T3）：
 * `x-octopi-tenant` = 调用方断言的 run 归属租户（与 X-Registry-Token 同族的归属通道）。
 * token 域 = PLATFORM（跨域受信）→ 断言任意域放行；token 域 = 其他 → 只可断言本域。
 * 无断言 = token 域（旧语义）。
 *
 * @param tokenTenantId - token 绑定域
 * @param claimed - 请求断言的租户（可缺省）
 * @returns 生效域；断言越域时 `{ error }`（调用方按 401/403 拒）
 */
export function resolveTenantClaim(
  tokenTenantId: string,
  claimed: string | undefined,
): { tenantId: string } | { error: 'tenant_mismatch' } {
  if (!claimed) return { tenantId: tokenTenantId };
  if (tokenTenantId === PLATFORM_TENANT_ID || tokenTenantId === claimed) {
    return { tenantId: claimed };
  }
  return { error: 'tenant_mismatch' };
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
