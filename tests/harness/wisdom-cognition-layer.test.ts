/**
 * Wisdom / Cognition 接入默认 Assembler + preview
 */

import { describe, it, expect } from 'vitest';
import { createDefaultSystemPromptAssembler } from '@octopi-agent/engine/harness/context/system-prompt-assembler.js';
import { DefaultContextAssembler, truncateTextToTokens } from '@octopi-agent/engine/harness/context/assembler.js';
import { WisdomLayer, CognitionLayer } from '@octopi-agent/engine/harness/context/layers.js';
import type { LayerAssembleContext } from '@octopi-agent/engine/harness/context/layer-types.js';
import type { WisdomInjectPick } from '@octopi-agent/engine/harness/memory/types.js';
import { InMemoryConceptGraph } from '@octopi-agent/engine/harness/memory/cognition.js';
import { InMemoryWisdomStore } from '@octopi-agent/engine/harness/memory/wisdom.js';
import type { Message } from '@octopi-agent/core/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

async function seedWisdom(store: InMemoryWisdomStore, statement: string) {
  return store.admit({
    statement,
    scenario: { problemTypes: ['验证型宣称'], signals: ['证据'] },
    effect: { posture: '先证伪', questions: ['证据在哪里？'] },
    derivedFrom: { memoryIds: ['m1', 'm2'] },
    kind: 'corrective',
    origin: 'factory',
    initialStatus: 'active',
  });
}

