/**
 * search 兜底匹配语义（B+）——2–3 字符纯 ASCII 词走词边界（防跨词字母碰撞 be ⊂ obeswy）；
 * ≥4 字符与非 ASCII（CJK/韩/西里尔/混合）走子串（长词保留子词召回 assembly → contextAssembly）。
 * 双通道同断言：FTS 命中短路路径与 FTS 零命中兜底路径行为一致（兜底自身语义由「FTS 清空」组钉死）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { buildFtsTokens } from '@octopi-agent/engine/harness/knowledge/fts.js';
import type { KnowledgeSourceId } from '@octopi-agent/engine/harness/knowledge/types.js';
import type { KnowledgeChunkDraft } from '@octopi-agent/engine/harness/knowledge/adapters.js';

const SRC = 'src_match' as KnowledgeSourceId;

function chunk(text: string, path: string, ordinal = 0): KnowledgeChunkDraft {
  return {
    ordinal,
    text,
    startLine: ordinal * 2 + 1,
    endLine: ordinal * 2 + 2,
    ftsToks: buildFtsTokens(text, path),
  };
}

for (const channel of ['FTS 可用', 'FTS 清空（纯兜底）'] as const) {
  describe(`search 匹配语义（B+）— ${channel}`, () => {
    const dbs: KnowledgeDatabase[] = [];

    afterEach(() => {
      for (const db of dbs.splice(0)) {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }
    });

    /** 单文件入库；「FTS 清空」通道剥离倒排，强制走兜底块 */
    async function seed(path: string, texts: string[]): Promise<KnowledgeIndexStore> {
      const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
      dbs.push(db);
      const index = new KnowledgeIndexStore(db);
      await index.upsertFile(
        {
          sourceId: SRC,
          path,
          contentHash: `hash-${path}`,
          size: 100,
          mtime: 1,
          adapterId: 'markdown',
          chunks: texts.map((t, i) => chunk(t, path, i)),
        },
        {},
      );
      if (channel.startsWith('FTS 清空')) {
        db.raw.exec('DELETE FROM knowledge_chunks_fts');
      }
      return index;
    }

    it('短词不跨词碰撞：be 不命中 obeswy 路径（历史 flaky 场景）', async () => {
      const index = await seed('/tmp/octopi-kn-integrity-obeswy/docs/keep.md', ['stay searchable']);
      expect(index.search('be', { sourceIds: [SRC] })).toHaveLength(0);
      expect(index.search('should be pruned', { sourceIds: [SRC] })).toHaveLength(0);
    });

    it('短词词边界命中：be 作为整词出现', async () => {
      const index = await seed('/tmp/docs/note.md', ['should be careful']);
      expect(index.search('be', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
      expect(index.search('should be', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
    });

    it('3 字符阈值：api 命中独立词 api，不命中 rapid/apis（词内子串）', async () => {
      const hit = await seed('/tmp/docs/hit.md', ['the api docs']);
      expect(hit.search('api', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
      const miss = await seed('/tmp/docs/rapid.md', ['rapid progress with apis']);
      expect(miss.search('api', { sourceIds: [SRC] })).toHaveLength(0);
    });

    it('4 字符阈值两侧：cat 不命中 concatenate（边界）；test 仍命中 contest（≥4 子串，刻意取舍）', async () => {
      const cat = await seed('/tmp/docs/strings.md', ['concatenate strings']);
      expect(cat.search('cat', { sourceIds: [SRC] })).toHaveLength(0);
      const contest = await seed('/tmp/docs/contest.md', ['contest results']);
      expect(contest.search('test', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
    });

    it('长词子串召回保留：assembly 命中 contextAssembly', async () => {
      const index = await seed('/tmp/docs/use.ts', ['call contextAssembly to build']);
      expect(index.search('assembly', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
    });

    it('文件名词匹配保留：readme 命中 README.md 路径', async () => {
      const index = await seed('/docs/README.md', ['unrelated body text']);
      expect(index.search('readme', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
    });

    it('下划线是边界：id 命中 get_user_id.md（与 unicode61 切 _ 一致）', async () => {
      const index = await seed('/code/get_user_id.md', ['unrelated body text']);
      expect(index.search('id', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
    });

    it('CJK 子串语义保留：二元组/整段/跨段都命中，无关查询零命中', async () => {
      const index = await seed('/知识库/上下文装配.md', ['上下文装配指南：把之前会话做的事说清楚']);
      expect(index.search('上下', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
      expect(index.search('上下文', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
      expect(index.search('装配指南', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
      expect(index.search('会话做的事', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
      expect(index.search('完全无关', { sourceIds: [SRC] })).toHaveLength(0);
    });

    it('混合脚本：bar 命中 foo文bar（CJK 作边界是有意放宽）；词内 oo 不命中', async () => {
      const index = await seed('/tmp/docs/mix.md', ['foo文bar tail']);
      expect(index.search('bar', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
      expect(index.search('oo', { sourceIds: [SRC] })).toHaveLength(0);
    });

    it('非 ASCII 字母显式走子串语义（决策固化）：да 命中 нада、국어 命中 한국어', async () => {
      const ru = await seed('/tmp/docs/ru.md', ['нада что-то сделать']);
      expect(ru.search('да', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
      const ko = await seed('/tmp/docs/ko.md', ['한국어 문서']);
      expect(ko.search('국어', { sourceIds: [SRC] }).length).toBeGreaterThan(0);
    });
  });
}
