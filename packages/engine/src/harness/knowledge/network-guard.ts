/**
 * 出站网络门禁 — Knowledge 外源 ingest / http_request SSRF 防护
 *
 * 默认拒绝私网/环回/link-local/云 metadata；`allowPrivateNetwork` 显式放行。
 * 重定向上每跳复验地址；**connect 时再校验**（自定义 lookup），关闭
 * `assertUrlAllowed` lookup 与实际 connect 之间的 DNS TOCTOU（SEC-3a）。
 *
 * 真·IP 钉扎 / hostname allowlist：嵌入方经 `lookup` / `filterAddresses`
 * 注入（SEC-3 结论：引擎不做完整钉扎，见 arch/security-open-issues.md）。
 */

import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export interface NetworkGuardOptions {
  /** 放行私网/环回（源级/部署显式开启） */
  allowPrivateNetwork?: boolean;
  /** 重定向上限（默认 5） */
  maxRedirects?: number;
  /** 单请求超时 ms（默认 30s） */
  timeoutMs?: number;
  /** 响应字节上限（默认 5MB） */
  maxResponseBytes?: number;
  /** 允许的协议（默认 http/https） */
  protocols?: string[];
  /**
   * Connect 时 DNS lookup 覆盖（嵌入方 IP 钉扎缝）。
   * 未提供时使用 `createValidatingLookup`（受限 IP 拒绝 + 可选 filter）。
   */
  lookup?: ConnectLookup;
  /**
   * Connect 解析后的地址过滤（钉扎：只保留已审查 IP）。
   * 在默认 validating lookup 内生效；提供 `lookup` 时忽略。
   */
  filterAddresses?: AddressFilter;
}

export interface FetchResult {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  /** 条件请求未修改 */
  notModified: boolean;
  /** 响应体因 maxResponseBytes 截断 */
  bodyTruncated?: boolean;
}

