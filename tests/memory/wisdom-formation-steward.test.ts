/**
 * wisdom.steward.formation — 证据包去覆盖 / 库内范式清单 / supersedesId 取代闭环
 *
 * 回归锁（2026-11-01 修复）：已被存活范式 derivedFrom 覆盖的记忆不再进证据包
 * （同源语料反复炼制是重复条目的燃料）；证据包附库内已有范式清单供 LLM 去重；
 * LLM 可输出 supersedesId 取代旧范式而非新增同主题条目。
 */

import { describe, it, expect } from 'vitest';
import { InMemoryWisdomStore } from '@octopi-agent/engine/harness/memory/wisdom.js';
import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';
import type { SubsystemInput } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import type { SubsystemLLMPort } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/llm-port.js';
import { handler as formationHandler } from '@octopi-agent/engine/subsystems/wisdom-steward/formation/handler.js';

interface CapturedLLM {
  input: string;
  response: string;
}

function fakeLLM(response: string): { port: SubsystemLLMPort; captured: CapturedLLM } {
  const captured: CapturedLLM = { input: '', response };
  const port = {
    chat: async (req: { messages: Array<{ content: string }> }) => {
      captured.input = req.messages[0]?.content ?? '';
      return { content: captured.response, finishReason: 'stop' };
    },
  } as unknown as SubsystemLLMPort;
  return { port, captured };
}

function emptyLLM(): SubsystemLLMPort {
  return fakeLLM('{"items":[],"droppedNotes":["无合格范式"]}').port;
}

async function seedCluster(
  memoryStore: InMemoryMemoryStore,
  count: number,
  tag: string,
  contentPrefix: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      await memoryStore.store({
        type: 'method',
        content: `${contentPrefix} 第 ${i} 条命题内容`,
        source: 't',
        confidence: 0.8,
        importance: 0.5,
        tags: [tag],
      }),
    );
  }
  return ids;
}

