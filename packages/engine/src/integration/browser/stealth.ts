/**
 * integration/browser/stealth.ts — stealth fallback 链（P3）
 *
 * `engine: "stealth"`：按 `stealth.fallback`（缺省 `rebrowser->camoufox`）持有多个
 * 单引擎服务；挑战判定命中经 {@link StealthFallbackService.rotateAfterChallenge}
 * **按会话 key** 有界轮换到下一后端重试一次，链穷尽返回 false（工具层走 HITL）。
 *
 * 轮换是 per-key 的：一个 key 撞挑战只影响它自己的后端选择，其他 key 仍从链头开始。
 *
 * @module
 */
import type {
  BrowserLaunchOptions,
  BrowserService,
  BrowserSession,
  BrowserSessionId,
  BrowserSessionInfo,
  StealthRotatable,
} from '../../harness/extension/plugin-ecosystem/tools/browser-types.js';

/** 链成员白名单（P3 双 stealth 后端；其余引擎不得进链） */
const CHAIN_ENGINES = new Set(['rebrowser', 'camoufox']);

/**
 * 解析 `stealth.fallback` 链字符串。
 *
 * @param fallback - `->` 分隔的引擎序列（缺省 `rebrowser->camoufox`）
 * @returns 引擎名序列（保序去重）
 * @throws 含白名单外成员或空链时 `Error`（装配期 fail-loud，不静默截断）
 */
export function parseFallbackChain(fallback?: string): string[] {
  const raw = (fallback ?? 'rebrowser->camoufox')
    .split('->')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const name of raw) {
    if (!CHAIN_ENGINES.has(name)) {
      throw new Error(
        `invalid_config: browser.stealth.fallback member "${name}" (allowed: rebrowser, camoufox)`,
      );
    }
    if (seen.has(name)) continue; // 保序去重（重复成员无意义）
    seen.add(name);
    chain.push(name);
  }
  if (chain.length === 0) {
    throw new Error('invalid_config: browser.stealth.fallback resolved to an empty chain');
  }
  return chain;
}

/**
 * stealth 链服务：同 key 会话走当前后端；挑战命中换下一后端（一次为限）。
 */
export class StealthFallbackService implements BrowserService, StealthRotatable {
  /** per-key 当前后端下标（缺省 0 = 链头） */
  private readonly indexByKey = new Map<string, number>();
  private disposed = false;

  /**
   * @param chain - 按 fallback 序排列的单引擎服务（长度 ≥ 1）
   */
  constructor(private readonly chain: BrowserService[]) {
    if (chain.length === 0) throw new Error('invalid_config: stealth fallback chain is empty');
  }

  private svc(key: string): BrowserService {
    const idx = Math.min(this.indexByKey.get(key) ?? 0, this.chain.length - 1);
    return this.chain[idx]!;
  }

  async acquire(sessionKey: string, options?: BrowserLaunchOptions): Promise<BrowserSession> {
    this.assertUsable();
    return this.svc(sessionKey).acquire(sessionKey, options);
  }

  async get(sessionKey: string): Promise<BrowserSession | undefined> {
    // 轮换后新会话在新后端；旧后端可能仍持有其他 key 的会话——全链扫（精确归属由 key 保证）
    for (const svc of this.chain) {
      const hit = await svc.get(sessionKey);
      if (hit) return hit;
    }
    return undefined;
  }

  async byId(id: BrowserSessionId): Promise<BrowserSession | undefined> {
    for (const svc of this.chain) {
      const hit = await svc.byId(id);
      if (hit) return hit;
    }
    return undefined;
  }

  async close(sessionKeyOrId: string): Promise<boolean> {
    let closed = false;
    for (const svc of this.chain) {
      closed = (await svc.close(sessionKeyOrId)) || closed;
    }
    return closed;
  }

  async list(): Promise<BrowserSessionInfo[]> {
    const out: BrowserSessionInfo[] = [];
    for (const svc of this.chain) out.push(...(await svc.list()));
    return out;
  }

  async rotateAfterChallenge(sessionKey: string): Promise<boolean> {
    this.assertUsable();
    const idx = this.indexByKey.get(sessionKey) ?? 0;
    if (idx >= this.chain.length - 1) return false; // 链穷尽：HITL 出口
    await this.chain[idx]!.close(sessionKey);
    this.indexByKey.set(sessionKey, idx + 1);
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(this.chain.map((svc) => svc.dispose()));
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('browser service disposed');
  }
}