export type ConnectLookup = (
  hostname: string,
  options: { family?: number | 'IPv4' | 'IPv6'; hints?: number; all?: boolean },
  callback: (
    err: NodeJS.ErrnoException | null,
    address?: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
) => void;

export type AddressFilter = (
  hostname: string,
  addresses: Array<{ address: string; family: number }>,
) => Array<{ address: string; family: number }>;

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5_000_000;

/** 跨 origin 时唯一允许携带的请求头（白名单；其余含凭证一律剥离） */
const SAFE_CROSS_ORIGIN_HEADERS = new Set([
  'accept',
  'accept-language',
  'user-agent',
  'if-none-match',
  'if-modified-since',
]);

/**
 * 凭证只属于「源入口 origin」。远端内容指向的任何其他 origin 一律不带鉴权头。
 *
 * @param trustedOrigin - 源入口 URL 的 origin（listUrl / source.location）
 * @param targetUrl - 本次实际请求的 URL
 * @param headers - 候选请求头（含凭证）
 * @returns 同 origin 时原样返回；跨 origin 时只保留安全白名单
 */
export function authHeadersForUrl(
  trustedOrigin: string,
  targetUrl: string,
  headers?: Record<string, string>,
): Record<string, string> {
  if (!headers) return {};
  let sameOrigin = false;
  try {
    sameOrigin = new URL(targetUrl).origin === trustedOrigin;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return { ...headers };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SAFE_CROSS_ORIGIN_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** 云 metadata / 链路本地（含 IPv4-mapped 与 fe80::/10） */
function isLinkLocalOrMetadata(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (!v) return true;
  if (v === 'metadata.google.internal') return true;
  const mapped = extractIPv4Mapped(v);
  const cand = mapped ?? v;
  if (cand === '169.254.169.254' || cand.startsWith('169.254.')) return true;
  // IPv6 link-local = fe80::/10（fe80–febf），不只是 fe80: 前缀
  if (isIPv6LinkLocal(v)) return true;
  return false;
}

function isIPv6LinkLocal(v: string): boolean {
  // 规范形 / 冒分十六进制首段
  const m = /^([0-9a-f]{1,4}):/.exec(v);
  if (!m) {
    // ::fe80:… 压缩形极少用于 link-local 前缀；fe80:: 标准形覆盖绝大多数
    return /^fe[89ab][0-9a-f]:/i.test(v) || v.startsWith('fe80:');
  }
  const first = Number.parseInt(m[1]!, 16);
  return (first & 0xffc0) === 0xfe80;
}

function isLoopback(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::1' || v === '0:0:0:0:0:0:0:1' || v.startsWith('127.')) return true;
  const mapped = extractIPv4Mapped(v);
  return mapped != null && (mapped.startsWith('127.') || mapped === '127.0.0.1');
}

/** 未指定地址（:: / 0.0.0.0）：连出去通常等价本机 */
function isUnspecified(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  return v === '0.0.0.0' || v === '::' || v === '0:0:0:0:0:0:0:0';
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  // 0.0.0.0/8 「this network」；0.0.0.0 连出常落本机
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * IPv4-mapped IPv6 → 点分 IPv4（含 `::ffff:7f00:1` 十六进制形态）。
 * 解不出则 null。
 */
function extractIPv4Mapped(ip: string): string | null {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // 点分与十六进制两种 mapped 形态
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (dotted) return dotted[1]!;
  // 0:0:0:0:0:ffff:a.b.c.d / 完整 0:0:0:0:0:ffff:xxxx:yyyy
  const m =
    /^(?:(?:0{1,4}:){5}|:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v) ||
    /^(?:(?:0{1,4}:){5}|:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v);
  if (!m) {
    if (!v.includes('ffff')) return null;
    // ::ffff:x:x 或 0:0:0:0:0:ffff:x:x
    const idx = v.lastIndexOf('ffff:');
    const rest = v.slice(idx + 5);
    if (rest.includes('.')) return rest;
    const parts = rest.split(':');
    if (parts.length !== 2) return null;
    const hi = Number.parseInt(parts[0]!, 16);
    const lo = Number.parseInt(parts[1]!, 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  if (m.length === 2 && m[1]!.includes('.')) return m[1]!;
  const hi = Number.parseInt(m[1]!, 16);
  const lo = Number.parseInt(m[2]!, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
  const mapped = extractIPv4Mapped(v);
  // mapped 按等价 IPv4 分类（含环回/未指定/私网）；link-local/metadata 走 isAlwaysBlockedIp
  if (mapped) {
    return isPrivateIPv4(mapped) || isLoopback(mapped) || isUnspecified(mapped);
  }
  return false;
}

/**
 * 永不放行：云 metadata / 链路本地 / 未指定（即使 allowPrivateNetwork）
 */
export function isAlwaysBlockedIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!v) return true;
  return isUnspecified(v) || isLinkLocalOrMetadata(v);
}

/**
 * 判断 IP 是否属于受限地址（私网/环回/metadata/未指定）
 *
 * @param ip - IPv4/IPv6 字面量
 */
export function isRestrictedIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!v) return true;
  if (isAlwaysBlockedIp(v)) return true;
  if (isLoopback(v)) return true;
  if (isIP(v) === 4) return isPrivateIPv4(v);
  if (isIP(v) === 6) return isPrivateIPv6(v) || isLinkLocalOrMetadata(v);
  return true;
}

/**
 * 校验一组连接地址（lookup/filter 输出复检；IP 字面量也走此路径）
 *
 * @param hostname - 主机（日志用）
 * @param addrs - 地址列表
 * @param allowPrivate - 是否放行私网/环回（metadata 始终拒）
 * @throws 存在禁用地址时抛错
 */
function assertAddressesAllowed(
  hostname: string,
  addrs: Array<{ address: string }>,
  allowPrivate: boolean,
): void {
  for (const a of addrs) {
    if (isAlwaysBlockedIp(a.address)) {
      throw new Error(
        `address not allowed (metadata/link-local): ${hostname} -> ${a.address}`,
      );
    }
    if (!allowPrivate && isRestrictedIp(a.address)) {
      throw new Error(
        `address not allowed (private/loopback/metadata): ${hostname} -> ${a.address}`,
      );
    }
  }
}

export function createValidatingLookup(opts?: {
  allowPrivateNetwork?: boolean;
  filterAddresses?: AddressFilter;
}): ConnectLookup {
  const allowPrivate = opts?.allowPrivateNetwork === true;
  return (hostname, options, callback) => {
    void (async () => {
      try {
        const family =
          typeof options.family === 'number' ? options.family : undefined;
        const addresses = await dns.lookup(hostname, {
          family,
          hints: options.hints,
          all: true,
        });
        let addrs: Array<{ address: string; family: number }> = addresses.map((a) => ({
          address: a.address,
          family: a.family,
        }));
        if (!addrs.length) {
          return callback(
            Object.assign(new Error(`dns lookup empty: ${hostname}`), { code: 'ENOTFOUND' }),
          );
        }
        try {
          assertAddressesAllowed(hostname, addrs, allowPrivate);
        } catch (e) {
          return callback(Object.assign(e as Error, { code: 'EACCES' }));
        }
        if (opts?.filterAddresses) {
          addrs = opts.filterAddresses(hostname, addrs);
          if (!addrs.length) {
            return callback(
              Object.assign(new Error(`no allowed addresses after filter: ${hostname}`), {
                code: 'EACCES',
              }),
            );
          }
          // filter 输出必须再过门禁（防有缺陷的 filter 重新引入受限地址）
          try {
            assertAddressesAllowed(hostname, addrs, allowPrivate);
          } catch (e) {
            return callback(Object.assign(e as Error, { code: 'EACCES' }));
          }
        }
        if (options.all) return callback(null, addrs);
        return callback(null, addrs[0]!.address, addrs[0]!.family);
      } catch (err) {
        callback(err as NodeJS.ErrnoException);
      }
    })();
  };
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
    assertAddressesAllowed(hostname, [{ address: hostname }], allowPrivate);
    // IP 字面量不走 DNS lookup；嵌入方钉扎缝仍须生效
    if (opts?.filterAddresses) {
      const kept = opts.filterAddresses(hostname, [
        { address: hostname, family: isIP(hostname) as 4 | 6 },
      ]);
      if (!kept.length) {
        throw new Error(`no allowed addresses after filter: ${hostname}`);
      }
      assertAddressesAllowed(hostname, kept, allowPrivate);
    }
    return url;
  }

  // 域名：解析后校验全部 A/AAAA（fail-fast；connect 时 lookup 会再校验）
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`dns lookup failed: ${hostname}`);
  }
  if (!addrs.length) {
    throw new Error(`dns lookup empty: ${hostname}`);
  }
  assertAddressesAllowed(hostname, addrs, allowPrivate);
  return url;
}

