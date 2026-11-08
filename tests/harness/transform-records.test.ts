/**
 * 转换记录：锚点 / fold / 存储 / 迁移 单元测试（step-4 持久转换记录）
 *
 * 覆盖：内容锚点（同形消歧 / ephemeral 修剪 / 孤儿解析）、fold 确定性与
 * 重叠合成、JsonlTransformStore 往返（blob 水合 / revoke / 损坏行 / blob 丢失）、
 * legacy 快照迁移等价性。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@octopi-agent/core/types.js';
import {
  anchorFor,
  anchorRange,
  canonicalMessageHash,
  resolveAnchor,
  resolveRun,
} from '@octopi-agent/engine/harness/context/transform/anchors.js';
import { foldTransformView } from '@octopi-agent/engine/harness/context/transform/fold.js';
import { legacySnapshotToRecords } from '@octopi-agent/engine/harness/context/transform/migrate.js';
import type {
  NewTransformRecord,
  TransformLedger,
  TransformRecord,
} from '@octopi-agent/engine/harness/context/transform/types.js';
import {
  JsonlTransformStore,
  InMemoryTransformStore,
  resolveSessionTransformPaths,
  copySessionTransformDir,
  scanOrphanSessionTransform,
} from '@octopi-agent/engine/harness/session/transform-store.js';
import { asSummaryMessage } from '@octopi-agent/engine/harness/context/capabilities/compact/messages.js';

function userMsg(text: string, timestamp = 1000): Message {
  return { role: 'user', content: text, timestamp };
}

function makeRecord(partial: Partial<TransformRecord> & { covers: TransformRecord['covers'] }): TransformRecord {
  return {
    seq: 1,
    sessionId: 's',
    agentId: '',
    type: 'summary',
    createdAt: 1,
    text: 'SUMMARY-TEXT',
    placeholder: { role: 'user', source: 'contextSummary' },
    revoked: false,
    meta: { reason: 'manual', fresh: true, summarizeAttempted: true, messageCount: 0 },
    ...partial,
  };
}

describe('锚点（内容 hash 坐标）', () => {
  it('hash 对同内容稳定、对内容变化敏感', () => {
    const a = userMsg('same', 1);
    const b = userMsg('same', 1);
    const c = userMsg('other', 1);
    expect(canonicalMessageHash(a)).toBe(canonicalMessageHash(b));
    expect(canonicalMessageHash(a)).not.toBe(canonicalMessageHash(c));
  });

  it('同形消息按 occurrence 消歧（流序解析）', () => {
    const dup = userMsg('dup');
    const messages = [dup, userMsg('x'), { ...dup }, userMsg('y'), { ...dup }];
    const second = anchorFor(messages, 2);
    expect(second.occurrence).toBe(1);
    expect(resolveAnchor(messages, second)).toBe(2);
    const third = anchorFor(messages, 4);
    expect(resolveAnchor(messages, third)).toBe(4);
  });

  it('indexHint 失配时按 hash 慢扫描恢复', () => {
    const messages = [userMsg('a', 1), userMsg('b', 2), userMsg('c', 3)];
    const anchor = anchorFor(messages, 2);
    // 模拟下标漂移：数组前面插入一条
    const shifted = [userMsg('z', 0), ...messages];
    expect(resolveAnchor(shifted, anchor)).toBe(3);
  });

  it('ephemeral 消息不锚定：区间边界向内收缩', () => {
    const messages: Message[] = [
      userMsg('a', 1),
      { ...userMsg('e1', 2), ephemeral: true },
      userMsg('b', 3),
    ];
    const run = anchorRange(messages, 0, 2);
    // 边界 a..b（e1 被修剪出边界）
    expect(run).toBeDefined();
    const resolved = resolveRun(messages, run!);
    expect(resolved).toEqual([0, 2]);
    // 重启后 ephemeral 消失：锚点仍解析到 a..b
    const persisted = [messages[0]!, messages[2]!];
    expect(resolveRun(persisted, run!)).toEqual([0, 1]);
  });

  it('孤儿锚（消息不复存在）解析为 undefined', () => {
    const messages = [userMsg('a', 1), userMsg('b', 2)];
    const anchor = anchorFor(messages, 1);
    expect(resolveAnchor([userMsg('a', 1)], anchor)).toBeUndefined();
  });
});

describe('fold（确定性应用）', () => {
  it('同 (messages, ledger) 恒等同视图；未覆盖消息逐字在场', () => {
    const messages = Array.from({ length: 6 }, (_, i) => userMsg(`m${i}`, i + 1));
    const record = makeRecord({
      covers: [anchorRange(messages, 1, 3)!],
      text: 'THE-SUMMARY',
    });
    const ledger: TransformLedger = { records: [record] };
    const f1 = foldTransformView(messages, ledger, {});
    const f2 = foldTransformView(messages, ledger, {});
    expect(f1.view.map((m) => m.content)).toEqual(f2.view.map((m) => m.content));
    const contents = f1.view.map((m) => String(m.content));
    expect(contents[0]).toContain('m0');
    expect(contents.some((c) => c.includes('THE-SUMMARY'))).toBe(true);
    expect(contents.some((c) => c.includes('m4'))).toBe(true);
    // 被覆盖原文不得回流
    expect(contents.some((c) => c.includes('m2'))).toBe(false);
  });

  it('later-seq 覆盖重叠区间（溢出重叠合成），残段仍归旧记录', () => {
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}`, i + 1));
    const r1 = makeRecord({ seq: 1, covers: [anchorRange(messages, 1, 5)!], text: 'OLD' });
    const r2 = makeRecord({ seq: 2, covers: [anchorRange(messages, 3, 6)!], text: 'NEW' });
    const folded = foldTransformView(messages, { records: [r1, r2] }, {});
    const contents = folded.view.map((m) => String(m.content));
    // r2 赢得 [3,6]；r1 残段 [1,2] 仍渲染 OLD
    expect(contents.some((c) => c.includes('OLD'))).toBe(true);
    expect(contents.some((c) => c.includes('NEW'))).toBe(true);
    expect(contents.some((c) => c.includes('m2'))).toBe(false);
    expect(contents.some((c) => c.includes('m4'))).toBe(false);
  });

  it('revoked 记录不生效（显式撤销是唯一回填通道）', () => {
    const messages = Array.from({ length: 4 }, (_, i) => userMsg(`m${i}`, i + 1));
    const record = makeRecord({ covers: [anchorRange(messages, 0, 2)!], revoked: true });
    const folded = foldTransformView(messages, { records: [record] }, {});
    expect(folded.view.map((m) => String(m.content)).some((c) => c.includes('m1'))).toBe(true);
  });

  it('孤儿记录跳过 + 上报（原文可见是降级方向）', () => {
    const messages = [userMsg('a', 1), userMsg('b', 2), userMsg('c', 3)];
    const ghost = [userMsg('gone', 9)];
    const record = makeRecord({ covers: [anchorRange(ghost, 0, 0)!] });
    const orphans: TransformRecord[] = [];
    const folded = foldTransformView(messages, { records: [record] }, { onOrphan: (r) => orphans.push(r) });
    expect(orphans).toHaveLength(1);
    expect(folded.view).toHaveLength(3);
  });

  it('summary 占位带 [Coverage] 行且文本不烘进 blob（F11 动态渲染）', () => {
    const messages = Array.from({ length: 4 }, (_, i) => userMsg(`m${i}`, i + 1));
    const record = makeRecord({ covers: [anchorRange(messages, 0, 2)!], text: 'BODY' });
    const folded = foldTransformView(messages, { records: [record] }, {});
    const placeholder = folded.view[0]!;
    expect(String(placeholder.content)).toContain('BODY');
    expect(String(placeholder.content)).toContain('[Coverage] This handoff covers the conversation up to message 3');
    // 记录 text 本身不含覆盖行
    expect(record.text).not.toContain('[Coverage]');
  });

  it('degrade 占位按原形状渲染（不包 summary 标记）', () => {
    const messages = Array.from({ length: 4 }, (_, i) => userMsg(`m${i}`, i + 1));
    const record = makeRecord({
      type: 'degrade',
      covers: [anchorRange(messages, 0, 1)!],
      text: '[Context truncated: 2 messages]',
      placeholder: { role: 'user', source: 'contextLedger' },
    });
    const folded = foldTransformView(messages, { records: [record] }, {});
    const placeholder = folded.view[0]!;
    expect(String(placeholder.content)).toBe('[Context truncated: 2 messages]');
    expect(placeholder.metadata?.source).toBe('contextLedger');
    // 与 asSummaryMessage 不同形：无 [Conversation Summary] 标记
    expect(String(placeholder.content)).not.toContain('[Conversation Summary]');
  });
});

describe('JsonlTransformStore（与 undo 同基座）', () => {
  it('append/load 往返：blob 水合 + per-agent 分文件 + revoke 附加行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-tr-'));
    try {
      const store = new JsonlTransformStore({ sessionsDir: dir });
      const messages = Array.from({ length: 4 }, (_, i) => userMsg(`m${i}`, i + 1));
      const rec: NewTransformRecord = {
        sessionId: 's1',
        agentId: 'a1',
        type: 'summary',
        createdAt: 1,
        covers: [anchorRange(messages, 0, 2)!],
        text: 'HELLO-BLOB',
        placeholder: { role: 'user', source: 'contextSummary' },
        meta: { reason: 'manual', fresh: true, summarizeAttempted: true, messageCount: 4 },
      };
      const [persisted] = await store.append('s1', 'a1', [rec]);
      expect(persisted.seq).toBe(1);
      // blob 落盘为内容寻址文件
      const { blobsDir, root } = resolveSessionTransformPaths(dir, 's1');
      const blobFiles = readFileSync(join(root, 'a1.jsonl'), 'utf8');
      expect(blobFiles).toContain('sha256:');
      expect(readFileSync(join(blobsDir, persisted.blobRef!.replace(/^sha256:/, '')), 'utf8')).toBe('HELLO-BLOB');

      const loaded = await store.load('s1', 'a1');
      expect(loaded.records).toHaveLength(1);
      expect(loaded.records[0]!.text).toBe('HELLO-BLOB');
      // a2 桶为空（per-agent 分账）
      expect((await store.load('s1', 'a2')).records).toHaveLength(0);

      // revoke：显式撤销落附加行
      await store.append('s1', 'a1', [], [1]);
      const afterRevoke = await store.load('s1', 'a1');
      expect(afterRevoke.records[0]!.revoked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏行跳过、blob 丢失记录不生效且如实告警（降级方向：原文可见）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-tr2-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = new JsonlTransformStore({ sessionsDir: dir });
      const messages = Array.from({ length: 4 }, (_, i) => userMsg(`m${i}`, i + 1));
      const rec: NewTransformRecord = {
        sessionId: 's1',
        agentId: '',
        type: 'summary',
        createdAt: 1,
        covers: [anchorRange(messages, 0, 2)!],
        text: 'KEEP-ME',
        placeholder: { role: 'user', source: 'contextSummary' },
        meta: { reason: 'manual', fresh: true, summarizeAttempted: true, messageCount: 4 },
      };
      const [p1] = await store.append('s1', '', [rec]);
      await store.append('s1', '', [{ ...rec, text: 'SECOND' }]);
      const { root, blobsDir } = resolveSessionTransformPaths(dir, 's1');
      const file = join(root, '_.jsonl');
      // 撕裂尾行 + 移走第二个 blob
      writeFileSync(file, `${readFileSync(file, 'utf8')}{"kind":"record","record":{"seq":9\n`, 'utf8');
      rmSync(join(blobsDir, (await store.load('s1', '')).records[1]?.blobRef?.replace(/^sha256:/, '') ?? 'x'));
      const loaded = await store.load('s1', '');
      expect(loaded.records.map((r) => r.text)).toEqual(['KEEP-ME']);
      expect(loaded.records[0]!.seq).toBe(p1.seq);
      // F7：丢弃不得静默——必须有诊断输出
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('blob'));
      // F7：行在 blob 全丢 ≠ 空账本（迁移幂等门）
      expect(loaded.hadEntries).toBe(true);
    } finally {
      warnSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy 快照迁移', () => {
  it('迁移视图与旧粘滞视图等价（head + summary + [coverEnd..tailStart) + tail）', () => {
    const messages = Array.from({ length: 20 }, (_, i) => userMsg(`m${i}`, i + 1));
    const coverEnd = 12;
    const records = legacySnapshotToRecords({
      sessionId: 's',
      agentId: '',
      snapshot: {
        summary: 'LEGACY-SUM',
        lastProactiveMessageCount: 20,
        lastProactiveCoverEnd: coverEnd,
        lastProactiveTokens: 100,
      },
      messages,
      protectFirstN: 2,
      protectLastN: 4,
    });
    expect(records).toHaveLength(1);
    expect(records![0]!.type).toBe('summary');
    expect(records![0]!.meta.messageCount).toBe(20);
    const ledger: TransformLedger = {
      records: [{ ...records![0]!, seq: 1, blobRef: undefined, revoked: false }],
    };
    const folded = foldTransformView(messages, ledger, {});
    const contents = folded.view.map((m) => String(m.content));

    // 旧粘滞视图形状：head(m0,m1) + summary + 增量(m12..m15) + tail(m16..m19)
    expect(contents[0]).toContain('m0');
    expect(contents[1]).toContain('m1');
    expect(contents[2]).toContain('LEGACY-SUM');
    // 覆盖行 = 动态渲染，终点 = coverEnd
    expect(contents[2]).toContain(`up to message ${coverEnd}`);
    for (const i of [12, 13, 14, 15, 16, 17, 18, 19]) {
      expect(contents.some((c) => c.includes(`m${i}`))).toBe(true);
    }
    for (const i of [2, 5, 11]) {
      expect(contents.some((c) => c.includes(`m${i}`))).toBe(false);
    }
  });

  it('快照缺 coverEnd：不虚报覆盖（covers 空），计数基数随记录迁移', () => {
    const messages = Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`, i + 1));
    const records = legacySnapshotToRecords({
      sessionId: 's',
      agentId: '',
      snapshot: { summary: 'S', lastProactiveMessageCount: 7 },
      messages,
      protectFirstN: 2,
      protectLastN: 4,
    });
    expect(records).toHaveLength(1);
    expect(records![0]!.covers).toHaveLength(0);
    expect(records![0]!.meta.messageCount).toBe(7);
  });

  it('空快照不产记录', () => {
    expect(
      legacySnapshotToRecords({
        sessionId: 's',
        agentId: '',
        snapshot: {},
        messages: [userMsg('a')],
        protectFirstN: 2,
        protectLastN: 4,
      }),
    ).toBeUndefined();
  });
});

describe('InMemoryTransformStore', () => {
  it('append/load/revoke 语义与持久存储一致', async () => {
    const store = new InMemoryTransformStore();
    const messages = [userMsg('a', 1), userMsg('b', 2)];
    const rec: NewTransformRecord = {
      sessionId: 's',
      agentId: 'a',
      type: 'degrade',
      createdAt: 1,
      covers: [anchorRange(messages, 0, 0)!],
      text: '[Context truncated: 1]',
      placeholder: { role: 'user', source: 'contextLedger' },
      meta: { reason: 'overflow', fresh: false, summarizeAttempted: false, messageCount: 2 },
    };
    const [p] = await store.append('s', 'a', [rec]);
    expect((await store.load('s', 'a')).records[0]!.text).toBe('[Context truncated: 1]');
    await store.append('s', 'a', [], [p.seq]);
    expect((await store.load('s', 'a')).records[0]!.revoked).toBe(true);
    expect((await store.load('s', 'b')).records).toHaveLength(0);
  });
});

describe('asSummaryMessage 单源（fold 复用同一包装）', () => {
  it('fold 占位与 asSummaryMessage 同形（标记 + 覆盖行）', () => {
    const legacy = asSummaryMessage('BODY', 3);
    const messages = Array.from({ length: 4 }, (_, i) => userMsg(`m${i}`, i + 1));
    const record = makeRecord({ covers: [anchorRange(messages, 0, 2)!], text: 'BODY' });
    const folded = foldTransformView(messages, { records: [record] }, {});
    expect(String(folded.view[0]!.content)).toBe(String(legacy.content));
  });
});

describe('fork 复制与孤儿扫描（F6/F12）', () => {
  it('copySessionTransformDir 复制账本+blob；源缺失返回 false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-tr3-'));
    try {
      const store = new JsonlTransformStore({ sessionsDir: dir });
      const messages = Array.from({ length: 4 }, (_, i) => userMsg(`m${i}`, i + 1));
      await store.append('src', 'a', [
        {
          sessionId: 'src',
          agentId: 'a',
          type: 'summary',
          createdAt: 1,
          covers: [anchorRange(messages, 0, 2)!],
          text: 'FORK-LEDGER',
          placeholder: { role: 'user', source: 'contextSummary' },
          meta: { reason: 'manual', fresh: true, summarizeAttempted: true, messageCount: 4 },
        },
      ]);

      expect(await copySessionTransformDir(dir, 'src', 'dst')).toBe(true);
      const copied = await store.load('dst', 'a');
      expect(copied.records).toHaveLength(1);
      expect(copied.records[0]!.text).toBe('FORK-LEDGER');
      // 源缺失：false（降级路径=快照迁移，不是静默成功）
      expect(await copySessionTransformDir(dir, 'nope', 'dst2')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scanOrphanSessionTransform 只报会话已删的账本（账本常驻≠孤儿）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-tr4-'));
    try {
      const store = new JsonlTransformStore({ sessionsDir: dir });
      const messages = [userMsg('a', 1), userMsg('b', 2)];
      await store.append('alive', 'a', [
        {
          sessionId: 'alive',
          agentId: 'a',
          type: 'degrade',
          createdAt: 1,
          covers: [anchorRange(messages, 0, 0)!],
          text: '[Context truncated: 1 earlier entries replaced by a tool-call ledger to fit context window]',
          placeholder: { role: 'user', source: 'contextLedger' },
          meta: { reason: 'overflow', fresh: false, summarizeAttempted: false, messageCount: 2 },
        },
      ]);
      await store.append('dead', 'a', [
        {
          sessionId: 'dead',
          agentId: 'a',
          type: 'degrade',
          createdAt: 1,
          covers: [anchorRange(messages, 0, 0)!],
          text: 'x',
          placeholder: { role: 'user', source: 'contextLedger' },
          meta: { reason: 'overflow', fresh: false, summarizeAttempted: false, messageCount: 2 },
        },
      ]);
      // alive 有会话文件；dead 没有（已删除）
      writeFileSync(join(dir, 'alive.jsonl'), '{"x":1}\n', 'utf8');

      const orphans = await scanOrphanSessionTransform(dir);
      expect(orphans.map((o) => o.sessionDirName)).toEqual(['dead']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
