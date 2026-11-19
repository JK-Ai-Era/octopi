/**
 * DefaultBrowserService — BrowserService 实现（key/ID 会话索引）
 *
 * 并发纪律（评审 B4/N8）：acquire 做 single-flight（同 key 并发只起一个浏览器）；
 * close 先关再摘表（失败可重试），但全程带 closing 守卫——关闭在途的会话对
 * get/byId/acquire 一律不可见（否则并发方会拿到半死会话 / 关闭后复活）；
 * dispose 收口进程生命周期 + 空闲回收，防 agent 忘记 browser_close 时
 * Chromium 进程泄漏。
 */

import type {
  BrowserLaunchOptions,
  BrowserPort,
  BrowserService,
  BrowserSession,
  BrowserSessionId,
  BrowserSessionInfo,
} from '../../harness/extension/plugin-ecosystem/tools/browser-types.js';

const IDLE_SWEEP_INTERVAL_MS = 60_000;

export class DefaultBrowserService implements BrowserService {
  private readonly byKeyMap = new Map<string, BrowserSession>();
  private readonly byIdMap = new Map<BrowserSessionId, BrowserSession>();
  private readonly byKeyInflight = new Map<string, Promise<BrowserSession>>();
  private readonly lastUsedAt = new Map<BrowserSessionId, number>();
  /** 关闭在途的会话（对 get/byId/acquire 不可见；防复活窗口） */
  private readonly closing = new Set<BrowserSessionId>();
  private disposed = false;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly port: BrowserPort,
    private readonly options: {
      /** 空闲回收（毫秒）；<= 0 = 不回收 */
      sessionIdleTimeoutMs?: number;
    } = {},
  ) {
    const idleTimeoutMs = options.sessionIdleTimeoutMs ?? 1_800_000;
    if (idleTimeoutMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweepIdle(idleTimeoutMs);
      }, IDLE_SWEEP_INTERVAL_MS);
      // 回收定时器不得钉住进程退出
      this.sweepTimer.unref?.();
    }
  }

  async acquire(sessionKey: string, options?: BrowserLaunchOptions): Promise<BrowserSession> {
    this.assertUsable();
    const existing = this.byKeyMap.get(sessionKey);
    if (existing) {
      if (!this.closing.has(existing.id)) {
        this.lastUsedAt.set(existing.id, Date.now());
        return existing;
      }
      // 关闭在途：当缺席处理（摘表后走新 launch，不复用半死会话）
      this.evict(existing);
    }
    const inflight = this.byKeyInflight.get(sessionKey);
    if (inflight) return inflight;

    // single-flight：launch 期间同 key 的并发调用等同一个 promise
    const promise = (async () => {
      try {
        const session = await this.port.launch({ ...options, ownerKey: sessionKey });
        if (this.disposed) {
          // dispose 竞态：已宣告收尾则不能复活会话（评审 B4「复活」路径）
          await session.close();
          throw new Error('browser_service_disposed: service disposed during acquire');
        }
        this.byKeyMap.set(sessionKey, session);
        this.byIdMap.set(session.id, session);
        this.lastUsedAt.set(session.id, Date.now());
        return session;
      } finally {
        this.byKeyInflight.delete(sessionKey);
      }
    })();
    this.byKeyInflight.set(sessionKey, promise);
    return promise;
  }

  async get(sessionKey: string): Promise<BrowserSession | undefined> {
    const found = this.byKeyMap.get(sessionKey);
    if (!found || this.closing.has(found.id)) return undefined;
    this.lastUsedAt.set(found.id, Date.now());
    return found;
  }

  async byId(id: BrowserSessionId): Promise<BrowserSession | undefined> {
    const found = this.byIdMap.get(id);
    if (!found || this.closing.has(found.id)) return undefined;
    this.lastUsedAt.set(found.id, Date.now());
    return found;
  }

  async close(sessionKeyOrId: string): Promise<boolean> {
    let session =
      this.byKeyMap.get(sessionKeyOrId) ?? this.byIdMap.get(sessionKeyOrId as BrowserSessionId);
    if (session && this.closing.has(session.id)) return true; // 在途关闭 = 已受理
    if (!session) {
      // 关闭与在途 acquire 交错：等 launch 落地再关（防「close 返回后会话复活」）
      const inflight = this.byKeyInflight.get(sessionKeyOrId);
      if (inflight) {
        try {
          session = await inflight;
        } catch {
          return false; // acquire 失败 = 没有会话可关
        }
      }
    }
    if (!session) return false;
    return this.closeSession(session);
  }

  async list(): Promise<BrowserSessionInfo[]> {
    return this.port.list();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const sessions = [...this.byIdMap.values()];
    this.byKeyMap.clear();
    this.byIdMap.clear();
    this.lastUsedAt.clear();
    this.closing.clear();
    // 尽力关全部；单个失败不阻断其余（逐个隔离异常）
    for (const session of sessions) {
      try {
        await session.close();
      } catch {
        // 收尾路径：失败无法重试，吞掉但已尽力（dispose 是兜底回收）
      }
    }
  }

  /**
   * 关闭一个会话（closing 守卫 + 先关再摘表）。
   * 失败也摘表（评审 F8）：关闭失败的会话是半死态（如归档失败但浏览器已关），
   * 留表会毒化 acquire/get（全报 closed），代价是 close 不可重试、下次 acquire 重 launch。
   */
  private async closeSession(session: BrowserSession): Promise<boolean> {
    if (this.closing.has(session.id)) return true;
    this.closing.add(session.id);
    try {
      await session.close();
    } catch (err) {
      this.evict(session);
      this.closing.delete(session.id);
      throw err;
    }
    this.evict(session);
    this.closing.delete(session.id);
    return true;
  }

  private evict(session: BrowserSession): void {
    // 身份判定（评审 N3）：失败路径的 evict 可能晚于同 key 重 launch——只摘"仍是这个会话"的记录
    if (this.byKeyMap.get(session.ownerKey) === session) {
      this.byKeyMap.delete(session.ownerKey);
    }
    this.byIdMap.delete(session.id);
    this.lastUsedAt.delete(session.id);
  }

  private async sweepIdle(idleTimeoutMs: number): Promise<void> {
    const now = Date.now();
    for (const [id, usedAt] of [...this.lastUsedAt]) {
      if (now - usedAt <= idleTimeoutMs) continue;
      const session = this.byIdMap.get(id);
      if (!session || this.closing.has(id)) {
        if (!session) this.lastUsedAt.delete(id);
        continue;
      }
      try {
        await this.closeSession(session);
      } catch {
        // 回收失败：closeSession 已摘表（下次 acquire 重 launch）；
        // 极端情况下的进程级泄漏风险已记入 KNOWN-ISSUES
      }
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('browser_service_disposed: browser service has been disposed');
    }
  }
}
