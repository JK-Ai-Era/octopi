/**
 * DefaultSessionHistoryPort — 基于 SessionStore 的 Information 只读检索。
 *
 * 权限：participated（sessionMatchesAgent）× filterHistory(readScope)。
 * archive 仅 includeArchived 时扫描（冷备，默认关）。
 */

import { readdir, readFile } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join } from 'node:path';

import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { Message, SessionMeta } from '../../core/types.js';
import type { SessionData } from '../session-types.js';
import type { SessionAclService } from '../session-acl/service.js';
import type { EffectiveSessionRights, SessionParticipant, SessionRights } from '../session-acl/types.js';
import { computeEffectiveRights } from '../session-acl/rights.js';
import { sessionMatchesAgent } from '../../integration/storage/memory.js';

import type {
  SessionHistoryBrief,
  SessionHistoryListFilter,
  SessionHistoryOpenRequest,
  SessionHistoryPort,
  SessionHistoryQuery,
  SessionHistorySearchResult,
  SessionHistorySessionHit,
  SessionHistoryWindow,
  SessionHistoryWindowMessage,
} from './types.js';
import { formatHistoryRef, parseHistoryRef, messageText } from './types.js';
import {
  applyRoleWeight,
  authorAllows,
  extractSearchableFields,
  makeSnippet,
  matchFields,
  sessionScore,
} from './score.js';

const gunzipAsync = promisify(gunzip);

export interface SessionHistoryOptions {
  store: SessionStore<SessionData>;
  /** 注入后按 E6 filterHistory 裁剪；未注入则 participated 可读全量 */
  sessionAcl?: SessionAclService;
  /** 归档目录；供 includeArchived 冷备扫描 */
  archiveDir?: string;
  /** 宿主策略：默认 participated；all 仅管理面（不进模型参数） */
  historyScope?: 'participated' | 'all';
  /**
   * 可选投影索引（P2）。提供时 search 先 SQL 缩候选，再精打分；
   * 无索引或索引异常时回退全量扫描（行为与 P1 一致）。
   */
  index?: import('../../integration/storage/session-index.js').SessionIndexBackend;
  /**
   * Agent 天花板（E6：L0 ∩ role.max ∩ **agent.max** ∩ binding）。
   * 与 Runner `agentMaxSessionRights` 同源；缺省不收紧。
   */
  resolveAgentMax?: (agentId: string) => SessionRights | undefined;
}

/**
 * 创建 SessionHistoryPort
 *
 * @param options - store / ACL / archive
 * @returns SessionHistoryPort
 */
export function createSessionHistoryPort(options: SessionHistoryOptions): SessionHistoryPort {
  return new DefaultSessionHistoryPort(options);
}

/**
 * 只读解析 History 可见性（不 auto-grant，避免 authorizeRun 副作用）。
 * E6：effective = L0 ∩ role.max ∩ agent.max ∩ binding。
 *
 * @param acl - SessionAclService
 * @param session - 目标会话
 * @param agentId - 当前 agent
 * @param agentMax - Agent 权利天花板（可选）
 * @returns rights + participant；无权返回 null
 */
export function resolveHistoryAccess(
  acl: SessionAclService,
  session: SessionData,
  agentId: string,
  agentMax?: SessionRights,
): { rights: EffectiveSessionRights; participant?: SessionParticipant } | null {
  const participant = acl.resolveParticipant(session, agentId);
  if (participant) {
    const role = acl.catalog.get(participant.roleId);
    if (!role) return null;
    const rights = computeEffectiveRights({
      role,
      agentMax,
      participantRights: participant.rights,
      allowAgentInitiatedHandoff: false,
    });
    return { rights, participant };
  }

  const primary = session.primaryAgentId ?? session.agentId;
  if (agentId === primary) {
    // primary 无绑定时等同 owner 默认，再与 agentMax 求交（E6）
    const ownerDefaults: EffectiveSessionRights = {
      canRun: true,
      readScope: 'full',
      writeMemory: true,
      canManageTasks: true,
      canHandoff: false,
    };
    const rights = computeEffectiveRights({
      role: { id: 'owner', defaults: ownerDefaults, max: ownerDefaults },
      agentMax,
      allowAgentInitiatedHandoff: false,
    });
    return { rights };
  }

  // preferred / 其它无绑定：fail-closed（I6 / E6）
  return null;
}

