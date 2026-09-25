/**
 * SourceFetcher — 本地 / URL 外源取回缝
 *
 * 只负责 discover + 取回 VirtualDocument（已规范化可 chunk 文本）；
 * 切块/索引仍走 FormatAdapter + KnowledgeIndexStore。
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ResolvedCredential } from '../credentials/types.js';
import { htmlToStructuredText, looksLikeHtml } from './html.js';
import { guardedFetch, type NetworkGuardOptions } from './network-guard.js';
import type { KnowledgeSource } from './types.js';

export interface DiscoveredDocRef {
  /** 稳定逻辑键 */
  path: string;
  externalUrl?: string;
  etag?: string;
  lastModified?: string;
}

export interface VirtualDocument {
  path: string;
  externalUrl?: string;
  /** 已规范化 UTF-8 文本 */
  content: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  size: number;
}

export interface SourceFetcher {
  discover(source: KnowledgeSource, cred?: ResolvedCredential | null): Promise<DiscoveredDocRef[]>;
  fetch(
    source: KnowledgeSource,
    ref: DiscoveredDocRef,
    cred?: ResolvedCredential | null,
  ): Promise<VirtualDocument | null>;
}

function mergeHeaders(
  cred?: ResolvedCredential | null,
  extra?: Record<string, string>,
): Record<string, string> {
  return { ...(cred?.headers ?? {}), ...(extra ?? {}) };
}

/** 本地目录/文件 — 收拢原 walk 语义 */
export class LocalFsFetcher implements SourceFetcher {
  /**
   * @param shouldSkipPath - 噪音/二进制路径过滤
   */
  constructor(private readonly shouldSkipPath: (path: string) => boolean) {}

  async discover(source: KnowledgeSource): Promise<DiscoveredDocRef[]> {
    const root = source.location;
    const out: DiscoveredDocRef[] = [];
    const walkDir = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (this.shouldSkipPath(abs)) continue;
          await walkDir(abs);
        } else if (ent.isFile()) {
          if (ent.name === 'knowledge.db' || ent.name.endsWith('.db')) continue;
          out.push({ path: abs });
        }
      }
    };

    const st = await stat(root).catch(() => null);
    if (!st) return out;
    if (st.isFile()) {
      return [{ path: root }];
    }
    await walkDir(root);
    return out;
  }

  async fetch(source: KnowledgeSource, ref: DiscoveredDocRef): Promise<VirtualDocument | null> {
    if (this.shouldSkipPath(ref.path)) return null;
    try {
      const st = await stat(ref.path);
      if (!st.isFile()) return null;
      const content = await readFile(ref.path, 'utf8');
      return {
        path: ref.path,
        content,
        size: st.size,
      };
    } catch {
      return null;
    }
  }
}

/** URL 单页 / sitemap / 同域有限 crawl */
export class UrlFetcher implements SourceFetcher {
  /** crawl discover 期间缓存已拉页面，避免 discover+fetch 双下载 */
  private readonly docCache = new Map<string, VirtualDocument>();

  constructor(private readonly network?: NetworkGuardOptions & { maxDocumentBytes?: number }) {}