interface RequestOnceResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
}

/**
 * 单跳 HTTP 请求（不跟随重定向）。lookup 在 connect 解析时校验地址。
 */
function requestOnce(
  url: URL,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
    maxBytes: number;
    allowPrivateNetwork?: boolean;
    lookup?: ConnectLookup;
    filterAddresses?: AddressFilter;
  },
): Promise<RequestOnceResult> {
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  // 自定义 lookup 是解析缝，不是免检缝：返回地址仍须过受限门
  const allowPrivate = opts.allowPrivateNetwork === true;
  const baseLookup =
    opts.lookup ??
    createValidatingLookup({
      allowPrivateNetwork: opts.allowPrivateNetwork,
      filterAddresses: opts.filterAddresses,
    });
  const lookup: ConnectLookup = (hostname, options, callback) => {
    baseLookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      try {
        const addrs = Array.isArray(address)
          ? address
          : address != null
            ? [{ address, family: family ?? 4 }]
            : [];
        if (addrs.length) assertAddressesAllowed(hostname, addrs, allowPrivate);
      } catch (e) {
        return callback(Object.assign(e as Error, { code: 'EACCES' }));
      }
      return callback(null, address, family);
    });
  };
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  return new Promise<RequestOnceResult>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    // 绝对时限：req.setTimeout 是空闲超时，慢滴灌会不断重置
    const deadline = Date.now() + opts.timeoutMs;

    const req = mod.request(
      {
        protocol: url.protocol,
        hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: opts.headers,
        lookup: lookup as http.RequestOptions['lookup'],
        ...(isHttps && isIP(hostname) === 0 ? { servername: hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        const finish = () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue;
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          void decodeBody(Buffer.concat(chunks), headers['content-encoding'])
            .then((body) => {
              done(() =>
                resolve({
                  status: res.statusCode ?? 0,
                  statusText: res.statusMessage ?? '',
                  headers,
                  body,
                  bodyTruncated: truncated,
                }),
              );
            })
            .catch((err) => {
              done(() => reject(err));
            });
        };
        res.on('data', (chunk: Buffer) => {
          if (settled || truncated) return;
          if (Date.now() > deadline) {
            truncated = true;
            done(() =>
              reject(new Error(`request timeout after ${opts.timeoutMs}ms`)),
            );
            req.destroy();
            return;
          }
          total += chunk.byteLength;
          if (total > opts.maxBytes) {
            truncated = true;
            chunks.push(
              chunk.subarray(0, Math.max(0, opts.maxBytes - (total - chunk.byteLength))),
            );
            // 先落定截断结果，再断连接（destroy 后 end 不会到）
            finish();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', finish);
        res.on('error', (err) => {
          // 已因截断落定则忽略 destroy 带来的 error
          if (truncated) return;
          done(() => reject(err));
        });
      },
    );
    req.setTimeout(Math.max(1, deadline - Date.now()), () => {
      done(() => reject(new Error(`request timeout after ${opts.timeoutMs}ms`)));
      req.destroy();
    });
    req.on('error', (err) => {
      done(() => reject(err));
    });
    if (opts.body != null && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(opts.method)) {
      req.write(opts.body);
    }
    req.end();
  });
}

/** 按 Content-Encoding 解压；identity/未知编码原样返回 */
async function decodeBody(buf: Buffer, contentEncoding?: string): Promise<string> {
  const enc = (contentEncoding ?? '').toLowerCase().trim();
  if (!enc || enc === 'identity') return buf.toString('utf8');
  if (enc === 'gzip' || enc === 'x-gzip') {
    return (await streamToBuffer(createGunzip(), buf)).toString('utf8');
  }
  if (enc === 'deflate') {
    return (await streamToBuffer(createInflate(), buf)).toString('utf8');
  }
  if (enc === 'br') {
    return (await streamToBuffer(createBrotliDecompress(), buf)).toString('utf8');
  }
  return buf.toString('utf8');
}

async function streamToBuffer(
  stream: NodeJS.ReadWriteStream,
  input: Buffer,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const { Readable, Writable } = await import('node:stream');
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  await pipeline(Readable.from(input), stream, sink);
  return Buffer.concat(chunks);
}

/**
 * 受门禁保护的 HTTP 请求（手动跟随重定向并每跳 SSRF 复验 + connect 时 lookup 校验）
 *
 * @param rawUrl - 目标 URL
 * @param options - 门禁与请求选项（method/body/headers）
 * @param init - 额外 fetch 头（凭证等）；与 options.headers 合并
 * @returns 规范化响应
 */
export async function guardedRequest(
  rawUrl: string,
  options?: NetworkGuardOptions & {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    etag?: string;
    lastModified?: string;
  },
  init?: { headers?: Record<string, string> },
): Promise<FetchResult> {
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options?.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const method = (options?.method ?? 'GET').toUpperCase();

  let current = rawUrl;
  let redirects = 0;
  /** 307/308：保留 method+body */
  let preserveMethod = false;
  /** 凭证仅允许与首个请求同 origin 的后续跳；跨域重定向只保留安全白名单 */
  const trustedOrigin = new URL(rawUrl).origin;

  for (;;) {
    await assertUrlAllowed(current, options);
    const userHeaders = authHeadersForUrl(trustedOrigin, current, {
      ...(init?.headers ?? {}),
      ...(options?.headers ?? {}),
    });
    const headers: Record<string, string> = {
      'user-agent': options?.headers?.['user-agent'] ?? 'octopi-network-guard/1.0',
      accept:
        options?.headers?.accept ??
        'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1',
      // 走解压路径；服务端可仍回 identity
      'accept-encoding': options?.headers?.['accept-encoding'] ?? 'gzip, deflate, br',
      ...userHeaders,
    };
    if (options?.etag) headers['if-none-match'] = options.etag;
    if (options?.lastModified) headers['if-modified-since'] = options.lastModified;
    const hopMethod =
      redirects > 0 && method !== 'GET' && method !== 'HEAD' && !preserveMethod
        ? 'GET'
        : method;
    const hopBody =
      redirects > 0 && !preserveMethod ? undefined : options?.body;
    const bodyWillSend =
      hopBody != null && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(hopMethod);
    // 仅在本跳真正发送 body 时带 Content-Length（重定向丢 body 时不得残留）
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    if (bodyWillSend) {
      headers['content-length'] = String(Buffer.byteLength(hopBody!));
    }

    const result = await requestOnce(new URL(current), {
      method: hopMethod,
      headers,
      body: hopBody,
      timeoutMs,
      maxBytes,
      allowPrivateNetwork: options?.allowPrivateNetwork,
      lookup: options?.lookup,
      filterAddresses: options?.filterAddresses,
    });

    // 304 Not Modified：条件 GET 成功短路（勿进 redirect 分支）
    if (result.status === 304) {
      return {
        url: current,
        status: 304,
        statusText: result.statusText,
        headers: result.headers,
        body: '',
        notModified: true,
      };
    }

    // 手动跟随，便于每跳 SSRF 复验
    if (result.status >= 300 && result.status < 400) {
      const loc = result.headers['location'];
      if (!loc) {
        throw new Error(`redirect without location: ${result.status}`);
      }
      redirects += 1;
      if (redirects > maxRedirects) {
        throw new Error(`too many redirects (max ${maxRedirects})`);
      }
      // 307/308 保留 method+body（RFC 7231/7538）；301/302/303 降级 GET
      preserveMethod = result.status === 307 || result.status === 308;
      current = new URL(loc, current).toString();
      continue;
    }

    const contentType = result.headers['content-type'];
    if (result.status >= 400) {
      throw new Error(`HTTP ${result.status} for ${current}`);
    }

    return {
      url: current,
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: result.body,
      contentType,
      etag: result.headers['etag'],
      lastModified: result.headers['last-modified'],
      notModified: false,
      bodyTruncated: result.bodyTruncated,
    };
  }
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
  return guardedRequest(rawUrl, { ...options, method: 'GET' }, init);
}