describe('wisdom.steward.formation 证据包去重闭环', () => {
  it('已覆盖语料不进证据包；库内已有范式清单进提示（治本4+5）', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    const memoryStore = new InMemoryMemoryStore();
    const all = await seedCluster(memoryStore, 7, 'octopi', '上下文分层教训');
    // 存活范式已消化 m0/m1（剩余 5 条仍成簇触发）
    await wisdomStore.admit({
      statement: '内容按失效速度选存放层，易变的放可替换层',
      scenario: { problemTypes: ['上下文分层'] },
      effect: { posture: '先问失效速度' },
      derivedFrom: { memoryIds: [all[0], all[1]] },
      kind: 'generalize',
      origin: 'distilled',
    });

    const { port, captured } = fakeLLM('{"items":[],"droppedNotes":["暂无新范式"]}');
    const out = await formationHandler({} as SubsystemInput, {
      wisdomStore,
      memoryStore,
      llmPort: port,
      __subsystem_config__: {},
    });

    expect(out.act?.status).toBe('success');
    // 已覆盖的 m0/m1 不再出现在证据包（燃料切断）
    expect(captured.input).not.toContain('第 0 条命题内容');
    expect(captured.input).not.toContain('第 1 条命题内容');
    // 未覆盖语料仍在
    expect(captured.input).toContain('第 6 条命题内容');
    // 库内已有范式清单（statement + id）进提示，供 LLM 级语义去重
    expect(captured.input).toContain('库内已有范式');
    expect(captured.input).toContain('内容按失效速度选存放层');
  });

  it('全部语料已被覆盖 → no_trigger 不打 LLM（炼制节流）', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    const memoryStore = new InMemoryMemoryStore();
    const all = await seedCluster(memoryStore, 5, 'octopi', '交接规范教训');
    await wisdomStore.admit({
      statement: '交接产物只留开放项与决策指针',
      scenario: { problemTypes: ['会话交接'] },
      effect: { posture: '先清已完成项' },
      derivedFrom: { memoryIds: all },
      kind: 'selection',
      origin: 'distilled',
    });

    const out = await formationHandler({} as SubsystemInput, {
      wisdomStore,
      memoryStore,
      llmPort: emptyLLM(),
      __subsystem_config__: {},
    });

    expect(out.act?.status).toBe('success');
    const content = out.act?.messages?.[0]?.content ?? '';
    expect(content).toContain('formation.skipped');
    expect(content).toContain('reason=no_trigger');
  });

  it('contested/candidate 范式不锁语料（M6 回归：被质疑的证据要能炼出修正版）', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    const memoryStore = new InMemoryMemoryStore();
    const all = await seedCluster(memoryStore, 5, 'octopi', '争议教训');
    const w = await wisdomStore.admit({
      statement: '被质疑的范式陈述内容不应锁住其证据',
      scenario: { problemTypes: ['争议'] },
      effect: { posture: 'x' },
      derivedFrom: { memoryIds: all },
      kind: 'selection',
      origin: 'distilled',
    });
    await wisdomStore.update(w.id!, { status: 'contested' });

    const { port, captured } = fakeLLM('{"items":[],"droppedNotes":["暂无新范式"]}');
    const out = await formationHandler({} as SubsystemInput, {
      wisdomStore,
      memoryStore,
      llmPort: port,
      __subsystem_config__: {},
    });

    expect(out.act?.status).toBe('success');
    // 语料解锁：证据包重新可见（LLM 被调用且见到内容），而非 no_trigger
    expect(captured.input).toContain('第 0 条命题内容');
  });

  it('LLM 输出 supersedesId → 取代旧范式而非新增（真实覆盖语料组合，H3 回归）', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    const memoryStore = new InMemoryMemoryStore();
    const ids = await seedCluster(memoryStore, 7, 'octopi', '范围收敛教训');
    // 旧范式覆盖了真实种子 ids[0..1]（它们已被排除出证据包）
    const old = await wisdomStore.admit({
      statement: '拍板后锁定范围执行，未拍板部分留观察',
      scenario: { problemTypes: ['方案收敛'] },
      effect: { posture: '先锁范围' },
      derivedFrom: { memoryIds: [ids[0], ids[1]] },
      kind: 'corrective',
      origin: 'distilled',
    });

    // LLM 精炼旧范式：memoryIds 留空（源语料不在证据包里），由 admit 继承目标溯源
    const llmText = JSON.stringify({
      items: [
        {
          statement: '拍板后锁定范围执行，未拍板部分留作观察不扩杠杆',
          problemTypes: ['方案收敛'],
          signals: ['范围蔓延'],
          questions: ['在拍板圈内吗？'],
          posture: '先锁范围',
          memoryIds: [],
          kind: 'corrective',
          supersedesId: old.id,
        },
      ],
      droppedNotes: [],
    });
    const { port, captured } = fakeLLM(llmText);
    const out = await formationHandler({} as SubsystemInput, {
      wisdomStore,
      memoryStore,
      llmPort: port,
      __subsystem_config__: {},
    });

    expect(out.act?.status).toBe('success');
    // 提示里带了库内范式 id（LLM 需要知道可取代谁）
    expect(captured.input).toContain(old.id!);
    // 已覆盖的源语料不在证据包（燃料切断）
    expect(captured.input).not.toContain('第 0 条命题内容');
    expect(captured.input).not.toContain('第 1 条命题内容');
    const oldEntry = await wisdomStore.get(old.id!);
    expect(oldEntry?.status).toBe('superseded');
    expect(oldEntry?.supersededBy).toBeTruthy();
    const successor = await wisdomStore.get(oldEntry!.supersededBy!);
    expect(successor?.statement).toContain('未拍板部分留作观察');
    // 继承被取代者的溯源
    expect(successor?.derivedFrom.memoryIds).toEqual([ids[0], ids[1]]);
  });
});
