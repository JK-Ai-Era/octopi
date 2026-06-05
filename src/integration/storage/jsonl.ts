/**
 * JsonlSessionStore — JSONL 文件存储
 *
 * 默认的 Session 存储后端。数据存储在文件系统中：
 *   .octopi/sessions/
 *     <agentId>/
 *       sessions.json          ← 所有 session 的元数据
 *       <sessionId>.jsonl      ← 每个 session 的对话记录（JSONL 格式）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStore, SessionData } from '../../core/interfaces/session-store.js';
import type { SessionMeta } from '../../core/types.js';

export class JsonlSessionStore implements SessionStore {
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? '.octopi/sessions';
  }

  async load(sessionId: string): Promise<SessionData | null> {
    // 扫描所有 agent 目录
    if (!existsSync(this.dataDir)) return null;

    const agentDirs = readdirSync(this.dataDir, { withFileTypes: true })
      .filter((d: any) => d.isDirectory());

    for (const dir of agentDirs) {
      const sessionFile = join(this.dataDir, dir.name, `${sessionId}.jsonl`);
      const metaFile = join(this.dataDir, dir.name, 'sessions.json');

      if (existsSync(sessionFile)) {
        // 读取消息
        const content = readFileSync(sessionFile, 'utf-8');
        const messages = content.split('\n')
          .filter(line => line.trim())
          .map(line => { try { return JSON.parse(line); } catch { return null; } })
          .filter(Boolean);

        // 读取元数据
        let meta: SessionMeta | null = null;
        if (existsSync(metaFile)) {
          const allMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));
          meta = allMeta[sessionId] ?? null;
        }

        return {
          id: sessionId,
          agentId: dir.name,
          meta: meta ?? {
            id: sessionId,
            agentId: dir.name,
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
    }

    return null;
  }

  async save(sessionId: string, data: SessionData): Promise<void> {
    const agentDir = join(this.dataDir, data.agentId);
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    // 保存元数据
    const metaFile = join(agentDir, 'sessions.json');
    let allMeta: Record<string, SessionMeta> = {};
    if (existsSync(metaFile)) {
      try { allMeta = JSON.parse(readFileSync(metaFile, 'utf-8')); } catch {}
    }
    allMeta[sessionId] = data.meta;
    writeFileSync(metaFile, JSON.stringify(allMeta, null, 2));

    // 保存消息（JSONL 格式，追加写入）
    const sessionFile = join(agentDir, `${sessionId}.jsonl`);
    // 先清空文件，再写入所有消息
    writeFileSync(sessionFile, '');
    for (const msg of data.messages) {
      appendFileSync(sessionFile, JSON.stringify(msg) + '\n');
    }
  }

  async list(agentId: string): Promise<SessionMeta[]> {
    const metaFile = join(this.dataDir, agentId, 'sessions.json');
    if (!existsSync(metaFile)) return [];

    try {
      const allMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));
      return Object.values(allMeta);
    } catch {
      return [];
    }
  }

  async delete(sessionId: string): Promise<void> {
    // 扫描所有 agent 目录
    if (!existsSync(this.dataDir)) return;

    const agentDirs = readdirSync(this.dataDir, { withFileTypes: true })
      .filter((d: any) => d.isDirectory());

    for (const dir of agentDirs) {
      const sessionFile = join(this.dataDir, dir.name, `${sessionId}.jsonl`);
      if (existsSync(sessionFile)) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(sessionFile);

        // 更新元数据
        const metaFile = join(this.dataDir, dir.name, 'sessions.json');
        if (existsSync(metaFile)) {
          const allMeta = JSON.parse(readFileSync(metaFile, 'utf-8'));
          delete allMeta[sessionId];
          writeFileSync(metaFile, JSON.stringify(allMeta, null, 2));
        }
      }
    }
  }

  async exists(sessionId: string): Promise<boolean> {
    if (!existsSync(this.dataDir)) return false;

    const agentDirs = readdirSync(this.dataDir, { withFileTypes: true })
      .filter((d: any) => d.isDirectory());

    for (const dir of agentDirs) {
      const sessionFile = join(this.dataDir, dir.name, `${sessionId}.jsonl`);
      if (existsSync(sessionFile)) return true;
    }

    return false;
  }
}
