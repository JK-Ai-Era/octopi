/**
 * session-index 增量 upsert 回归（性能修复：save 时全删全插 → 增量追加）
 *
 * 对照组纪律：每条断言都对比「增量路径」与「全量重建路径」的 prefilter 结果，
 * 且用真 SqliteSessionIndex + 真 JsonlSessionStore round-trip（换新实例重读）。
 *
 * 口径（本次行为变更）：transient 消息（knowledgeGrounding / sessionAttachment）
 * 不进索引；msg_index = 持久序列下标（非 session.messages 全文下标）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSessionIndex } from '@octopi-agent/engine/integration/storage/session-index.js';
import type { SessionIndexBackend } from '@octopi-agent/engine/integration/storage/session-index.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { Message } from '@octopi-agent/core/types.js';

function msg(role: Message['role'], content: string, source?: string): Message {
  return {
    role,
    content,
    timestamp: Date.now(),
    ...(source ? { metadata: { source } as Message['metadata'] } : {}),
  };
}

function makeSession(messages: Message[]): SessionData {
  return {
    id: 'sess-idx-1',
    agentId: 'default',
    primaryAgentId: 'default',
    meta: {
      id: 'sess-idx-1',
      agentId: 'default',
      channelId: 'web',
      peerId: 'test',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages,
    turns: [],
    metadata: {},
    tasks: [],
  };
}

describe('session-index incremental upsert', () => {
  let dir: string;
  let index: SessionIndexBackend;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-sess-idx-'));
    index = await createSqliteSessionIndex({
      dbPath: join(dir, 'index.db'),
    });
    store = new JsonlSessionStore({ sessionsDir: dir, index });
  });

  afterEach(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** prefilter 命中的 sessionId 集合（对照组核心口径） */
  async function hitSessions(term: string): Promise<string[]> {
    const cands = await index.prefilter({ terms: [term], mode: 'keyword' });
    return (cands ?? []).map((c) => c.sessionId).sort();
  }

  /** 增量结果 vs 全量重建结果对照 */
  async function assertSameAsRebuild(term: string): Promise<void> {
    const incremental = await hitSessions(term);
    await index.rebuildFrom(async function* () {
      const data = await store.load('sess-idx-1');
      if (data) yield data;
    });
    const rebuilt = await hitSessions(term);
    expect(incremental).toEqual(rebuilt);
  }

  it('append-only saves index new messages incrementally and match full rebuild', async () => {
    await store.save(
      'sess-idx-1',
      makeSession([msg('user', 'alpha_unique_token one')]),
    );
    expect(await hitSessions('alpha_unique_token')).toEqual(['sess-idx-1']);

    // 追加第二条（含新词条）：增量路径应索引新消息
    await store.save(
      'sess-idx-1',
      makeSession([
        msg('user', 'alpha_unique_token one'),
        msg('assistant', 'beta_unique_token reply'),
      ]),
    );
    expect(await hitSessions('beta_unique_token')).toEqual(['sess-idx-1']);
    await assertSameAsRebuild('alpha_unique_token');
    await assertSameAsRebuild('beta_unique_token');
  });

  it('excludes transient grounding/attachment blocks from the index', async () => {
    await store.save(
      'sess-idx-1',
      makeSession([
        msg('user', 'alpha_unique_token question'),
        msg('user', 'gamma_unique_token grounding text', 'knowledgeGrounding'),
      ]),
    );
    // transient 词条不进索引
    expect(await hitSessions('gamma_unique_token')).toEqual([]);
    expect(await hitSessions('alpha_unique_token')).toEqual(['sess-idx-1']);
    await assertSameAsRebuild('gamma_unique_token');
  });

  it('falls back to full rebuild when messages are truncated (edit-resend)', async () => {
    await store.save(
      'sess-idx-1',
      makeSession([
        msg('user', 'alpha_unique_token one'),
        msg('assistant', 'beta_unique_token two'),
        msg('user', 'delta_unique_token three'),
      ]),
    );
    expect(await hitSessions('delta_unique_token')).toEqual(['sess-idx-1']);

    // edit-resend：尾部截断到只剩第一条
    await store.save('sess-idx-1', makeSession([msg('user', 'alpha_unique_token one')]));
    // 被截内容不得残留命中
    expect(await hitSessions('delta_unique_token')).toEqual([]);
    expect(await hitSessions('beta_unique_token')).toEqual([]);
    expect(await hitSessions('alpha_unique_token')).toEqual(['sess-idx-1']);
    await assertSameAsRebuild('delta_unique_token');
  });

  it('falls back to full rebuild when the tail fingerprint changes (truncate N append M)', async () => {
    await store.save(
      'sess-idx-1',
      makeSession([
        msg('user', 'alpha_unique_token one'),
        msg('assistant', 'beta_unique_token two'),
        msg('user', 'delta_unique_token three'),
      ]),
    );

    // 截 2 追 2：总长回到 >= 前值，但尾已换 → 必须全量重建，新内容可见
    await store.save(
      'sess-idx-1',
      makeSession([
        msg('user', 'alpha_unique_token one'),
        msg('user', 'epsilon_unique_token four'),
        msg('assistant', 'zeta_unique_token five'),
      ]),
    );
    expect(await hitSessions('zeta_unique_token')).toEqual(['sess-idx-1']);
    expect(await hitSessions('epsilon_unique_token')).toEqual(['sess-idx-1']);
    // 被截掉的旧内容不得残留
    expect(await hitSessions('delta_unique_token')).toEqual([]);
    expect(await hitSessions('beta_unique_token')).toEqual([]);
    await assertSameAsRebuild('zeta_unique_token');
  });

  it('stripping transient between saves keeps the append fast path correct', async () => {
    // 模拟 runner 每轮剥旧插新：旧 grounding 消失 + 新消息追加
    await store.save(
      'sess-idx-1',
      makeSession([
        msg('user', 'alpha_unique_token one'),
        msg('user', 'gamma_unique_token old grounding', 'knowledgeGrounding'),
      ]),
    );
    await store.save(
      'sess-idx-1',
      makeSession([
        msg('user', 'alpha_unique_token one'),
        msg('assistant', 'beta_unique_token reply'),
      ]),
    );
    expect(await hitSessions('beta_unique_token')).toEqual(['sess-idx-1']);
    expect(await hitSessions('gamma_unique_token')).toEqual([]);
    await assertSameAsRebuild('beta_unique_token');
    await assertSameAsRebuild('gamma_unique_token');
  });

  it('append fast path does not rewrite previously indexed rows (probe)', async () => {
    // 白盒探针：纯追加 save 必须走增量路径（不 DELETE 旧行）。
    // 若实现退化成"每次全量"，其余正确性用例仍会绿，性能收益却已丢失——本例专门钉住这一点。
    await store.save(
      'sess-idx-1',
      makeSession([msg('user', 'alpha_unique_token one')]),
    );
    // 探针：篡改已索引行；增量路径不触碰旧行 → 篡改应残留
    (index as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare(`UPDATE messages SET text = 'tampered_probe' WHERE session_id = ? AND msg_index = 0`)
      .run('sess-idx-1');

    await store.save(
      'sess-idx-1',
      makeSession([
        msg('user', 'alpha_unique_token one'),
        msg('assistant', 'beta_unique_token reply'),
      ]),
    );

    const rows = (index as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => Array<{ text: string }> } } })
      .db.prepare(`SELECT text FROM messages WHERE session_id = ? AND msg_index = 0`)
      .all('sess-idx-1');
    expect(rows.some((r) => r.text === 'tampered_probe')).toBe(true);
  });
});