class DefaultSessionHistoryPort implements SessionHistoryPort {
  constructor(private readonly options: SessionHistoryOptions) {}

  async search(query: SessionHistoryQuery): Promise<SessionHistorySearchResult> {
    const limit = clamp(query.limit ?? (query.groupBy === 'message' ? 20 : 8), 1, 50);
    const snippetChars = clamp(query.snippetChars ?? 200, 40, 400);
    const includeToolIo = query.includeToolIo === true;
    const mode = query.mode ?? 'keyword';
    const author = query.author ?? 'any';
    // 与工具契约一致：缺省只搜 user/assistant（显式传 roles 才搜 tool/system）
    const roles =
      query.roles && query.roles.length
        ? new Set(query.roles)
        : new Set(['user', 'assistant'] as const);
    const selfAgentId = query.agentId ?? '';

    let searchedSessions = 0;
    let searchedMessages = 0;
    const sessionHits: SessionHistorySessionHit[] = [];

    let candidates = await this.listCandidateMetas(query);
    const archiveExtras =
      query.includeArchived && selfAgentId
        ? await this.listArchiveCandidates(query, selfAgentId)
        : [];

    // P2：有索引则 SQL 缩候选（打分/ACL 仍走原路径）
    // prefilter null = 索引不可用/可能漏检 → 不过滤（回退扫描）
    const indexPrefilter = await this.tryPrefilter(query, selfAgentId);
    if (indexPrefilter) {
      candidates = candidates.filter((m) => indexPrefilter.has(m.id));
    }

    for (const item of [...candidates.map((m) => ({ meta: m, source: 'hot' as const })),
      ...archiveExtras]) {
      searchedSessions++;
      const loaded = await this.loadSession(item.meta.id, item.source, selfAgentId, query.includeArchived === true);
      if (!loaded) continue;

      const { messages } = loaded;
      const hits: SessionHistorySessionHit['hits'] = [];
      for (const { index, message: msg } of messages) {
        searchedMessages++;
        if (!roles.has(msg.role)) continue;
        if (selfAgentId && !authorAllows(msg.agentId, selfAgentId, author)) continue;

        const fields = extractSearchableFields(msg, includeToolIo);
        const matches = matchFields(fields, query.query, mode);
        if (!matches.length) continue;

        const best = matches[0];
        hits.push({
          ref: formatHistoryRef(item.meta.id, index),
          sessionId: item.meta.id,
          messageIndex: index,
          role: msg.role,
          timestamp: msg.timestamp,
          agentId: msg.agentId,
          snippet: makeSnippet(best.text, best.matchStart, best.matchEnd, snippetChars),
          matchField: best.field,
          score: applyRoleWeight(msg.role, best.score),
        });
      }

      if (!hits.length) continue;
      hits.sort((a, b) => b.score - a.score);
      sessionHits.push({
        sessionId: item.meta.id,
        score: sessionScore(hits.map((h) => h.score)),
        hitCount: hits.length,
        updatedAt: item.meta.updatedAt ?? 0,
        lifecycle: item.meta.lifecycle,
        primaryAgentId: item.meta.primaryAgentId,
        agentId: item.meta.agentId,
        hits: hits.slice(0, query.groupBy === 'message' ? limit : 5),
        source: item.source,
      });
    }

    sessionHits.sort((a, b) => b.score - a.score);

    if (query.groupBy === 'message') {
      const flat = sessionHits
        .flatMap((s) => s.hits.map((h) => ({ session: s, hit: h })))
        .sort((a, b) => b.hit.score - a.hit.score)
        .slice(0, limit);
      const bySession = new Map<string, SessionHistorySessionHit>();
      for (const { session, hit } of flat) {
        let entry = bySession.get(session.sessionId);
        if (!entry) {
          entry = { ...session, hits: [], hitCount: session.hitCount, score: session.score };
          bySession.set(session.sessionId, entry);
        }
        entry.hits.push(hit);
      }
      const sessions = [...bySession.values()];
      return {
        sessions,
        searched: { sessions: searchedSessions, messages: searchedMessages },
        truncated: sessionHits.reduce((n, s) => n + s.hitCount, 0) > limit,
        totalHits: sessionHits.reduce((n, s) => n + s.hitCount, 0),
      };
    }

    const limited = sessionHits.slice(0, limit);
    const totalHits = sessionHits.reduce((n, s) => n + s.hitCount, 0);
    return {
      sessions: limited,
      searched: { sessions: searchedSessions, messages: searchedMessages },
      truncated: sessionHits.length > limited.length,
      totalHits,
    };
  }

