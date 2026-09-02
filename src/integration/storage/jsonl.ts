/**
 * JsonlSessionStore — JSONL 文件存储
 *
 * 默认的 Session 存储后端。数据存储在文件系统中：
 *   <agentHome>/
 *     sessions/
 *       sessions.json          ← 所有 session 的元数据索引
 *       <sessionId>.jsonl      ← 每个 session 的对话记录（JSONL 格式）
 *
 * 所有操作都通过 agentId 定位到具体目录，不做全量扫描。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../../harness/session-types.js';
import type { SessionMeta } from '../../core/types.js';

export class JsonlSessionStore implements SessionStore<SessionData> {
  private agentHomeResolver: (agentId: string) => string;

  /**
   * @param agentHomeResolver - 根据 agentId 返回该 agent 的 home 目录路径
   * @param legacyDataDir - 向后兼容：旧的全局 dataDir 路径（已废弃）
   */
  constructor(
    agentHomeResolver: (agentId: string) => string,
    legacyDataDir?: string,
  ) {
    // 如果传了 legacyDataDir，用旧的目录结构：dataDir/{agentId}/
    if (legacyDataDir) {
      this.agentHomeResolver = (agentId: string) => join(legacyDataDir, agentId);
    } else {
      this.agentHomeResolver = agentHomeResolver;
    }
  }

  private sessionsDir(agentId: string): string {
    return join(this.agentHomeResolver(agentId), 'sessions');
  }

  private metaFile(agentId: string): string {
    return join(this.sessionsDir(agentId), 'sessions.json');
  }

  private sessionFile(agentId: string, sessionId: string): string {
    return join(this.sessionsDir(agentId), `${sessionId}.jsonl`);
  }

  async load(agentId: string, sessionId: string): Promise<SessionData | null> {
    const file = this.sessionFile(agentId, sessionId);
    if (!existsSync(file)) return null;

    const content = readFileSync(file, 'utf-8');
    const messages = content.split('\n')
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    // 读取元数据
    let meta: SessionMeta | null = null;
    const metaFile = this.metaFile(agentId);
    if (existsSync(metaFile)) {
      try {
        const allMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));
        meta = allMeta[sessionId] ?? null;
      } catch { /* corrupt meta, use fallback */ }
    }

    return {
      id: sessionId,
      agentId,
      meta: meta ?? {
        id: sessionId,
        agentId,
        channelId: 'unknown',
        peerId: 'unknown',
        status: 'idle',
        createdAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages,
      turns: [],
      metadata: {},
    };
  }

  async save(agentId: string, sessionId: string, data: SessionData): Promise<void> {
    const dir = this.sessionsDir(agentId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // 保存元数据索引
    const metaFile = this.metaFile(agentId);
    let allMeta: Record<string, SessionMeta> = {};
    if (existsSync(metaFile)) {
      try { allMeta = JSON.parse(readFileSync(metaFile, 'utf-8')); } catch {}
    }
    allMeta[sessionId] = data.meta;
    writeFileSync(metaFile, JSON.stringify(allMeta, null, 2));

    // 保存消息（JSONL 格式，全量覆写）
    const sessionFile = this.sessionFile(agentId, sessionId);
    writeFileSync(sessionFile, '');
    for (const msg of data.messages) {
      appendFileSync(sessionFile, JSON.stringify(msg) + '\n');
    }
  }

  async list(agentId: string): Promise<SessionMeta[]> {
    const metaFile = this.metaFile(agentId);
    if (!existsSync(metaFile)) return [];

    try {
      const allMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));
      return Object.values(allMeta);
    } catch {
      return [];
    }
  }

  async delete(agentId: string, sessionId: string): Promise<void> {
    const file = this.sessionFile(agentId, sessionId);
    if (existsSync(file)) {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(file);
    }

    // 更新元数据索引
    const metaFile = this.metaFile(agentId);
    if (existsSync(metaFile)) {
      try {
        const allMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));
        delete allMeta[sessionId];
        writeFileSync(metaFile, JSON.stringify(allMeta, null, 2));
      } catch { /* ignore */ }
    }
  }

  async exists(agentId: string, sessionId: string): Promise<boolean> {
    return existsSync(this.sessionFile(agentId, sessionId));
  }
}