  /**
   * 由 URL 推导稳定逻辑键（非完整 URL）
   *
   * - 相对 base 去公共前缀
   * - 跨 origin 时加 host 前缀，防 pathname 碰撞
   * - 有意义的 query 进短 hash 后缀，防 `?a`/`?b` 折叠
   */
  static pathFromUrl(url: string, base?: string): string {
    try {
      const u = new URL(url);
      let p = u.pathname.replace(/\/+$/, '');
      if (!p || p === '/') p = '/index';
      const name = basename(p);
      let rel: string;
      if (base) {
        try {
          const b = new URL(base);
          const bp = b.pathname.replace(/\/+$/, '');
          if (u.origin === b.origin && bp && p.startsWith(bp + '/')) {
            rel = p.slice(bp.length + 1) || name || 'index';
          } else if (u.origin === b.origin) {
            rel = p.replace(/^\//, '') || name || 'index';
          } else {
            const host = u.host.replace(/[:[\]]/g, '_');
            rel = `${host}${p}` || `${host}/index`;
          }
        } catch {
          rel = p.replace(/^\//, '') || name || 'index';
        }
      } else {
        rel = p.replace(/^\//, '') || name || 'index';
      }
      const q = u.search && u.search !== '?'
        ? `~${createHash('sha1').update(u.search).digest('hex').slice(0, 8)}`
        : '';
      return rel + q;
    } catch {
      return 'index';
    }
  }

  /** 从 sitemap/sitemapindex XML 抽取 <loc> */
  static parseSitemapLocs(xml: string): string[] {
    const out: string[] = [];
    const re = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const loc = decodeEntities(m[1]).trim();
      if (/^https?:\/\//i.test(loc)) out.push(loc);
    }
    return out;
  }

  /** 从 HTML 抽取同源 a[href] */
  static extractLinks(html: string, baseUrl: string): string[] {
    const base = new URL(baseUrl);
    const out: string[] = [];
    const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      try {
        const abs = new URL(m[1], base);
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
        if (abs.origin !== base.origin) continue;
        abs.hash = '';
        out.push(abs.toString());
      } catch {
        // 非法 href 跳过
      }
    }
    return out;
  }

  private networkOpts(source: KnowledgeSource): NetworkGuardOptions & { maxDocumentBytes?: number } {
    return {
      ...this.network,
      allowPrivateNetwork:
        this.network?.allowPrivateNetwork ?? source.network?.allowPrivateNetwork === true,
      maxResponseBytes: source.network?.maxResponseBytes ?? this.network?.maxResponseBytes,
      timeoutMs: source.network?.timeoutMs ?? this.network?.timeoutMs,
      maxRedirects: source.network?.maxRedirects ?? this.network?.maxRedirects,
    };
  }

  async discover(source: KnowledgeSource, cred?: ResolvedCredential | null): Promise<DiscoveredDocRef[]> {
    const location = source.location.trim();
    if (!/^https?:\/\//i.test(location)) {
      throw new Error(`url source location must be http(s): ${location}`);
    }
    const mode = source.discover?.mode ?? 'single';
    const maxPages = source.discover?.maxPages ?? 50;
    const maxDepth = source.discover?.maxDepth ?? 3;
    const maxBytes = source.discover?.maxBytes ?? 20_000_000;
    const sitemapMaxDepth = source.discover?.sitemapMaxDepth ?? 2;
    this.docCache.clear();

    if (mode === 'single') {
      return [
        {
          path: UrlFetcher.pathFromUrl(location, location),
          externalUrl: location,
        },
      ];
    }
    if (mode === 'sitemap') {
      return this.discoverSitemap(location, source, cred, maxPages, maxBytes, sitemapMaxDepth);
    }
    return this.discoverCrawl(location, source, cred, maxPages, maxDepth, maxBytes);
  }

  private async discoverSitemap(
    sitemapUrl: string,
    source: KnowledgeSource,
    cred: ResolvedCredential | null | undefined,
    maxPages: number,
    maxBytes: number,
    sitemapMaxDepth = 2,
  ): Promise<DiscoveredDocRef[]> {
    const opts = this.networkOpts(source);
    const seenSm = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: sitemapUrl, depth: 0 }];
    const docs: DiscoveredDocRef[] = [];
    const seenDoc = new Set<string>();
    let downloaded = 0;

    while (queue.length && docs.length < maxPages) {
      const item = queue.shift()!;
      if (seenSm.has(item.url) || item.depth > sitemapMaxDepth) continue;
      seenSm.add(item.url);

      const res = await guardedFetch(
        item.url,
        { ...opts, maxResponseBytes: Math.min(opts.maxResponseBytes ?? 5_000_000, maxBytes - downloaded) },
        { headers: mergeHeaders(cred) },
      );
      downloaded += res.body.length;
      if (downloaded > maxBytes) break;

      const locs = UrlFetcher.parseSitemapLocs(res.body);
      const isIndex = /<sitemapindex/i.test(res.body);
      const smOrigin = new URL(sitemapUrl).origin;
      for (const loc of locs) {
        // 同源约束：防投毒 sitemap 把抓取/凭证引到外域
        if (new URL(loc).origin !== smOrigin) continue;
        if (isIndex || /\.xml(\?|$)/i.test(loc)) {
          queue.push({ url: loc, depth: item.depth + 1 });
        } else if (!seenDoc.has(loc) && docs.length < maxPages) {
          seenDoc.add(loc);
          docs.push({
            path: UrlFetcher.pathFromUrl(loc, sitemapUrl),
            externalUrl: loc,
          });
        }
      }
    }
    return docs;
  }