  async open(request: SessionHistoryOpenRequest): Promise<SessionHistoryWindow | null> {
    let center = request.aroundIndex;
    if (center == null && request.aroundRef) {
      const parsed = parseHistoryRef(request.aroundRef);
      if (!parsed || parsed.sessionId !== request.sessionId) return null;
      center = parsed.messageIndex;
    }

    const loaded = await this.loadSession(
      request.sessionId,
      'hot',
      request.agentId,
      request.includeArchived === true,
    );
    if (!loaded) return null;

    const { messages, source, session } = loaded;
    const totalMessages = session.messages?.length ?? 0;
    if (!messages.length) {
      return {
        sessionId: request.sessionId,
        source,
        messages: [],
        totalMessages,
        fromIndex: 0,
        toIndex: -1,
        truncated: false,
      };
    }

    // center 是全文下标；在可见子序列上取邻域（仍输出原始 index）
    let pos = messages.findIndex((m) => m.index >= (center ?? 0));
    if (pos < 0) pos = messages.length - 1;
    const before = clamp(request.before ?? 2, 0, 20);
    const after = clamp(request.after ?? 3, 0, 20);
    const fromPos = Math.max(0, pos - before);
    const toPos = Math.min(messages.length - 1, pos + after);
    const format = request.format ?? 'transcript';
    const includeToolIo = request.includeToolIo === true;

    const windowMessages: SessionHistoryWindowMessage[] = [];
    for (let p = fromPos; p <= toPos; p++) {
      const { index, message: m } = messages[p];
      windowMessages.push({
        index,
        role: m.role,
        timestamp: m.timestamp,
        agentId: m.agentId,
        text: this.renderMessage(m, format, includeToolIo),
        toolNames: (m.toolCalls ?? []).map((c) => c.name),
      });
    }

    const fromIndex = windowMessages[0]?.index ?? 0;
    const toIndex = windowMessages[windowMessages.length - 1]?.index ?? -1;
    return {
      sessionId: request.sessionId,
      source,
      messages: windowMessages,
      totalMessages,
      fromIndex,
      toIndex,
      truncated: fromPos > 0 || toPos < messages.length - 1,
    };
  }

