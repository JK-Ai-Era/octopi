import type { Session } from './types.js';

/**
 * Session 管理器
 *
 * 负责 session 的 CRUD 和生命周期
 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  add(session: Session): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** 清理过期 session（默认 2 小时过期） */
  cleanup(maxAgeMs: number = 2 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > maxAgeMs) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  get size(): number {
    return this.sessions.size;
  }
}
