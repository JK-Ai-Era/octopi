/**
 * 出站网络门禁 — Knowledge 外源 ingest SSRF 防护
 *
 * 默认拒绝私网/环回/link-local/云 metadata；源级 allowPrivateNetwork 显式放行。
 * 重定向每跳复验；DNS 解析后校验目标 IP（防 rebinding）。
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface NetworkGuardOptions {
  /** 放行私网/环回（源级显式开启） */
  allowPrivateNetwork?: boolean;
  /** 重定向上限（默认 5） */
  maxRedirects?: number;
  /** 单请求超时 ms（默认 30s） */
  timeoutMs?: number;
  /** 响应字节上限（默认 5MB） */
  maxResponseBytes?: number;
  /** 允许的协议（默认 http/https） */
  protocols?: string[];
}

export interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  /** 条件请求未修改 */
  notModified: boolean;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5_000_000;

/** 云 metadata / 链路本地 */
function isLinkLocalOrMetadata(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '169.254.169.254' || v === 'metadata.google.internal') return true;
  if (v.startsWith('169.254.')) return true;
  if (v.startsWith('fe80:')) return true;
  return false;
}

function isLoopback(ip: string): boolean {
  const v = ip.toLowerCase();
  return v === '::1' || v === '0:0:0:0:0:0:0:1' || v.startsWith('127.');
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
  if (v.startsWith('::ffff:')) {
    const mapped = v.slice(7);
    return isPrivateIPv4(mapped) || isLoopback(mapped);
  }
  return false;
}

/**
 * 判断 IP 是否属于受限地址（私网/环回/metadata）
 *
 * @param ip - IPv4/IPv6 字面量
 */
export function isRestrictedIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!v) return true;
  if (isLoopback(v) || isLinkLocalOrMetadata(v)) return true;
  if (isIP(v) === 4) return isPrivateIPv4(v);
  if (isIP(v) === 6) return isPrivateIPv6(v) || isLinkLocalOrMetadata(v);
  return true;
}

/**
 * 校验 URL 主机是否允许出站
 *
 * @param rawUrl - 目标 URL
 * @param opts - 门禁选项
 * @throws 协议/地址不允许时抛错
 */
export async function assertUrlAllowed(rawUrl: string, opts?: NetworkGuardOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid url: ${rawUrl}`);
  }
  const protocols = opts?.protocols ?? ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) {
    throw new Error(`protocol not allowed: ${url.protocol}`);
  }

  const allowPrivate = opts?.allowPrivateNetwork === true;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname)) {
    if (!allowPrivate && isRestrictedIp(hostname)) {
      throw new Error(`address not allowed (private/loopback/metadata): ${hostname}`);
    }
    return url;
  }

  // 域名：解析后校验全部 A/AAAA
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`dns lookup failed: ${hostname}`);
  }
  if (!addrs.length) {
    throw new Error(`dns lookup empty: ${hostname}`);
  }
  if (!allowPrivate) {
    for (const a of addrs) {
      if (isRestrictedIp(a.address)) {
        throw new Error(`address not allowed (private/loopback/metadata): ${hostname} -> ${a.address}`);
      }
    }
  }
  return url;
}

/**
 * 受门禁保护的 GET（跟随重定向并每跳复验）
 *
 * @param rawUrl - 目标 URL
 * @param options - 门禁与请求选项
 * @param init - 额外 fetch 头（凭证等）
 * @returns 规范化响应
 */
export async function guardedFetch(
  rawUrl: string,
  options?: NetworkGuardOptions & {
    etag?: string;
    lastModified?: string;
  },
  init?: { headers?: Record<string, string> },
): Promise<FetchResult> {
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options?.maxResponseBytes ?? DEFAULT_MAX_BYTES;

  let current = rawUrl;
  let redirects = 0;
  /** 凭证仅允许与首个请求同 origin 的后续跳；跨域重定向剥离敏感头 */
  const trustedOrigin = new URL(rawUrl).origin;
  const SENSITIVE_HEADERS = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'x-api-key',
    'api-key',
    'x-auth-token',
    'x-access-token',
  ];

  for (;;) {
    await assertUrlAllowed(current, options);
    const sameOrigin = new URL(current).origin === trustedOrigin;
    const userHeaders = { ...(init?.headers ?? {}) };
    if (!sameOrigin) {
      for (const key of Object.keys(userHeaders)) {
        if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
          delete userHeaders[key];
        }
      }
    }
    const headers: Record<string, string> = {
      'user-agent': 'octopi-knowledge-ingest/1.0',
      accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1',
      ...userHeaders,
    };
    if (options?.etag) headers['if-none-match'] = options.etag;
    if (options?.lastModified) headers['if-modified-since'] = options.lastModified;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    clearTimeout(timer);

    // 304 Not Modified：条件 GET 成功短路（勿进 redirect 分支）
    if (response.status === 304) {
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      return {
        url: current,
        status: 304,
        headers: responseHeaders,
        body: '',
        notModified: true,
      };
    }

    // 手动跟随，便于每跳 SSRF 复验
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) {
        throw new Error(`redirect without location: ${response.status}`);
      }
      redirects += 1;
      if (redirects > maxRedirects) {
        throw new Error(`too many redirects (max ${maxRedirects})`);
      }
      current = new URL(loc, current).toString();
      continue;
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    const contentType = responseHeaders['content-type'];
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${current}`);
    }

    const reader = response.body?.getReader();
    let body = '';
    if (reader) {
      const decoder = new TextDecoder();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`response too large (> ${maxBytes} bytes): ${current}`);
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    }

    return {
      url: current,
      status: response.status,
      headers: responseHeaders,
      body,
      contentType,
      etag: responseHeaders['etag'],
      lastModified: responseHeaders['last-modified'],
      notModified: false,
    };
  }
}
