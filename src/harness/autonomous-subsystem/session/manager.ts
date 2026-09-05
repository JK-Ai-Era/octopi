import type { Message } from '../../../core/types.js';
import type { SessionConfig, SessionScope } from '../types.js';

export interface SubsystemSession {
  key: string;
  messages: Message[];
  createdAt: number;
  lastAccessAt: number;
  agentId?: string;
  sessionId?: string;
  /** 该会话的有效 TTL（毫秒） */
  ttlMs: number;
}

export function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 30 * 60 * 1000;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'ms': return value;
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 30 * 60 * 1000;
  }
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class SubsystemSessionManager {
  private sessions = new Map<string, SubsystemSession>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
  }

  getOrCreate(
    subsystemId: string,
    config: SessionConfig,
    agentId?: string,
    sessionId?: string,
  ): SubsystemSession {
    const key = this.buildKey(subsystemId, config.scope, agentId, sessionId);
    const ttlMs = config.ttl ? parseTTL(config.ttl) : DEFAULT_TTL_MS;

    if (config.mode === 'ephemeral') {
      return this.createSession(key, ttlMs, agentId, sessionId);
    }

    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastAccessAt = Date.now();
      return existing;
    }

    const session = this.createSession(key, ttlMs, agentId, sessionId);
    this.sessions.set(key, session);
    return session;
  }

  delete(subsystemId: string, scope: SessionScope, agentId?: string, sessionId?: string): void {
    const key = this.buildKey(subsystemId, scope, agentId, sessionId);
    this.sessions.delete(key);
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  dispose(): void {
    this.sessions.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private buildKey(subsystemId: string, scope: SessionScope, agentId?: string, sessionId?: string): string {
    switch (scope) {
      case 'global': return subsystemId;
      case 'agent': return `${subsystemId}:${agentId ?? 'default'}`;
      case 'session': return `${subsystemId}:${agentId ?? 'default'}:${sessionId ?? 'default'}`;
    }
  }

  private createSession(key: string, ttlMs: number, agentId?: string, sessionId?: string): SubsystemSession {
    const now = Date.now();
    return { key, messages: [], createdAt: now, lastAccessAt: now, agentId, sessionId, ttlMs };
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastAccessAt > session.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }
}
