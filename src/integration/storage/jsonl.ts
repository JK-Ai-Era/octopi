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

import { access, mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../../harness/session-types.js';
import type { SessionMeta } from '../../core/types.js';
import { toSessionFileName, legacySessionFileName } from './session-filename.js';

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * 优先安全文件名；若不存在则回退旧版原始 sessionId 文件名（macOS 历史数据），
 * 并就地 rename 迁移到安全名，避免跨平台同步后读不到。
 */
async function resolveSessionPath(preferred: string, legacy: string | null): Promise<string | null> {
  if (await fileExists(preferred)) return preferred;
  if (legacy && await fileExists(legacy)) {
    try {
      await rename(legacy, preferred);
      return preferred;
    } catch {
      return legacy;
    }
  }
  return null;
}

export class JsonlSessionStore implements SessionStore<SessionData> {
 private agentHomeResolver: (agentId: string) => string;

  /**
   * @param agentHomeResolver - 根据 agentId 返回该 agent 的 home 目录路径
   */
  constructor(agentHomeResolver: (agentId: string) => string) {
    this.agentHomeResolver = agentHomeResolver;
  }

  private sessionsDir(agentId: string): string {
    return join(this.agentHomeResolver(agentId), 'sessions');
  }

  private metaFile(agentId: string): string {
    return join(this.sessionsDir(agentId), 'sessions.json');
  }

  private sessionFile(agentId: string, sessionId: string): string {
    return join(this.sessionsDir(agentId), `${toSessionFileName(sessionId)}.jsonl`);
  }

  private legacySessionFile(agentId: string, sessionId: string): string | null {
    const legacy = legacySessionFileName(sessionId);
    return legacy === null ? null : join(this.sessionsDir(agentId), `${legacy}.jsonl`);
  }

  /** 会话附带状态（tasks / turns / metadata），与消息 JSONL 分离，兼容旧文件 */
  private sessionStateFile(agentId: string, sessionId: string): string {
    return join(this.sessionsDir(agentId), `${toSessionFileName(sessionId)}.state.json`);
  }

  private legacySessionStateFile(agentId: string, sessionId: string): string | null {
    const legacy = legacySessionFileName(sessionId);
    return legacy === null ? null : join(this.sessionsDir(agentId), `${legacy}.state.json`);
  }

  async load(agentId: string, sessionId: string): Promise<SessionData | null> {
    const file = await resolveSessionPath(
      this.sessionFile(agentId, sessionId),
      this.legacySessionFile(agentId, sessionId),
    );
    const statePath = await resolveSessionPath(
      this.sessionStateFile(agentId, sessionId),
      this.legacySessionStateFile(agentId, sessionId),
    );
    const hasMessages = file !== null;
    const hasState = statePath !== null;
    if (!hasMessages && !hasState) return null;

    let messages: SessionData['messages'] = [];
    if (hasMessages && file) {
      const content = await readFile(file, 'utf-8');
      messages = content.split('\n')
        .filter(line => line.trim())
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    }

    let meta: SessionMeta | null = null;
    const metaPath = this.metaFile(agentId);
    if (await fileExists(metaPath)) {
      try {
        const allMeta = JSON.parse(await readFile(metaPath, 'utf-8'));
        meta = allMeta[sessionId] ?? null;
      } catch { /* corrupt meta, use fallback */ }
    }

    let state: { tasks?: SessionData['tasks']; turns?: SessionData['turns']; metadata?: SessionData['metadata'] } = {};
    if (hasState && statePath) {
      try {
        state = JSON.parse(await readFile(statePath, 'utf-8'));
      } catch { /* corrupt state, ignore */ }
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
      turns: state.turns ?? [],
      metadata: state.metadata ?? {},
      tasks: state.tasks ?? [],
    };
  }

  async save(agentId: string, sessionId: string, data: SessionData): Promise<void> {
    const dir = this.sessionsDir(agentId);
    await mkdir(dir, { recursive: true });

    // 保存元数据索引
    const metaPath = this.metaFile(agentId);
    let allMeta: Record<string, SessionMeta> = {};
    if (await fileExists(metaPath)) {
      try { allMeta = JSON.parse(await readFile(metaPath, 'utf-8')); } catch {}
    }
    allMeta[sessionId] = data.meta;
    await writeFile(metaPath, JSON.stringify(allMeta, null, 2));

    // 保存消息（JSONL 格式，单次写入替代 append 循环）
    const sessionPath = this.sessionFile(agentId, sessionId);
    const jsonl = data.messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
    await writeFile(sessionPath, jsonl);

    // 保存会话附带状态（任务列表等）
    const statePath = this.sessionStateFile(agentId, sessionId);
    await writeFile(statePath, JSON.stringify({
      tasks: data.tasks ?? [],
      turns: data.turns ?? [],
      metadata: data.metadata ?? {},
    }, null, 2));
  }

  async list(agentId: string): Promise<SessionMeta[]> {
    const metaPath = this.metaFile(agentId);
    if (!await fileExists(metaPath)) return [];

    try {
      const allMeta = JSON.parse(await readFile(metaPath, 'utf-8'));
      return Object.values(allMeta);
    } catch {
      return [];
    }
  }

  async delete(agentId: string, sessionId: string): Promise<void> {
    const paths = [
      this.sessionFile(agentId, sessionId),
      this.legacySessionFile(agentId, sessionId),
      this.sessionStateFile(agentId, sessionId),
      this.legacySessionStateFile(agentId, sessionId),
    ];
    for (const p of paths) {
      if (p && await fileExists(p)) {
        await unlink(p);
      }
    }

    // 更新元数据索引
    const metaPath = this.metaFile(agentId);
    if (await fileExists(metaPath)) {
      try {
        const allMeta = JSON.parse(await readFile(metaPath, 'utf-8'));
        delete allMeta[sessionId];
        await writeFile(metaPath, JSON.stringify(allMeta, null, 2));
      } catch { /* ignore */ }
    }
  }

  async exists(agentId: string, sessionId: string): Promise<boolean> {
    const resolved = await resolveSessionPath(
      this.sessionFile(agentId, sessionId),
      this.legacySessionFile(agentId, sessionId),
    );
    return resolved !== null;
  }
}