describe('Wisdom/Cognition 层接入默认 Assembler', () => {
  it('WisdomStore 有条目时注入 # 思维框架', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    await seedWisdom(wisdomStore, '先核对契约，再改实现');

    const asm = createDefaultSystemPromptAssembler({ wisdomStore });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('怎么改七层模型')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    // E8：Wisdom 属易变快照，进 runtimeSnapshot 而非 system prompt
    expect(result.runtimeSnapshot).toContain('思维框架');
    expect(result.runtimeSnapshot).toContain('先核对契约');
    expect(result.systemPrompt).not.toContain('思维框架');
    const wisdom = result.manifest?.layers.find((l) => l.id === 'wisdom');
    expect(wisdom?.included).toBe(true);
  });

  it('CognitionStore 有相关概念时注入 # 相关概念', async () => {
    const graph = new InMemoryConceptGraph();
    const a = await graph.admitConcept({
      name: 'ContextLayer',
      kind: 'construct',
      description: '七层契约',
      supportCount: 2,
    });
    const b = await graph.admitConcept({
      name: 'Assembler',
      kind: 'construct',
      description: '装配器',
      supportCount: 2,
    });
    await graph.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'part_of',
      strength: 0.9,
      description: 'layer feeds assembler',
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: 'layer feeds assembler',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: 'layer feeds assembler',
    });
    await graph.promote([a.id!, b.id!], 'active');

    const asm = createDefaultSystemPromptAssembler({ cognitionStore: graph });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('ContextLayer 和 Assembler 什么关系')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    expect(result.runtimeSnapshot).toContain('相关概念');
    const cognition = result.manifest?.layers.find((l) => l.id === 'cognition');
    expect(cognition?.included).toBe(true);
  });

  it('关系释义渲染单行化 + 上限截断（m1：换行不得伪造注入行）', async () => {
    const graph = new InMemoryConceptGraph();
    const a = await graph.admitConcept({ name: 'Alpha', kind: 'construct', supportCount: 2 });
    const b = await graph.admitConcept({ name: 'Beta', kind: 'construct', supportCount: 2 });
    await graph.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'part_of',
      strength: 0.9,
      description: '第一行\n- injected: looks like a layer line\n第三行 ' + 'x'.repeat(500),
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: 'alpha part of beta',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: 'alpha part of beta',
    });

    const asm = createDefaultSystemPromptAssembler({ cognitionStore: graph });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('Alpha 和 Beta 什么关系')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    // 释义出现在渲染中，但换行被压成空格——不得伪造独立行（行首注入）
    expect(result.runtimeSnapshot).toContain('第一行');
    expect(result.runtimeSnapshot).not.toMatch(/\n\s*- injected/);
    expect(result.runtimeSnapshot).not.toMatch(/第一行\n/);
    // 超长释义截到 200 字符以内（单行原子）
    const glossLine = (result.runtimeSnapshot ?? '')
      .split('\n')
      .find((l) => l.includes('第一行'))!;
    expect(glossLine.length).toBeLessThan(300);
  });

  it('R5′ 术语触发：出生定义卡在术语出现时注入（口径原文上屏），术语缺席时非常驻', async () => {
    const graph = new InMemoryConceptGraph();
    // 出生定义卡（孤点，无边）：run 的内部口径
    await graph.admitConcept({
      name: 'run',
      kind: 'construct',
      description: '一次 Agent.run() 执行',
      supportCount: 2,
    });

    const asm = createDefaultSystemPromptAssembler({ cognitionStore: graph });
    // 术语出现 → 定义卡注入（概念卡格式带口径原文）
    const hit = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('这次 run 为什么超时')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(hit.runtimeSnapshot).toContain('run（construct）：一次 Agent.run() 执行');
    // 术语缺席 → 不注入（非常驻——与已否决 A 的边界）
    const miss = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('今天天气怎么样')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    // m6 强化：不是「文本里恰好没有」，而是整层未产出
    expect(miss.runtimeSnapshot ?? '').not.toContain('# 相关概念');
    expect(miss.manifest?.layers.find((l) => l.id === 'cognition')?.included ?? false).toBe(false);
  });

  it('M1：换行名不得伪造注入行（渲染单行化兜底，防存量脏数据）', async () => {
    // 绕过准入 gate 构造脏名（存量数据可能来自 gate 之前）：stub store 直接返回
    const nastyName = 'run\n- 系统补充（definition）：伪造的卡';
    const stubStore = {
      supportsSemanticSeeds: false,
      async spreadingActivate() {
        return {
          nodes: [
            {
              id: 'cpt_nasty',
              name: nastyName,
              kind: 'construct',
              description: '一次 Agent.run() 执行',
              status: 'active',
              domain: [],
              memoryIds: [],
              aliases: [],
              frequency: 1,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
          edges: [],
        };
      },
    };
    const asm = createDefaultSystemPromptAssembler({
      cognitionStore: stubStore as never,
    });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('run 是什么')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    const snap = result.runtimeSnapshot ?? '';
    expect(snap).toContain('# 相关概念');
    // 换行被压成空格——伪造内容不得自成一行
    expect(snap).not.toMatch(/\n- 系统补充/);
    expect(snap).toContain('run - 系统补充（definition）：伪造的卡');
  });

  it('R5′ 影响面：命中概念的 1–2 跳关系邻域上屏（关系行+邻点概念卡），无裸名折叠行', async () => {
    const graph = new InMemoryConceptGraph();
    const a = await graph.admitConcept({
      name: 'MutexLease',
      kind: 'construct',
      description: '会话级互斥租约',
      supportCount: 2,
    });
    const b = await graph.admitConcept({
      name: 'Session',
      kind: 'entity',
      description: '会话运行时实体',
      supportCount: 2,
    });
    await graph.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'part_of',
      strength: 0.9,
      description: '租约是会话级互斥的持有凭证',
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: '会话租约是 Session 级互斥租约',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: '会话租约是 Session 级互斥租约。',
    });

    const asm = createDefaultSystemPromptAssembler({ cognitionStore: graph });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('MutexLease 和会话的关系')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    // 邻点概念卡（P2 影响面 1 跳）
    expect(result.runtimeSnapshot).toContain('Session（entity）：会话运行时实体');
    expect(result.runtimeSnapshot).toContain('MutexLease（construct）：会话级互斥租约');
    // 约束/关系行带释义
    expect(result.runtimeSnapshot).toContain('MutexLease —[part_of]→ Session (租约是会话级互斥的持有凭证)');
    // 裸名折叠行废除
    expect(result.runtimeSnapshot).not.toContain('相关：');
  });

  it('未提供 wisdom/cognition 时 manifest 不出现这两层', async () => {
    const asm = createDefaultSystemPromptAssembler({});
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('hello')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    const ids = (result.manifest?.layers ?? []).map((l) => l.id);
    expect(ids).not.toContain('wisdom');
    expect(ids).not.toContain('cognition');
  });

  it('蒸馏出生的 trial 场景命中注入并记 applied；无命中走 trial 轮转保底曝光', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    const admitted = await wisdomStore.admit({
      statement: '蒸馏出的范式必须能被试用，否则永远无法挣得信任',
      scenario: { problemTypes: ['验证型宣称', '范围裁剪'], signals: ['证据'] },
      effect: { posture: '先证伪', questions: ['证据在哪里？'] },
      derivedFrom: { memoryIds: ['m1', 'm2'] },
      kind: 'corrective',
      origin: 'distilled',
    });
    expect(admitted.action).toBe('created');
    const entry = await wisdomStore.get(admitted.id!);
    expect(entry?.status).toBe('trial');

    const asm = createDefaultSystemPromptAssembler({ wisdomStore });

    // 场景匹配命中：注入 turn 快照并记 applied
    const hit = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('这是验证型宣称的处理')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(hit.runtimeSnapshot ?? '').toContain('蒸馏出的范式必须能被试用');
    expect((await wisdomStore.get(admitted.id!))?.outcomes.applied).toBe(1);

    // 无场景命中：trial 进不了 core，但由 trial 轮转桶保底曝光（打破晋升死锁）——
    // 轮转注入带 [试用] 标记，且不计 applied（applied 语义=场景命中被使用；
    // 曝光入账会稀释 contestRate、废掉 zero-apply 淘汰）
    const miss = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('今天天气不错')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(miss.runtimeSnapshot ?? '').toContain('[试用]');
    expect(miss.runtimeSnapshot ?? '').toContain('蒸馏出的范式必须能被试用');
    expect(miss.manifest?.layers.find((l) => l.id === 'wisdom')?.included ?? false).toBe(true);
    expect((await wisdomStore.get(admitted.id!))?.outcomes.applied).toBe(1);
  });

  it('wisdomIncludeTrial:false 时 trial 条目不注入（wisdom.injection.trialVisible 语义）', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    const admitted = await wisdomStore.admit({
      statement: '关闭 trial 可见性后这条范式不应出现',
      scenario: { problemTypes: ['验证型宣称'] },
      effect: { posture: '先证伪' },
      derivedFrom: { memoryIds: ['m1', 'm2'] },
      kind: 'corrective',
      origin: 'distilled',
    });
    const asm = createDefaultSystemPromptAssembler({ wisdomStore, wisdomIncludeTrial: false });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('这是验证型宣称的处理')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(result.runtimeSnapshot ?? '').not.toContain('关闭 trial 可见性后这条范式不应出现');
  });
});

