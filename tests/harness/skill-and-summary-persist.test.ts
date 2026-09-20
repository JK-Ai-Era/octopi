/**
 * Skill 索引进默认装配 + 压缩摘要 Session 持久化
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBuilder } from '../../src/harness/agent-building/builder.js';
import { DefaultContextEngine } from '../../src/harness/context/default-context-engine.js';
import { createDefaultSystemPromptAssembler } from '../../src/harness/context/system-prompt-assembler.js';
import { DefaultSkillManager } from '../../src/harness/plugin-ecosystem/skills/manager.js';
import type { ModelProvider, LLMMessage } from '../../src/core/interfaces/model-provider.js';
import type { Message } from '../../src/core/types.js';
import type { SessionData } from '../../src/harness/session-types.js';
import type { SessionStore } from '../../src/core/interfaces/session-store.js';

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
  it('assemble 返回 summary 并可经 loadCompactState 恢复', async () => {
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 4,
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
    expect(first.compactState?.lastProactiveMessageCount).toBe(30);

    // 新引擎实例（模拟进程重启），靠 loadCompactState 恢复 count + summary
    const engine2 = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 4,
    });
    let loaded = false;
    let summarizeCalls = 0;
    const countingSummarize = async (m: LLMMessage[]) => {
      summarizeCalls += 1;
      return '## Conversation Summary\npersist-me';
    };
    const second = await engine2.assemble({
      sessionId: 's-persist',
      // 仅 +1 条：应走缓存重建，不再打 LLM
      messages: [...msgs, userMsg('tiny')],
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize: countingSummarize,
      loadCompactState: (sid) => {
        loaded = sid === 's-persist';
        return first.compactState;
      },
    });
    expect(loaded).toBe(true);
    expect(second.summary).toContain('persist-me');
    expect(summarizeCalls).toBe(0);
  });

  it('多轮压缩：count 只在 LLM 摘要时推进，缓存重建不重置', async () => {
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 20, // minNewForResummarize = max(3, 5) = 5
      proactiveCooldownMs: 0, // 本用例验证多轮 LLM 摘要，关闭冷却
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
    expect(r1.compactState?.lastProactiveMessageCount).toBe(30);
    expect(r1.summary).toContain('v1');

    // 连续 4 次缓存重建（每轮 +1）：不应再打 LLM，count 保持 30
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
      expect(r.compactState?.lastProactiveMessageCount).toBe(30);
    }

    // 第 5 条增量：newSinceLast=5 → 再摘要
    msgs = [...msgs, userMsg('t4-final')];
    const r2 = await engine.assemble({
      sessionId: 's-multi',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
    });
    expect(summarizeCalls).toBe(2);
    expect(r2.compactState?.lastProactiveMessageCount).toBe(35);
    expect(r2.summary).toContain('v2');

    // 模拟进程重启：用最后一次 compactState 恢复
    const engine2 = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      protectFirstN: 2,
      protectLastN: 20,
      proactiveCooldownMs: 0,
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
      loadCompactState: () => r2.compactState,
    });
    // +1 条 → 缓存重建，不打 LLM
    expect(restartCalls).toBe(0);
    expect(r3.summary).toContain('v2');
    expect(r3.compactState?.lastProactiveMessageCount).toBe(35);
  });

  it('Runner 路径：session.contextCompact 播种并在 save 前回写', async () => {
    const provider = mockProvider();
    const sessions = new Map<string, SessionData>();
    const store: SessionStore<SessionData> = {
      async load(_agentId: string, sessionId: string) {
        return sessions.get(sessionId) ?? null;
      },
      async save(_agentId: string, sessionId: string, data: SessionData) {
        sessions.set(sessionId, JSON.parse(JSON.stringify(data)) as SessionData);
      },
      async delete(_agentId: string, sessionId: string) {
        sessions.delete(sessionId);
      },
      async list(agentId: string) {
        return [...sessions.values()]
          .filter((s) => s.agentId === agentId)
          .map((s) => s.meta);
      },
      async exists(_agentId: string, sessionId: string) {
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
      turns: [],
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
