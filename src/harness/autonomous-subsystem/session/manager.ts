/**
 * Autonomous Subsystem — SubsystemSessionManager
 *
 * 子系统会话管理。支持 ephemeral / persistent 模式，
 * 三级 scope 隔离（global / agent / session）。
 *
 * @module autonomous-subsystem/session/manager
 */

import type { Message } from '../../../core/types.js';
import type { SessionConfig, SessionScope } from '../types.js';

// ── SubsystemSession ──

/** 子系统会话 */
export interface SubsystemSession {
  /** 会话 key（由 scope + agentId + sessionId + subsystemId 组合） */
  key: string;
  /** 消息历史 */
  messages: Message[];
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessAt: number;
  /** 关联的 Agent ID */
  agentId?: string;
  /** 关联的 Session ID */
  sessionId?: string;
}

// ── TTL 解析 ──

/**
 * 解析 TTL 字符串为毫秒
 *
 * 支持格式：'30m'、'24h'、'7d'
 */
export function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 30 * 60 * 1000; // 默认 30 分钟

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

// ── SubsystemSessionManager ──

/**
 * SubsystemSessionManager — 子系统会话管理器
 *
 * 职责：
 * 1. 管理 ephemeral / persistent 会话的创建和销毁
 * 2. 按 scope 隔离会话（global / agent / session）
 * 3. TTL 过期清理
 */
export class SubsystemSessionManager {
  /** 持久会话存储 */
  private sessions = new Map<string, SubsystemSession>();
  /** TTL 清理定时器 */
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor() {
    // 每 60 秒清理过期会话
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
  }

  /**
   * 获取或创建会话
   *
   * @param subsystemId - 子系统 ID
   * @param config - Session 配置
   * @param agentId - Agent ID（scope=agent/session 时必需）
   * @param sessionId - Session ID（scope=session 时必需）
   * @returns 会话实例
   */
  getOrCreate(
    subsystemId: string,
    config: SessionConfig,
    agentId?: string,
    sessionId?: string,
  ): SubsystemSession {
    const key = this.buildKey(subsystemId, config.scope, agentId, sessionId);

    if (config.mode === 'ephemeral') {
      // ephemeral：每次创建新会话
      return this.createSession(key, agentId, sessionId);
    }

    // persistent：查找已有会话或创建
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastAccessAt = Date.now();
      return existing;
    }

    const session = this.createSession(key, agentId, sessionId);
    this.sessions.set(key, session);
    return session;
  }

  /**
   * 删除会话
   */
  delete(subsystemId: string, scope: SessionScope, agentId?: string, sessionId?: string): void {
    const key = this.buildKey(subsystemId, scope, agentId, sessionId);
    this.sessions.delete(key);
  }

  /**
   * 获取当前活跃的持久会话数量
   */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * 清理所有会话
   */
  dispose(): void {
    this.sessions.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  // ── 内部方法 ──

  private buildKey(subsystemId: string, scope: SessionScope, agentId?: string, sessionId?: string): string {
    switch (scope) {
      case 'global':
        return subsystemId;
      case 'agent':
        return `${subsystemId}:${agentId ?? 'default'}`;
      case 'session':
        return `${subsystemId}:${agentId ?? 'default'}:${sessionId ?? 'default'}`;
    }
  }

  private createSession(key: string, agentId?: string, sessionId?: string): SubsystemSession {
    const now = Date.now();
    const session: SubsystemSession = {
      key,
      messages: [],
      createdAt: now,
      lastAccessAt: now,
      agentId,
      sessionId,
    };
    return session;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const defaultTTL = 30 * 60 * 1000; // 30 分钟

    for (const [key, session] of this.sessions) {
      if (now - session.lastAccessAt > defaultTTL) {
        this.sessions.delete(key);
      }
    }
  }
}