describe('CognitionLayer R6 装箱（M4 单分量降级路径）', () => {
  it('M4 降级路径：单分量（单种子主形态）不退化全有/全无——行级兜底 + 诚实标注', async () => {
    const graph = new InMemoryConceptGraph();
    // 单一连通分量：A—B—C 链（单种子查询的生产主形态）
    const a = await graph.admitConcept({ name: 'Alpha', kind: 'construct', description: '甲组件', supportCount: 2 });
    const b = await graph.admitConcept({ name: 'Beta', kind: 'construct', description: '乙组件', supportCount: 2 });
    const c = await graph.admitConcept({ name: 'Gamma', kind: 'construct', description: '丙组件', supportCount: 2 });
    const edge = {
      relationType: 'part_of' as const,
      strength: 0.9,
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: 'part of',
        evidenceClass: 'mereonymy' as const,
        licensedAt: Date.now(),
      },
      evidenceText: 'part of',
    };
    await graph.admitEdge({ ...edge, sourceId: a.id!, targetId: b.id! });
    await graph.admitEdge({ ...edge, sourceId: b.id!, targetId: c.id! });

    const layer = new CognitionLayer({ store: graph });
    // 紧预算：装得下 1-2 行，装不下整组（整组 ~90 tokens）
    const out = await layer.assemble({
      sessionId: 's',
      messages: [],
      query: 'Alpha',
      tokenBudget: 55,
      systemBudget: 500,
    } satisfies LayerAssembleContext);
    // 不是全无（旧组原子会整层 empty）：部分行上屏 + 诚实标注
    expect(out).not.toBeNull();
    expect(out!.text).toContain('# 相关概念');
    expect(out!.text).toMatch(/（已省略 \d+ 个概念 \/ \d+ 条关系）/);
    // 每行完整
    for (const line of out!.text.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('#') || line.startsWith('（')) continue;
      expect(line.startsWith('- ')).toBe(true);
    }
    // manifest 与 in-band 一致
    expect(out!.dropped).toMatch(/已省略 \d+ 个概念 \/ \d+ 条关系/);
  });
});

