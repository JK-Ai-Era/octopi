/**
 * KnowledgeConnector — 文档型外源连接器插件面（U4）
 *
 * 边界：只同步「文档快照」；活系统 live query 归 Tool，不入 Knowledge。
 * 密钥经 CredentialStore（authRef）注入，配置不进 knowledge.db 明文。
 */

import { createHash } from 'node:crypto';
import type { ResolvedCredential } from '../credentials/types.js';
import { htmlToStructuredText, looksLikeHtml } from './html.js';
import type { DiscoveredDocRef, VirtualDocument } from './fetchers.js';
import { guardedFetch, type NetworkGuardOptions } from './network-guard.js';
import type { KnowledgeSource, KnowledgeSourceNetwork } from './types.js';

export interface ConnectorContext {
  /** 源 location（list 入口或配置引用） */
  location: string;
  /** 已解析凭证（可空） */
  auth?: ResolvedCredential | null;
  network?: KnowledgeSourceNetwork;
  maxPages?: number;
}

export interface KnowledgeConnector {
  id: string;
  discover(ctx: ConnectorContext, source: KnowledgeSource): Promise<DiscoveredDocRef[]>;
  fetch(
    ctx: ConnectorContext,
    source: KnowledgeSource,
    ref: DiscoveredDocRef,
  ): Promise<VirtualDocument | null>;
}

/** generic REST list+get 配置（location 可为 JSON 串，或纯 listUrl） */
export interface RestConnectorConfig {
  type?: 'rest';
  /** 列表接口 URL（location 为纯 URL 时即此） */
  listUrl: string;
  /** JSON 路径到数组，如 `results` / `data.items`；空则根数组或常见信封 */
  itemsPath?: string;
  /** 逻辑 path 字段（缺省 url 的 pathname 或 id） */
  pathField?: string;
  /** 展示/描述用标题字段 */
  titleField?: string;
  /** 正文字段（HTML/文本）；与 urlField 二选一 */
  contentField?: string;
  /** 有此字段则按 URL 再拉正文 */
  urlField?: string;
  maxPages?: number;
}

function dig(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function parseRestConfig(location: string): RestConnectorConfig {
  const trimmed = location.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as RestConnectorConfig;
    if (!parsed.listUrl) throw new Error('rest connector config requires listUrl');
    return parsed;
  }
  return { listUrl: trimmed };
}

function pickItems(body: unknown, itemsPath?: string): unknown[] {
  if (itemsPath) {
    const v = dig(body, itemsPath);
    return Array.isArray(v) ? v : [];
  }
  if (Array.isArray(body)) return body;
  for (const key of ['items', 'results', 'data', 'entries', 'pages', 'value']) {
    const v = dig(body, key);
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object' && Array.isArray((v as { items?: unknown }).items)) {
      return (v as { items: unknown[] }).items;
    }
  }
  return [];
}