  async list(filter?: SessionHistoryListFilter): Promise<SessionHistoryBrief[]> {
    const metas = await this.listCandidateMetas({ agentId: filter?.agentId });
    const out: SessionHistoryBrief[] = [];
    for (const meta of metas) {
      if (filter?.lifecycle && (meta.lifecycle ?? 'active') !== filter.lifecycle) continue;
      out.push({
        sessionId: meta.id,
        agentId: meta.agentId,
        primaryAgentId: meta.primaryAgentId,
        updatedAt: meta.updatedAt,
        lifecycle: meta.lifecycle,
      });
      if (filter?.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  /**
   * 索引预筛。
   * @returns 候选 id 集合；`null` = 回退扫描（无 index / regex / 索引异常或可能截断漏检）
   */
  private async tryPrefilter(
    query: SessionHistoryQuery,
    agentId: string,
  ): Promise<Set<string> | null> {
    const index = this.options.index;
    if (!index) return null;
    if ((query.mode ?? 'keyword') === 'regex') return null;

    try {
      const q = query.query.trim();
      if (!q) return null;
      const terms =
        (query.mode ?? 'keyword') === 'phrase'
          ? [q]
          : q.split(/\s+/).filter(Boolean);
      const candidates = await index.prefilter({
        terms,
        mode: query.mode ?? 'keyword',
        roles: query.roles?.map(String),
        agentId: agentId || undefined,
        sessionIds: query.sessionIds,
        since: query.since,
        until: query.until,
        includeArchived: query.includeArchived === true,
        includeToolIo: query.includeToolIo === true,
        limitSessions: 50,
      });
      // null → 回退扫描；[] → 索引确信无命中
      if (candidates == null) return null;
      return new Set(candidates.map((c) => c.sessionId));
    } catch {
      // 索引异常回退扫描（I2：投影可重建，不拖垮检索）
      return null;
    }
  }

  private async listCandidateMetas(query: {
    agentId?: string;
    sessionIds?: string[];
    since?: number;
    until?: number;
  }): Promise<SessionMeta[]> {
    const scope = this.options.historyScope ?? 'participated';
    let metas = await this.options.store.list(
      scope === 'participated' && query.agentId ? { agentId: query.agentId } : undefined,
    );

    if (query.sessionIds?.length) {
      const allow = new Set(query.sessionIds);
      metas = metas.filter((m) => allow.has(m.id));
    }
    if (query.since != null) {
      metas = metas.filter((m) => (m.updatedAt ?? 0) >= query.since!);
    }
    if (query.until != null) {
      metas = metas.filter((m) => (m.updatedAt ?? 0) <= query.until!);
    }
    if (scope === 'participated' && query.agentId) {
      const agentId = query.agentId;
      metas = metas.filter((m) => sessionMatchesAgent(m, agentId));
    }
    return metas;
  }

  private async listArchiveCandidates(
    query: { query: string; sessionIds?: string[]; since?: number; until?: number },
    agentId: string,
  ): Promise<Array<{ meta: SessionMeta; source: 'archive' }>> {
    const dir = this.options.archiveDir;
    if (!dir) return [];
    const out: Array<{ meta: SessionMeta; source: 'archive' }> = [];
    const scope = this.options.historyScope ?? 'participated';

    let files: string[];
    try {
      files = (await readdir(dir)).filter((e) => e.endsWith('.sessions.jsonl.gz'));
    } catch {
      return [];
    }

    for (const file of files.sort()) {
      let entries: Array<{ sessionId: string; data: SessionData }>;
      try {
        const buf = await gunzipAsync(await readFile(join(dir, file)));
        entries = buf
          .toString('utf-8')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as { sessionId: string; data: SessionData });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (query.sessionIds?.length && !query.sessionIds.includes(entry.sessionId)) continue;
        const meta = entry.data.meta;
        if (query.since != null && (meta?.updatedAt ?? 0) < query.since) continue;
        if (query.until != null && (meta?.updatedAt ?? 0) > query.until) continue;
        if (scope === 'participated') {
          const pick = {
            agentId: entry.data.agentId ?? meta?.agentId,
            primaryAgentId: entry.data.primaryAgentId ?? meta?.primaryAgentId,
            preferredAgentId: entry.data.preferredAgentId ?? meta?.preferredAgentId,
            participantAgentIds:
              meta?.participantAgentIds ??
              (entry.data.participants ?? []).map((p) => p.agentId),
          };
          if (!sessionMatchesAgent(pick, agentId)) continue;
        }
        out.push({
          meta: {
            ...meta,
            id: entry.sessionId,
            agentId: entry.data.agentId ?? meta?.agentId ?? 'default',
            lifecycle: entry.data.lifecycle?.lifecycle ?? meta?.lifecycle ?? 'archived',
            updatedAt: meta?.updatedAt ?? entry.data.lifecycle?.archivedAt ?? 0,
          },
          source: 'archive',
        });
      }
    }
    return out;
  }

  private async loadSession(
    sessionId: string,
    source: 'hot' | 'archive',
    agentId: string | undefined,
    includeArchived: boolean,
  ): Promise<{
    session: SessionData;
    messages: Array<{ index: number; message: Message }>;
    source: 'hot' | 'archive';
  } | null> {
    let session = await this.options.store.load(sessionId);
    let resolvedSource: 'hot' | 'archive' = 'hot';
    if (!session) {
      if (!includeArchived && source === 'hot') return null;
      session = await this.loadFromArchive(sessionId);
      resolvedSource = 'archive';
      if (!session) return null;
    }

    const messages = this.visibleMessages(session, agentId);
    return { session, messages, source: resolvedSource };
  }

  /**
   * 可见消息 **保留原始 index**（filterHistory 裁剪后 ref 仍对齐全文下标）。
   */
  private visibleMessages(
    session: SessionData,
    agentId: string | undefined,
  ): Array<{ index: number; message: Message }> {
    const all = session.messages ?? [];
    const indexed = all.map((message, index) => ({ index, message }));
    const scope = this.options.historyScope ?? 'participated';

    if (scope === 'participated' && agentId) {
      const pick = {
        agentId: session.agentId ?? session.meta?.agentId,
        primaryAgentId: session.primaryAgentId ?? session.meta?.primaryAgentId,
        preferredAgentId: session.preferredAgentId ?? session.meta?.preferredAgentId,
        participantAgentIds:
          session.meta?.participantAgentIds ??
          (session.participants ?? []).map((p) => p.agentId),
      };
      if (!sessionMatchesAgent(pick, agentId)) return [];
    }

    const acl = this.options.sessionAcl;
    if (!acl || !agentId) return indexed;

    const access = resolveHistoryAccess(
      acl,
      session,
      agentId,
      this.options.resolveAgentMax?.(agentId),
    );
    if (!access) return [];

    // 与 SessionAclService.filterHistory 同语义，但保留原始下标
    switch (access.rights.readScope) {
      case 'none':
        return [];
      case 'full':
        return indexed;
      case 'from_grant': {
        const participant = access.participant;
        // 缺 seq/at 一律 fail-closed（E6）
        if (!participant || participant.grantSeq == null || participant.grantedAt == null) {
          return [];
        }
        const at = participant.grantedAt;
        return indexed.filter(({ message }) => (message.timestamp ?? 0) >= at);
      }
      case 'summary_tail':
        return indexed.slice(-20);
      default:
        return indexed;
    }
  }

  private renderMessage(
    m: Message,
    format: 'transcript' | 'messages',
    includeToolIo: boolean,
  ): string {
    const body = messageText(m);
    const tools = (m.toolCalls ?? []).map((c) => c.name);
    if (format === 'messages') {
      return JSON.stringify({
        role: m.role,
        agentId: m.agentId,
        timestamp: m.timestamp,
        text: body,
        toolCalls: tools,
        toolIo: includeToolIo
          ? {
              args: (m.toolCalls ?? []).map((c) => c.arguments),
              results: (m.toolResults ?? []).map((r) => r.result),
            }
          : undefined,
      });
    }
    const toolNote = tools.length ? ` [tools: ${tools.join(', ')}]` : '';
    return `${m.role}${m.agentId ? `(${m.agentId})` : ''}: ${body}${toolNote}`;
  }

  private async loadFromArchive(sessionId: string): Promise<SessionData | null> {
    const dir = this.options.archiveDir;
    if (!dir) return null;
    let files: string[];
    try {
      files = (await readdir(dir)).filter((e) => e.endsWith('.sessions.jsonl.gz'));
    } catch {
      return null;
    }
    for (const file of files.sort()) {
      try {
        const buf = await gunzipAsync(await readFile(join(dir, file)));
        for (const line of buf.toString('utf-8').split('\n')) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as { sessionId: string; data: SessionData };
          if (entry.sessionId === sessionId) return entry.data;
        }
      } catch {
        // 跳过损坏归档文件
      }
    }
    return null;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
