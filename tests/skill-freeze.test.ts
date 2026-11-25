/**
 * P2 测试：技能索引冻结 + 增量注入（缓存保护；设计 §7 / B0 / E8）
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  diffSkillIndex,
  renderSkillDelta,
  type FrozenSkillIndexStore,
  type FrozenSkillIndex,
} from '@octopi-agent/engine/harness/context/skill-freeze.js';
import { SkillLayer, SkillDeltaLayer } from '@octopi-agent/engine/harness/context/layers.js';
import { createDefaultSystemPromptAssembler } from '@octopi-agent/engine/harness/context/system-prompt-assembler.js';
import { FileFrozenSkillIndexStore } from '@octopi-agent/engine/integration/storage/frozen-skill-index.js';
import type { SkillIndexEntry } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/index-render.js';

function entry(id: string, description = `Does ${id}. Use when needed.`): SkillIndexEntry {
  return { id, name: id, description, filePath: `/skills/${id}/SKILL.md` };
}

// 内存 store（层测试用；文件 store 单独测）
function memoryStore(): FrozenSkillIndexStore & { map: Map<string, FrozenSkillIndex> } {
  const map = new Map<string, FrozenSkillIndex>();
  return {
    map,
    async load(sessionId) {
      return map.get(sessionId) ?? null;
    },
    async save(sessionId, index) {
      if (!map.has(sessionId)) map.set(sessionId, index); // write-once
    },
  };
}

const ctx = (sessionId = 's1') => ({
  sessionId,
  messages: [],
  query: 'q',
  tokenBudget: 4096,
  systemBudget: 8192,
});

describe('diffSkillIndex / renderSkillDelta', () => {
  test('added / updated / removed 分类', () => {
    const frozen = [entry('keep'), entry('gone'), entry('changed', 'old desc')];
    const current = [entry('keep'), entry('changed', 'new desc'), entry('fresh')];
    const diff = diffSkillIndex(frozen, current);
    expect(diff.added.map((e) => e.id)).toEqual(['fresh']);
    expect(diff.updated.map((e) => e.id)).toEqual(['changed']);
    expect(diff.removed.map((e) => e.id)).toEqual(['gone']);
  });

  test('无变化 → 三空', () => {
    const set = [entry('a'), entry('b')];
    const diff = diffSkillIndex(set, [...set]);
    expect(diff.added).toHaveLength(0);
    expect(diff.updated).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  test('renderSkillDelta 输出语义（removed 提示勿再用）', () => {
    const text = renderSkillDelta({ added: [entry('x')], updated: [], removed: [entry('y')] });
    expect(text).toContain('<skill-delta>');
    expect(text).toContain('<new_skills>');
    expect(text).toContain('<removed_skills>');
    expect(text).toContain('must NOT be used anymore');
    expect(text).toContain('SESSION-SCOPED OVERRIDE'); // P1-5 权威声明
    expect(text).toContain('<name>x</name>');
  });
});

describe('FileFrozenSkillIndexStore', () => {
  let dir: string;
  let store: FileFrozenSkillIndexStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frozen-skill-'));
    store = new FileFrozenSkillIndexStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('save → load roundtrip；write-once（后到不覆盖）', async () => {
    const first: FrozenSkillIndex = { entries: [entry('a')], text: 'FIRST', frozenAt: 1 };
    const second: FrozenSkillIndex = { entries: [entry('b')], text: 'SECOND', frozenAt: 2 };
    await store.save('sess-1', first);
    await store.save('sess-1', second); // write-once：保持先到者
    expect((await store.load('sess-1'))!.text).toBe('FIRST');
  });

  test('并发 save：link 原子 no-clobber，后到者不得覆盖先到者', async () => {
    const one: FrozenSkillIndex = { entries: [], text: 'ONE', frozenAt: 1 };
    const two: FrozenSkillIndex = { entries: [], text: 'TWO', frozenAt: 2 };
    await Promise.all([store.save('sess-race', one), store.save('sess-race', two)]);
    const loaded = await store.load('sess-race');
    expect(['ONE', 'TWO']).toContain(loaded!.text); // 必有一个赢家
    // 再次 save 不得改变赢家（write-once 稳定）
    await store.save('sess-race', { entries: [], text: 'THREE', frozenAt: 3 });
    expect((await store.load('sess-race'))!.text).toBe(loaded!.text);
  });

  test('无记录 / 损坏记录 → null 并自愈（坏文件删除可重写，P2-2）', async () => {
    expect(await store.load('nope')).toBeNull();
    mkdirSync(join(dir, 'bad'), { recursive: true });
    const corrupt = join(dir, 'bad', 'frozen-skill-index.json');
    writeFileSync(corrupt, '{broken json');
    expect(await store.load('bad')).toBeNull();
    expect(existsSync(corrupt)).toBe(false); // 坏文件已清（否则 write-once 门永久卡死）
    // 自愈后可正常冻结
    await store.save('bad', { entries: [], text: 'RECOVERED', frozenAt: 1 });
    expect((await store.load('bad'))!.text).toBe('RECOVERED');
  });

  test('落点在 session 附属目录（随归档搬迁的 <id>/ 目录）', async () => {
    await store.save('sess-2', { entries: [], text: '', frozenAt: 1 });
    expect(existsSync(join(dir, 'sess-2', 'frozen-skill-index.json'))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, 'sess-2', 'frozen-skill-index.json'), 'utf-8'));
    expect(raw.text).toBe('');
  });
});

describe('SkillLayer 冻结（system 份逐字节稳定）', () => {
  test('首轮冻结当时集；之后变化不改 system 份', async () => {
    const store = memoryStore();
    let entries = [entry('alpha')];
    const layer = new SkillLayer({
      getPromptText: () => 'LIVE',
      freeze: { store, getEntries: () => entries },
    });

    const first = await layer.assemble(ctx());
    expect(first!.text).toContain('alpha');

    // 会话中途技能变化（新增 beta）——system 份不变（缓存前缀稳定）
    entries = [entry('alpha'), entry('beta')];
    const second = await layer.assemble(ctx());
    expect(second!.text).toBe(first!.text);
    expect(second!.text).not.toContain('beta');
  });

  test('无 freeze 配置 = 历史行为（实时渲染 getPromptText）', async () => {
    const layer = new SkillLayer({ getPromptText: () => 'LIVE-TEXT' });
    const content = await layer.assemble(ctx());
    expect(content!.text).toBe('LIVE-TEXT');
  });

  test('冻结写入失败降级为实时渲染（能力不丢，P1-2）', async () => {
    const failing: FrozenSkillIndexStore = {
      async load() {
        return null;
      },
      async save() {
        throw new Error('ENOSPC');
      },
    };
    const layer = new SkillLayer({
      getPromptText: () => '',
      freeze: { store: failing, getEntries: () => [entry('survivor')] },
    });
    const content = await layer.assemble(ctx());
    expect(content!.text).toContain('survivor'); // 索引照常返回，不因持久失败消失
  });

  test('渲染字节等价：撇号走 &apos;（历史 manager 渲染一致，P2-1）', async () => {
    const store = memoryStore();
    const layer = new SkillLayer({
      getPromptText: () => '',
      freeze: {
        store,
        getEntries: () => [entry("apos", "It's a skill's description.")],
      },
    });
    const content = await layer.assemble(ctx());
    expect(content!.text).toContain('It&apos;s a skill&apos;s description.');
    expect(content!.text).not.toContain("It's");
  });
});

describe('SkillDeltaLayer（snapshot 增量份）', () => {
  test('首轮（未冻结）无 delta；无变化无 delta；有变化出 delta', async () => {
    const store = memoryStore();
    let entries = [entry('alpha')];
    const systemLayer = new SkillLayer({
      getPromptText: () => '',
      freeze: { store, getEntries: () => entries },
    });
    const deltaLayer = new SkillDeltaLayer({ store, getEntries: () => entries });

    // 首轮：system 冻结，delta 为空
    expect(await deltaLayer.assemble(ctx())).toBeNull();
    await systemLayer.assemble(ctx());

    // 无变化：delta 为空
    expect(await deltaLayer.assemble(ctx())).toBeNull();

    // 中途新增：delta 出现（进快照，不动 system）
    entries = [entry('alpha'), entry('beta')];
    const delta = await deltaLayer.assemble(ctx());
    expect(delta!.text).toContain('<skill-delta>');
    expect(delta!.text).toContain('beta');
    expect(delta!.text).not.toContain('alpha</name>'); // 未变技能不进 delta
  });
});

describe('双组集成（system 冻结 + runtimeSnapshot 增量）', () => {
  test('assembler：技能变化进 runtimeSnapshot 而非 systemPrompt', async () => {
    const store = memoryStore();
    let entries = [entry('alpha', 'Alpha skill. Use when alpha needed.')];
    const assembler = createDefaultSystemPromptAssembler({
      getSkillPromptText: () => '<available_skills>live</available_skills>',
      getSkillEntries: () => entries,
      frozenSkillStore: store,
      constitutionText: '',
    });
    const input = {
      sessionId: 'sess-dual',
      persona: 'P',
      messages: [],
      contextWindow: 32000,
    };

    // 第一轮：冻结 alpha；无 delta
    const r1 = await assembler.assemble(input);
    expect(r1.systemPrompt).toContain('alpha');
    expect(r1.runtimeSnapshot ?? '').not.toContain('skill-delta');

    // 中途新增 beta：system 逐字节不变，delta 进快照
    entries = [entry('alpha', 'Alpha skill. Use when alpha needed.'), entry('beta', 'Beta skill. Use when beta needed.')];
    const r2 = await assembler.assemble(input);
    expect(r2.systemPrompt).toBe(r1.systemPrompt); // 缓存前缀稳定（B0 核心断言）
    expect(r2.runtimeSnapshot ?? '').toContain('skill-delta');
    expect(r2.runtimeSnapshot ?? '').toContain('beta');
  });

  test('新会话转正：新 sessionId 冻结当时全量，delta 归零', async () => {
    const store = memoryStore();
    let entries = [entry('alpha'), entry('beta')];
    const assembler = createDefaultSystemPromptAssembler({
      getSkillPromptText: () => '',
      getSkillEntries: () => entries,
      frozenSkillStore: store,
      constitutionText: '',
    });
    // 新会话直接冻结 alpha+beta 全量，无 delta
    const r = await assembler.assemble({
      sessionId: 'sess-new',
      persona: 'P',
      messages: [],
      contextWindow: 32000,
    });
    expect(r.systemPrompt).toContain('alpha');
    expect(r.systemPrompt).toContain('beta');
    expect(r.runtimeSnapshot ?? '').not.toContain('skill-delta');
  });
});