  private async discoverCrawl(
    startUrl: string,
    source: KnowledgeSource,
    cred: ResolvedCredential | null | undefined,
    maxPages: number,
    maxDepth: number,
    maxBytes: number,
  ): Promise<DiscoveredDocRef[]> {
    const opts = this.networkOpts(source);
    const origin = new URL(startUrl).origin;
    const seen = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
    const docs: DiscoveredDocRef[] = [];
    let downloaded = 0;

    while (queue.length && docs.length < maxPages) {
      const item = queue.shift()!;
      if (seen.has(item.url) || item.depth > maxDepth) continue;
      seen.add(item.url);

      let res;
      try {
        res = await guardedFetch(
          item.url,
          {
            ...opts,
            maxResponseBytes: Math.min(opts.maxResponseBytes ?? 5_000_000, Math.max(0, maxBytes - downloaded)),
          },
          { headers: mergeHeaders(cred) },
        );
      } catch {
        continue;
      }
      downloaded += res.body.length;
      if (downloaded > maxBytes) break;

      const contentType = res.contentType ?? '';
      const isHtml = looksLikeHtml(res.body, contentType);
      let content = res.body;
      if (isHtml) {
        content = htmlToStructuredText(res.body);
      }

      const path = UrlFetcher.pathFromUrl(res.url, startUrl);
      const doc: VirtualDocument = {
        path,
        externalUrl: res.url,
        content: isHtml || /text\/|application\/json|application\/xml/i.test(contentType) ? content : '',
        contentType,
        etag: res.etag,
        lastModified: res.lastModified,
        size: Buffer.byteLength(content, 'utf8'),
      };
      this.docCache.set(res.url, doc);
      this.docCache.set(item.url, doc);
      docs.push({ path, externalUrl: res.url });

      if (isHtml && item.depth < maxDepth) {
        for (const link of UrlFetcher.extractLinks(res.body, res.url)) {
          if (!seen.has(link) && new URL(link).origin === origin) {
            queue.push({ url: link, depth: item.depth + 1 });
          }
        }
      }
    }
    return docs.slice(0, maxPages);
  }

  async fetch(
    source: KnowledgeSource,
    ref: DiscoveredDocRef,
    cred?: ResolvedCredential | null,
  ): Promise<VirtualDocument | null> {
    const url = ref.externalUrl ?? source.location;
    const cached = this.docCache.get(url);
    if (cached) {
      this.docCache.delete(url);
      // 条件 GET：缓存是本轮 discover 刚拉的，直接用（etag 已带上）
      return { ...cached, path: ref.path };
    }

    const maxDoc = this.network?.maxDocumentBytes ?? this.network?.maxResponseBytes ?? 5_000_000;

    const res = await guardedFetch(
      url,
      {
        ...this.networkOpts(source),
        maxResponseBytes: maxDoc,
        etag: ref.etag,
        lastModified: ref.lastModified,
      },
      { headers: mergeHeaders(cred) },
    );

    if (res.notModified) return null;

    const contentType = res.contentType;
    let content = res.body;
    if (looksLikeHtml(res.body, contentType)) {
      content = htmlToStructuredText(res.body);
    } else if (contentType && !/text\/|application\/json|application\/xml/i.test(contentType)) {
      // 非文本：跳过（PDF/Office 走 FormatAdapter 扩展，不在 fetcher 解析）
      return {
        path: ref.path,
        externalUrl: res.url,
        content: '',
        contentType,
        size: res.body.length,
      };
    }

    if (Buffer.byteLength(content, 'utf8') > maxDoc) {
      throw new Error(`document too large after normalize: ${ref.path}`);
    }

    return {
      path: ref.path,
      externalUrl: res.url,
      content,
      contentType,
      etag: res.etag,
      lastModified: res.lastModified,
      size: Buffer.byteLength(content, 'utf8'),
    };
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'");
}
