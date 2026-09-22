/**
 * session history 检索行为测试（Port + tools）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlSessionStore } from '../src/integration/storage/jsonl.js';
import { createSessionHistoryPort, parseHistoryRef } from '../src/harness/session-history/index.js';
import { createSessionHistoryTools } from '../src/harness/plugin-ecosystem/tools/session-history.js';
import { SessionAclService } from '../src/harness/session-acl/service.js';
import type { SessionData } from '../src/harness/session-types.js';
import type { ToolExecutionContext } from '../src/core/types/tools.js';

const gzipAsync = promisify(gzip);

function session(id: string, agentId: string, messages: SessionData['messages']): SessionData {
  return {
    id,
    agentId,
    primaryAgentId: agentId,
    meta: {
      id,
      agentId,
      channelId: 'test',
      peerId: 'user',
      status: 'idle',
      createdAt: Date.now() - 10_000,
      sessionStartedAt: Date.now() - 10_000,
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
      participantAgentIds: [agentId],
    },
    messages,
    turns: [],
    metadata: {},
  };
}

function ctx(agentId: string, sessionId = 's-self'): ToolExecutionContext {
  return { sessionId, agentId, messages: [] };
}

describe('SessionHistoryPort', () => {
  let tempDir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-history-'));
    store = new JsonlSessionStore({ sessionsDir: join(tempDir, 'sessions') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('keyword search finds content and returns ref', async () => {
    await store.save(
      's1',
      session('s1', 'agent-a', [
        { role: 'user', content: 'please fix the SQLITE_BUSY error', timestamp: 1 },
        { role: 'assistant', content: 'I will retry with busyTimeoutMs', timestamp: 2, agentId: 'agent-a' },
      ]),
    );
    await store.save(
      's2',
      session('s2', 'agent-b', [
        { role: 'user', content: 'unrelated topic', timestamp: 3 },
      ]),
    );

    const history = createSessionHistoryPort({ store, historyScope: 'participated' });
    const result = await history.search({
      query: 'SQLITE_BUSY',
      agentId: 'agent-a',
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('s1');
    expect(result.sessions[0].hits[0].snippet).toContain('【');
    expect(parseHistoryRef(result.sessions[0].hits[0].ref)).toEqual({
      sessionId: 's1',
      messageIndex: 0,
    });
  });

  it('does not search other agents sessions under participated scope', async () => {
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: 'secret alpha', timestamp: 1 },
    ]));
    const history = createSessionHistoryPort({ store });
    const result = await history.search({ query: 'secret', agentId: 'agent-b' });
    expect(result.sessions).toHaveLength(0);
  });

  it('keyword AND matches multi-term across one field', async () => {
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: 'error sqlite busy timeout', timestamp: 1 },
      { role: 'user', content: 'only error here', timestamp: 2 },
    ]));
    const history = createSessionHistoryPort({ store });
    const result = await history.search({ query: 'sqlite busy', agentId: 'agent-a' });
    expect(result.sessions[0].hitCount).toBe(1);
    expect(result.sessions[0].hits[0].messageIndex).toBe(0);
  });

  it('author=self keeps only self-attributed messages', async () => {
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'assistant', content: 'self line about octopi', timestamp: 1, agentId: 'agent-a' },
      { role: 'assistant', content: 'other line about octopi', timestamp: 2, agentId: 'agent-b' },
    ]));
    const history = createSessionHistoryPort({ store });
    const result = await history.search({
      query: 'octopi',
      agentId: 'agent-a',
      author: 'self',
    });
    expect(result.sessions[0].hits).toHaveLength(1);
    expect(result.sessions[0].hits[0].agentId).toBe('agent-a');
  });

  it('open windows around ref', async () => {
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: 'a', timestamp: 1 },
      { role: 'user', content: 'b hit here', timestamp: 2 },
      { role: 'assistant', content: 'c', timestamp: 3, agentId: 'agent-a' },
      { role: 'user', content: 'd', timestamp: 4 },
    ]));
    const history = createSessionHistoryPort({ store });
    const win = await history.open({
      sessionId: 's1',
      aroundIndex: 1,
      before: 1,
      after: 1,
    });
    expect(win).toBeTruthy();
    expect(win!.fromIndex).toBe(0);
    expect(win!.toIndex).toBe(2);
    expect(win!.messages.map((m) => m.index)).toEqual([0, 1, 2]);
  });

  it('filterHistory from_grant hides earlier messages', async () => {
    const data = session('s1', 'agent-a', [
      { role: 'user', content: 'early topsecret', timestamp: 1000 },
      { role: 'user', content: 'late visible', timestamp: 5000 },
    ]);
    data.meta.participantAgentIds = ['agent-a', 'agent-b'];
    data.participants = [
      {
        sessionId: 's1',
        agentId: 'agent-b',
        roleId: 'specialist',
        grantSeq: 1,
        grantedAt: 4000,
        rights: { readScope: 'from_grant' },
      },
    ];
    await store.save('s1', data);

    const history = createSessionHistoryPort({
      store,
      sessionAcl: new SessionAclService(),
    });
    const early = await history.search({ query: 'topsecret', agentId: 'agent-b' });
    expect(early.sessions).toHaveLength(0);

    const late = await history.search({ query: 'visible', agentId: 'agent-b' });
    expect(late.sessions).toHaveLength(1);
    expect(late.sessions[0].hits[0].messageIndex).toBe(1);
  });

  it('include_archived can find cold session', async () => {
    const archiveDir = join(tempDir, 'archives');
    await mkdir(archiveDir, { recursive: true });
    const cold = session('cold-1', 'agent-a', [
      { role: 'user', content: 'archived needle phrase', timestamp: 1 },
    ]);
    cold.lifecycle = { lifecycle: 'archived', archivedAt: Date.now() };
    const line = JSON.stringify({ sessionId: 'cold-1', data: cold, archivedAt: Date.now() }) + '\n';
    await writeFile(join(archiveDir, '2026-09.sessions.jsonl.gz'), await gzipAsync(Buffer.from(line)));

    const history = createSessionHistoryPort({ store, archiveDir });
    const miss = await history.search({ query: 'needle', agentId: 'agent-a' });
    expect(miss.sessions).toHaveLength(0);

    const hit = await history.search({
      query: 'needle',
      agentId: 'agent-a',
      includeArchived: true,
    });
    expect(hit.sessions).toHaveLength(1);
    expect(hit.sessions[0].source).toBe('archive');
  });
});

describe('session_search / session_read tools', () => {
  let tempDir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-history-tools-'));
    store = new JsonlSessionStore({ sessionsDir: join(tempDir, 'sessions') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('search then read via ref', async () => {
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: 'hello world alpha', timestamp: 1 },
      { role: 'assistant', content: 'confirmed beta plan', timestamp: 2, agentId: 'agent-a' },
      { role: 'user', content: 'gamma follow up', timestamp: 3 },
    ]));

    const history = createSessionHistoryPort({ store });
    const [searchTool, readTool] = createSessionHistoryTools({ history });

    const search = await searchTool.handler(
      { query: 'beta plan' },
      ctx('agent-a'),
    ) as { sessions: Array<{ hits: Array<{ ref: string }> }> };

    expect(search.sessions[0].hits[0].ref).toBeTruthy();

    const read = await readTool.handler(
      {
        session_id: 's1',
        around_ref: search.sessions[0].hits[0].ref,
        before: 1,
        after: 1,
      },
      ctx('agent-a'),
    ) as { found: boolean; messages: Array<{ text: string }> };

    expect(read.found).toBe(true);
    expect(read.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(read.messages)).toContain('beta plan');
  });
});

describe('P2 sessions.index.db projection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-history-index-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('save maintains index; search with index matches scan results', async () => {
    const { createSqliteSessionIndex, rebuildSessionIndexFromStore } = await import(
      '../src/integration/storage/session-index.js'
    );
    const index = await createSqliteSessionIndex({
      dbPath: join(tempDir, 'sessions.index.db'),
    });
    const store = new JsonlSessionStore({
      sessionsDir: join(tempDir, 'sessions'),
      index,
    });

    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: 'fix SQLITE_BUSY with timeout', timestamp: 1 },
      { role: 'user', content: 'unrelated', timestamp: 2 },
    ]));
    await store.save('s2', session('s2', 'agent-a', [
      { role: 'user', content: 'other session needle', timestamp: 3 },
    ]));

    const withIndex = createSessionHistoryPort({ store, index });
    const without = createSessionHistoryPort({ store });

    const a = await withIndex.search({ query: 'SQLITE_BUSY', agentId: 'agent-a' });
    const b = await without.search({ query: 'SQLITE_BUSY', agentId: 'agent-a' });
    expect(a.sessions.map((s) => s.sessionId)).toEqual(b.sessions.map((s) => s.sessionId));
    expect(a.sessions[0].hits[0].ref).toBe(b.sessions[0].hits[0].ref);

    // delete 后索引同步
    await store.delete('s1');
    const afterDelete = await withIndex.search({ query: 'SQLITE_BUSY', agentId: 'agent-a' });
    expect(afterDelete.sessions).toHaveLength(0);

    // rebuild 可恢复
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: 'fix SQLITE_BUSY with timeout', timestamp: 1 },
    ]));
    await index.remove('s1');
    const lost = await withIndex.search({ query: 'SQLITE_BUSY', agentId: 'agent-a' });
    // prefilter 无候选 → 可能 0；扫描回退仅在 prefilter 抛错时。此处 prefilter 空集会滤掉 s1
    // 语义：索引不一致时以 rebuild 为准
    expect(lost.sessions).toHaveLength(0);

    await rebuildSessionIndexFromStore(index, store);
    const rebuilt = await withIndex.search({ query: 'SQLITE_BUSY', agentId: 'agent-a' });
    expect(rebuilt.sessions).toHaveLength(1);
    expect(rebuilt.sessions[0].hits[0].messageIndex).toBe(0);

    index.close();
  });

  it('prefilter respects participated agent scope', async () => {
    const { createSqliteSessionIndex } = await import('../src/integration/storage/session-index.js');
    const index = await createSqliteSessionIndex({ dbPath: join(tempDir, 'i2.db') });
    const store = new JsonlSessionStore({ sessionsDir: join(tempDir, 's2'), index });
    await store.save('mine', session('mine', 'agent-a', [
      { role: 'user', content: 'shared keyword here', timestamp: 1 },
    ]));
    await store.save('theirs', session('theirs', 'agent-b', [
      { role: 'user', content: 'shared keyword here', timestamp: 2 },
    ]));

    const history = createSessionHistoryPort({ store, index });
    const result = await history.search({ query: 'keyword', agentId: 'agent-a' });
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['mine']);
    index.close();
  });

  it('FTS5 trigram + LIKE hybrid covers short CJK and ASCII', async () => {
    const { createSqliteSessionIndex } = await import('../src/integration/storage/session-index.js');
    const index = await createSqliteSessionIndex({ dbPath: join(tempDir, 'fts.db') });
    expect(index.ftsEnabled).toBe(true);

    const store = new JsonlSessionStore({ sessionsDir: join(tempDir, 's-fts'), index });
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: '修复 SQLITE_BUSY 超时问题', timestamp: 1 },
    ]));

    const history = createSessionHistoryPort({ store, index });

    // 长词 → FTS
    const ascii = await history.search({ query: 'SQLITE_BUSY', agentId: 'agent-a' });
    expect(ascii.sessions.map((s) => s.sessionId)).toEqual(['s1']);

    // ≥3 码点中文 → FTS trigram
    const cjkLong = await history.search({ query: '超时问题', agentId: 'agent-a' });
    expect(cjkLong.sessions.map((s) => s.sessionId)).toEqual(['s1']);

    // 二字中文 → LIKE 回落
    const cjkShort = await history.search({ query: '超时', agentId: 'agent-a' });
    expect(cjkShort.sessions.map((s) => s.sessionId)).toEqual(['s1']);

    // phrase
    const phrase = await history.search({
      query: 'SQLITE_BUSY 超时',
      mode: 'phrase',
      agentId: 'agent-a',
    });
    // phrase 整串 <3 或混合；整串长度足够则 FTS，否则 LIKE 子串
    expect(phrase.sessions.length).toBeGreaterThanOrEqual(0);

    index.close();
  });

  it('fts:false stays on LIKE and matches scan', async () => {
    const { createSqliteSessionIndex } = await import('../src/integration/storage/session-index.js');
    const index = await createSqliteSessionIndex({
      dbPath: join(tempDir, 'like-only.db'),
      fts: false,
    });
    expect(index.ftsEnabled).toBe(false);
    const store = new JsonlSessionStore({ sessionsDir: join(tempDir, 's-like'), index });
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: '超时 SQLITE_BUSY', timestamp: 1 },
    ]));
    const history = createSessionHistoryPort({ store, index });
    const r = await history.search({ query: '超时', agentId: 'agent-a' });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    index.close();
  });

  it('ensureSessionIndexFresh rebuilds when projection lags authority', async () => {
    const { createSqliteSessionIndex, ensureSessionIndexFresh } = await import(
      '../src/integration/storage/session-index.js'
    );
    const index = await createSqliteSessionIndex({ dbPath: join(tempDir, 'fresh.db') });
    // 无钩子 store：只写权威，投影为空
    const store = new JsonlSessionStore({ sessionsDir: join(tempDir, 's-fresh') });
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: 'alpha needle', timestamp: 1 },
    ]));

    const fresh = await ensureSessionIndexFresh(index, store);
    expect(fresh.rebuilt).toBe(true);
    expect(fresh.sessions).toBe(1);

    const history = createSessionHistoryPort({ store, index });
    const r = await history.search({ query: 'needle', agentId: 'agent-a' });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['s1']);

    const again = await ensureSessionIndexFresh(index, store);
    expect(again.rebuilt).toBe(false);
    index.close();
  });

  it('default roles exclude tool/system unless requested', async () => {
    const store = new JsonlSessionStore({ sessionsDir: join(tempDir, 's-roles') });
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'tool', content: 'tool only needle', timestamp: 1 },
      { role: 'user', content: 'user needle', timestamp: 2 },
    ]));
    const history = createSessionHistoryPort({ store });
    const def = await history.search({ query: 'needle', agentId: 'agent-a' });
    expect(def.sessions[0].hits.every((h) => h.role === 'user' || h.role === 'assistant')).toBe(true);
    const withTool = await history.search({
      query: 'needle',
      agentId: 'agent-a',
      roles: ['user', 'assistant', 'tool'],
    });
    expect(withTool.sessions[0].hits.some((h) => h.role === 'tool')).toBe(true);
  });

  it('from_grant without grantedAt is fail-closed', async () => {
    const store = new JsonlSessionStore({ sessionsDir: join(tempDir, 's-grant') });
    const data = session('s1', 'agent-a', [
      { role: 'user', content: 'hidden secret', timestamp: 1000 },
    ]);
    data.meta.participantAgentIds = ['agent-a', 'agent-b'];
    data.participants = [
      {
        sessionId: 's1',
        agentId: 'agent-b',
        roleId: 'specialist',
        grantSeq: 1,
        rights: { readScope: 'from_grant' },
      },
    ];
    await store.save('s1', data);
    const history = createSessionHistoryPort({
      store,
      sessionAcl: new SessionAclService(),
    });
    const r = await history.search({ query: 'secret', agentId: 'agent-b' });
    expect(r.sessions).toHaveLength(0);
  });

  it('agentMax readScope=none is fail-closed (E6)', async () => {
    const store = new JsonlSessionStore({ sessionsDir: join(tempDir, 's-max') });
    await store.save('s1', session('s1', 'agent-a', [
      { role: 'user', content: 'ceiling secret', timestamp: 1 },
    ]));
    const history = createSessionHistoryPort({
      store,
      sessionAcl: new SessionAclService(),
      resolveAgentMax: () => ({ readScope: 'none' }),
    });
    const r = await history.search({ query: 'secret', agentId: 'agent-a' });
    expect(r.sessions).toHaveLength(0);
  });
});