function itemPath(item: Record<string, unknown>, cfg: RestConnectorConfig, index: number): string {
  if (cfg.pathField) {
    const p = dig(item, cfg.pathField);
    if (p != null) return String(p);
  }
  const url = cfg.urlField ? dig(item, cfg.urlField) : undefined;
  if (url != null) {
    try {
      return decodeURIComponent(new URL(String(url)).pathname.replace(/^\//, '')) || `item-${index}`;
    } catch {
      // fall through
    }
  }
  const id = item.id ?? item.slug ?? item.key;
  if (id != null) return String(id);
  // 无稳定业务键：用内容 hash，避免纯下标随列表顺序漂移
  return `item-${createHash('sha1').update(JSON.stringify(item)).digest('hex').slice(0, 12)}`;
}

/** generic REST list + content/get */
export class RestConnector implements KnowledgeConnector {
  readonly id = 'rest';

  async discover(ctx: ConnectorContext, source: KnowledgeSource): Promise<DiscoveredDocRef[]> {
    const cfg = parseRestConfig(ctx.location);
    const maxPages = ctx.maxPages ?? cfg.maxPages ?? 50;
    const res = await guardedFetch(cfg.listUrl, networkFrom(ctx, source), {
      headers: { ...(ctx.auth?.headers ?? {}), accept: 'application/json' },
    });
    const body = JSON.parse(res.body) as unknown;
    const items = pickItems(body, cfg.itemsPath).slice(0, maxPages);
    const out: DiscoveredDocRef[] = [];
    items.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return;
      const item = raw as Record<string, unknown>;
      const path = itemPath(item, cfg, index);
      const externalUrl = cfg.urlField
        ? String(dig(item, cfg.urlField) ?? cfg.listUrl)
        : cfg.listUrl;
      out.push({ path, externalUrl });
    });
    return out;
  }

  async fetch(
    ctx: ConnectorContext,
    source: KnowledgeSource,
    ref: DiscoveredDocRef,
  ): Promise<VirtualDocument | null> {
    const cfg = parseRestConfig(ctx.location);
    const maxPages = ctx.maxPages ?? cfg.maxPages ?? 50;
    // 列表即内容：重新拉列表找该 path（小规模可接受；后续可缓存）
    const res = await guardedFetch(cfg.listUrl, networkFrom(ctx, source), {
      headers: { ...(ctx.auth?.headers ?? {}), accept: 'application/json' },
    });
    const body = JSON.parse(res.body) as unknown;
    const items = pickItems(body, cfg.itemsPath).slice(0, maxPages);
    let hit: Record<string, unknown> | null = null;
    items.forEach((raw, index) => {
      if (hit || !raw || typeof raw !== 'object') return;
      const item = raw as Record<string, unknown>;
      if (itemPath(item, cfg, index) === ref.path) hit = item;
    });
    if (!hit) return null;
    const item = hit as Record<string, unknown>;

    let content = '';
    let externalUrl = ref.externalUrl ?? cfg.listUrl;
    if (cfg.contentField) {
      const raw = dig(item, cfg.contentField);
      content = raw == null ? '' : String(raw);
      if (looksLikeHtml(content)) content = htmlToStructuredText(content);
    } else if (cfg.urlField) {
      const pageUrl = String(dig(item, cfg.urlField) ?? '');
      if (!pageUrl) return null;
      externalUrl = pageUrl;
      const page = await guardedFetch(pageUrl, networkFrom(ctx, source), {
        headers: ctx.auth?.headers,
      });
      content = looksLikeHtml(page.body, page.contentType)
        ? htmlToStructuredText(page.body)
        : page.body;
    } else {
      // 整个 item JSON 文本化
      content = JSON.stringify(item, null, 2);
    }

    return {
      path: ref.path,
      externalUrl,
      content,
      contentType: 'text/plain',
      size: Buffer.byteLength(content, 'utf8'),
    };
  }
}

function networkFrom(
  ctx: ConnectorContext,
  source: KnowledgeSource,
): NetworkGuardOptions & { maxDocumentBytes?: number } {
  return {
    allowPrivateNetwork: source.network?.allowPrivateNetwork === true,
    maxResponseBytes: source.network?.maxResponseBytes,
  };
}

export class ConnectorRegistry {
  private byId = new Map<string, KnowledgeConnector>();

  constructor(connectors: KnowledgeConnector[] = [new RestConnector()]) {
    for (const c of connectors) this.register(c);
  }

  register(connector: KnowledgeConnector): void {
    this.byId.set(connector.id, connector);
  }

  get(id: string): KnowledgeConnector | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * 由 source 推断 connector：location JSON 的 type，或默认 rest
   */
  resolve(source: KnowledgeSource): KnowledgeConnector {
    const loc = source.location.trim();
    if (loc.startsWith('{')) {
      const type = (JSON.parse(loc) as { type?: string }).type ?? 'rest';
      const hit = this.byId.get(type);
      if (!hit) throw new Error(`unknown connector type: ${type}`);
      return hit;
    }
    const rest = this.byId.get('rest');
    if (!rest) throw new Error('rest connector not registered');
    return rest;
  }
}
