/**
 * Skill 索引进默认装配 + 压缩摘要 Session 持久化
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';
import { createDefaultSystemPromptAssembler } from '@octopi-agent/engine/harness/context/system-prompt-assembler.js';
import { DefaultSkillManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/manager.js';
import type { ModelProvider, LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { SessionStore } from '@octopi-agent/core/interfaces/session-store.js';

function mockProvider(captureSystem?: (system: string) => void): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat(req) {
      const sys = req?.messages?.find((m) => m.role === 'system');
      if (captureSystem && sys) captureSystem(String(sys.content ?? ''));
      return { content: '## Summary\nrestored-or-new', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() { return true; },
    getModelInfo() {
      return { name: 'm', contextWindow: 8000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 8000 }];
    },
  };
}

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('Skill 索引进 system prompt', () => {
  function makeSkills(): string {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-skills-'));
    const skillPath = join(dir, 'demo-skill');
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(
      join(skillPath, 'SKILL.md'),
      `---\nname: demo-skill\ndescription: Demo skill for tests\n---\n\n# Demo\n`,
      'utf-8',
    );
    return dir;
  }

  it('createDefaultSystemPromptAssembler 注入 available_skills', async () => {
    const skillDir = makeSkills();
    try {
      const mgr = new DefaultSkillManager(skillDir);
      await mgr.discover(skillDir);
      const asm = createDefaultSystemPromptAssembler({
        getSkillPromptText: () => mgr.formatForPrompt(),
      });
      const result = await asm.assemble({
        sessionId: 's',
        messages: [],
        persona: 'You are test.',
        contextWindow: 32000,
      });
      expect(result.systemPrompt).toContain('<available_skills>');
      expect(result.systemPrompt).toContain('demo-skill');
      expect(result.manifest?.layers.find((l) => l.id === 'skill')?.included).toBe(true);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('builder.skillDirectory 装配后 system 含 skill 索引', async () => {
    const skillDir = makeSkills();
    try {
      let llmSystem = '';
      const provider = mockProvider((system) => {
        llmSystem = system;
      });
      const { runner } = await new AgentBuilder()
        .model(provider)
        .skillDirectory(skillDir)
        .build();

      for await (const event of runner.handle('s-skill', userMsg('hello'), { systemPrompt: '' })) {
        if (event.type === 'engine.end' || event.type === 'engine.error') break;
      }

      // I1：断言 Run 送入 LLM 的 system（装配产物），而非共享 agent.context
      expect(llmSystem).toContain('<available_skills>');
      expect(llmSystem).toContain('demo-skill');
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });
});

describe('压缩摘要 Session 持久化', () => {
  it('assemble 返回 summary 并可经转换记录账本恢复（进程重启）', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      transformStore: store,
    });
    const summarize = async (_m: LLMMessage[]) => '## Conversation Summary\npersist-me';
    const msgs: Message[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(userMsg('x'.repeat(400)));
    }

    const first = await engine.assemble({
      sessionId: 's-persist',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    expect(first.summary).toContain('persist-me');
    const ledger = await store.load('s-persist', '');
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]!.type).toBe('summary');
    expect(ledger.records[0]!.meta.messageCount).toBe(30);

    // 新引擎实例（模拟进程重启）：同一账本恢复覆盖 + 摘要
    const engine2 = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
      transformStore: store,
    });
    let summarizeCalls = 0;
    const countingSummarize = async (m: LLMMessage[]) => {
      summarizeCalls += 1;
      return '## Conversation Summary\npersist-me';
    };
    const second = await engine2.assemble({
      sessionId: 's-persist',
      // 仅 +1 条：应走复用（fold），不再打 LLM
      messages: [...msgs, userMsg('tiny')],
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize: countingSummarize,
    });
    expect(second.summary).toContain('persist-me');
    expect(summarizeCalls).toBe(0);
  });

  it('多轮压缩：count 只在完成的压缩轮推进，复用（fold）不产新记录', async () => {
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 20, // minNewForResummarize = max(3, 5) = 5
      proactiveCooldownMs: 0, // 本用例验证多轮 LLM 摘要，关闭冷却
      transformStore: store,
    });
    let summarizeCalls = 0;
    const summarize = async (_m: LLMMessage[]) => {
      summarizeCalls += 1;
      return `## Conversation Summary\nv${summarizeCalls}`;
    };

    const base: Message[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(userMsg(`m${i} ` + 'x'.repeat(400)));
    }

    // 第 1 次 LLM 摘要
    const r1 = await engine.assemble({
      sessionId: 's-multi',
      messages: base,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    expect(summarizeCalls).toBe(1);
    const after1 = await store.load('s-multi', '');
    // 换代：count/推进语义只认 summary 记录（overflow degrade 是同轮机械兜底副产物，不计入）
    const summaries1 = after1.records.filter((r) => r.type === 'summary');
    expect(summaries1).toHaveLength(1);
    // 补强「filter 吸收多余记录」批评：伴生 degrade（overflow）必须合法——
    // covers 不得与 summary 记录区间重叠（同区间双覆盖=fold 语义混乱的信号）
    const all1 = (await store.load('s-multi', '')).records;
    const sum = all1.find((r) => r.type === 'summary')!;
    for (const d of all1.filter((r) => r.type === 'degrade')) {
      for (const dr of d.covers) {
        for (const sr of sum.covers) {
          const overlap = (dr.from.indexHint) <= (sr.to.indexHint) && (sr.from.indexHint) <= (dr.to.indexHint);
          expect(overlap, `degrade covers [${dr.from.indexHint},${dr.to.indexHint}] 不得与 summary [${sr.from.indexHint},${sr.to.indexHint}] 重叠`).toBe(false);
        }
      }
    }
    expect(summaries1[0]!.meta.messageCount).toBe(30);
    expect(r1.summary).toContain('v1');

    // 连续 4 次复用（每轮 +1）：不应再打 LLM，也不产新记录（count 基数保持 30）
    let msgs = base;
    for (let i = 0; i < 4; i++) {
      msgs = [...msgs, userMsg(`t${i}`)];
      const r = await engine.assemble({
        sessionId: 's-multi',
        messages: msgs,
        systemPrompt: 'sys',
        tools: [],
        tokenBudget: 4000,
        summarize,
      });
      expect(summarizeCalls).toBe(1);
      expect((await store.load('s-multi', '')).records.filter((rr) => rr.type === 'summary')).toHaveLength(1);
      expect(r.summary).toContain('v1');
    }

    // 防摘要风暴（新红线）：视图超线但**无新增消息**（fold 视图天然粘滞）→
    // 重压只会原样复述上一份交接书——零 LLM 复用
    await engine.assemble({
      sessionId: 's-multi',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    expect(summarizeCalls).toBe(1);

    // 溢出 tail 窗口（+25 条）：新消息进 middle → 再摘要 v2，summary 记录推进到 2
    for (let i = 0; i < 25; i++) msgs = [...msgs, userMsg(`deep-${i} ` + 'x'.repeat(400))];
    const r2 = await engine.assemble({
      sessionId: 's-multi',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    expect(summarizeCalls).toBe(2);
    const after2 = await store.load('s-multi', '');
    const summaries2 = after2.records.filter((r) => r.type === 'summary');
    expect(summaries2).toHaveLength(2);
    expect(r2.summary).toContain('v2');

    // 模拟进程重启：同一账本恢复（增长门基数 35 从记录 meta 恢复）
    const engine2 = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 20,
      proactiveCooldownMs: 0,
      transformStore: store,
    });
    let restartCalls = 0;
    const r3 = await engine2.assemble({
      sessionId: 's-multi',
      messages: [...msgs, userMsg('after-restart')],
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize: async () => {
        restartCalls += 1;
        return '## should-not-fire';
      },
    });
    // +1 条 → 复用（fold），不打 LLM、不产新记录
    expect(restartCalls).toBe(0);
    expect(r3.summary).toContain('v2');
    // 重启后 summary 记录计数不变（degrade 为同轮机械兜底副产物，不计入）
    expect((await store.load('s-multi', '')).records.filter((rr) => rr.type === 'summary')).toHaveLength(2);
  });

  it('Agent 桥：legacy 快照播种（迁移输入）在 convertToLlm 后不被改写', async () => {
    const provider = mockProvider();
    const sessions = new Map<string, SessionData>();
    const store: SessionStore<SessionData> = {
      async load(sessionId) {
        return sessions.get(sessionId) ?? null;
      },
      async save(sessionId, data) {
        sessions.set(sessionId, JSON.parse(JSON.stringify(data)) as SessionData);
      },
      async delete(sessionId) {
        sessions.delete(sessionId);
      },
      async list(filter) {
        return [...sessions.values()]
          .filter((s) => !filter?.agentId || s.agentId === filter.agentId)
          .map((s) => s.meta);
      },
      async exists(sessionId) {
        return sessions.has(sessionId);
      },
    };

    // 预置带摘要的 session
    sessions.set('s1', {
      id: 's1',
      agentId: 'default',
      meta: {
        id: 's1',
        agentId: 'default',
        channelId: 'test',
        peerId: 'p1',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastInteractionAt: Date.now(),
        sessionStartedAt: Date.now(),
      },
      messages: [],
      steps: [],
      metadata: {},
      contextCompact: {
        summary: '## Conversation Summary\nfrom-disk',
        lastProactiveMessageCount: 2,
        lastProactiveTokens: 100,
      },
    });

    const builder = new AgentBuilder().model(provider).store(store);
    const { agent } = await builder.buildAgent();
    agent.setContextSessionId('s1');
    agent.setSessionCompactState('s1', 'default', {
      summary: '## Conversation Summary\nfrom-disk',
      lastProactiveMessageCount: 2,
      lastProactiveTokens: 100,
    });

    const llm = await agent.config.convertToLlm!([userMsg('hi')]);
    expect(llm.length).toBeGreaterThan(0);
    expect(agent.getSessionCompactState('s1', 'default')?.summary).toContain('from-disk');
    expect(agent.getSessionCompactState('s1', 'default')?.lastProactiveMessageCount).toBe(2);
  });
});