describe('装配兜底截断行级原子（B1 根修）', () => {
  const estimator = { estimateText: (t: string) => t.length };

  it('整行前缀装箱：永不切半行 + in-band 标注 + dropped 记账（严格 ≤ maxTokens）', () => {
    const text = '第一行内容\n第二行内容\n第三行内容\n第四行内容';
    const cut = truncateTextToTokens(text, 22, estimator);
    // 只装得下前缀整行（+标注预留）——无半行
    for (const line of cut.text.split('\n')) {
      expect(line === '' || text.includes(line) || line.startsWith('（装配截断')).toBe(true);
    }
    expect(cut.text).toContain('（装配截断：已省略尾部');
    expect(cut.dropped).toContain('omitted');
    // 预算严格：总额（含标注）≤ maxTokens（标注预留机制保证）
    expect(estimator.estimateText(cut.text)).toBeLessThanOrEqual(22);
  });

  it('单行超预算：不切半、整体弃 + 诚实记账（严格预算优先）', () => {
    const text = '唯一一行但特别特别长的内容超过预算';
    const cut = truncateTextToTokens(text, 5, estimator);
    // 永不切半：要么整行，要么整体弃（残片不出现）
    expect(cut.text).toBe('');
    expect(cut.dropped).toContain('no complete line fits');
  });

  it('完全装不下（零预算）→ 空 + 记账', () => {
    const cut = truncateTextToTokens('内容', 0, estimator);
    expect(cut.text).toBe('');
    expect(cut.dropped).toBe('zero budget');
  });
});

describe('includeLayerContent / preview', () => {
  it('默认写入 content 与 preview', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    await seedWisdom(wisdomStore, 'layer content should appear for UI click-through');

    const asm = createDefaultSystemPromptAssembler({ wisdomStore });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('debug layers')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    const wisdom = result.manifest?.layers.find((l) => l.id === 'wisdom');
    expect(wisdom?.content).toContain('layer content should appear');
    expect(wisdom?.preview).toBeTruthy();
  });

  it('关闭 includeLayerContent 后 content 为 undefined', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    await seedWisdom(wisdomStore, 'should not leak full content when disabled');
    const assembler = new DefaultContextAssembler({
      includeLayerContent: false,
      includeLayerPreview: false,
    });
    const asm = createDefaultSystemPromptAssembler({ wisdomStore, assembler });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('x')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    const wisdom = result.manifest?.layers.find((l) => l.id === 'wisdom');
    expect(wisdom?.content).toBeUndefined();
    expect(wisdom?.preview).toBeUndefined();
  });
});

describe('WisdomLayer applied 记账', () => {
  it('被 truncate 裁掉的条目不记 applied / 不报 sources', async () => {
    const mk = (id: string, ch: string) => ({
      entry: {
        id,
        statement: ch.repeat(50),
        scenario: { problemTypes: ['t'] },
        effect: {},
      },
      bucket: 'core' as const,
    });
    const applied: string[][] = [];
    const layer = new WisdomLayer({
      // 截断记账测试的最小假对象：非完整 WisdomEntry，断言与字段无关
      select: async () => [mk('w1', '一'), mk('w2', '二')] as unknown as WisdomInjectPick[],
      onInjected: (ids) => {
        applied.push(ids);
      },
    });
    // maxChars = max(80, 75*2) = 150：脚注(居顶)+分组头+第一条(约 125 字符)完整保留，第二条被裁掉
    const out = await layer.assemble({
      sessionId: 's',
      messages: [],
      query: 'x',
      tokenBudget: 75,
      systemBudget: 50,
    } satisfies LayerAssembleContext);
    expect(out).not.toBeNull();
    expect(applied).toEqual([['w1']]);
    expect(out!.sources).toContain('w1');
    expect(out!.sources).not.toContain('w2');
    expect(out!.dropped).toBeTruthy();
  });
});

describe('CognitionLayer R6 行级装箱截断', () => {
  /** 两组连通子图：组1 = Alpha—Beta（含强边），组2 = Gamma—Delta（含强边） */
  async function buildTwoGroupStore() {
    const graph = new InMemoryConceptGraph();
    const alpha = await graph.admitConcept({ name: 'Alpha', kind: 'construct', description: '甲组件', supportCount: 2 });
    const beta = await graph.admitConcept({ name: 'Beta', kind: 'construct', description: '乙组件', supportCount: 2 });
    const gamma = await graph.admitConcept({ name: 'Gamma', kind: 'construct', description: '丙组件', supportCount: 2 });
    const delta = await graph.admitConcept({ name: 'Delta', kind: 'construct', description: '丁组件', supportCount: 2 });
    const edge = {
      relationType: 'part_of' as const,
      strength: 0.9,
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: 'part of',
        evidenceClass: 'mereonymy' as const,
        licensedAt: Date.now(),
      },
      evidenceText: 'part of',
    };
    await graph.admitEdge({ ...edge, sourceId: alpha.id!, targetId: beta.id!, description: '甲是乙的组成' });
    await graph.admitEdge({ ...edge, sourceId: gamma.id!, targetId: delta.id!, description: '丙是丁的组成' });
    return graph;
  }

  it('整行原子 + 尾部 in-band 标注省略数；关系行与卡片同组同进退', async () => {
    const graph = await buildTwoGroupStore();
    const layer = new CognitionLayer({ store: graph });
    // tokenBudget=55 → maxChars=110：放得下组 1（约 60 字），放不下组 2
    const out = await layer.assemble({
      sessionId: 's',
      messages: [],
      query: 'Alpha Beta Gamma Delta',
      tokenBudget: 55,
      systemBudget: 500,
    } satisfies LayerAssembleContext);
    expect(out).not.toBeNull();
    const text = out!.text;
    // 组 1 全进（卡片 + 关系行同进）
    expect(text).toContain('Alpha（construct）：甲组件');
    expect(text).toContain('Beta（construct）：乙组件');
    expect(text).toContain('Alpha —[part_of]→ Beta (甲是乙的组成)');
    // 组 2 全出（卡片 + 关系行同退）
    expect(text).not.toContain('Gamma');
    expect(text).not.toContain('Delta');
    // 尾部 in-band 标注省略数
    expect(text).toContain('（已省略 2 个概念 / 1 条关系）');
    // manifest 双记
    expect(out!.dropped).toBe('已省略 2 个概念 / 1 条关系');
    // 每行完整（结构检查：内容行均以 '- ' 起始，无半行残段）
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('#') || line.startsWith('（')) continue;
      expect(line.startsWith('- ')).toBe(true);
    }
  });

  it('零预算 → 层 empty（null，不产出残片）', async () => {
    const graph = await buildTwoGroupStore();
    const layer = new CognitionLayer({ store: graph });
    const out = await layer.assemble({
      sessionId: 's',
      messages: [],
      query: 'Alpha',
      tokenBudget: 0,
      systemBudget: 500,
    } satisfies LayerAssembleContext);
    expect(out).toBeNull();
  });

  it('单行超软顶保完整：孤点单行组不切半（首行例外准入）', async () => {
    const graph = new InMemoryConceptGraph();
    const longName = '超'.repeat(300);
    await graph.admitConcept({ name: longName, kind: 'construct', description: '超长孤点', supportCount: 2 });
    const layer = new CognitionLayer({ store: graph });
    const out = await layer.assemble({
      sessionId: 's',
      messages: [],
      query: '超长孤点',
      tokenBudget: 5,
      systemBudget: 100,
    } satisfies LayerAssembleContext);
    expect(out).not.toBeNull();
    // 行构造上限（name 120 + 省略号）后的整行完整进入——永不切半（截断只在字段构造层，行原子不受）
    const cappedName = `${'超'.repeat(120)}…`;
    expect(out!.text).toContain(`- ${cappedName}（construct）：超长孤点`);
    for (const line of out!.text.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('#') || line.startsWith('（')) continue;
      expect(line.startsWith('- ')).toBe(true);
    }
  });
});
