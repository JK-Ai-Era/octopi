/**
 * Persona 热更新测试
 *
 * 文件式 persona 不应在 build 时烤死；改文件后下一轮 run 生效。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { readFileSpy } = vi.hoisted(() => ({ readFileSpy: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      readFileSpy(...args);
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

import { PersonaSource, loadPersona, composePersonas } from '../src/harness/agent-building/persona.js';
import { AgentBuilder } from '../src/harness/agent-building/builder.js';
import { InMemorySessionStore } from '../src/integration/storage/memory.js';
import type { ModelProvider, LLMRequest } from '../src/core/interfaces/model-provider.js';
import type { SecurityGuard, SecurityCheckResult } from '../src/core/interfaces/security-guard.js';
import type { Message } from '../src/core/types/messages.js';

function createMockProvider(onChat?: (req: LLMRequest) => void): ModelProvider {
  return {
    name: 'mock',
    chat: vi.fn(async (req: LLMRequest) => {
      onChat?.(req);
      return {
        content: 'ok',
        model: 'mock-model',
        finishReason: 'stop' as const,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
    isAvailable: async () => true,
    getModelInfo: () => null,
  };
}

function createMockSecurity(setSystemPrompt?: (p: string) => void): SecurityGuard & { setSystemPromptMock: ReturnType<typeof vi.fn> } {
  const clean: SecurityCheckResult = { isClean: true, violations: [] };
  const setSystemPromptMock = vi.fn(setSystemPrompt);
  return {
    setSystemPromptMock,
    checkUserInput: () => clean,
    checkToolOutput: () => clean,
    checkModelOutput: () => clean,
    checkToolCall: () => clean,
    checkBehavior: () => clean,
    setSystemPrompt: setSystemPromptMock,
  };
}

function writeAgentHome(home: string, agentsMd: string, soul: string): void {
  mkdirSync(join(home, 'persona'), { recursive: true });
  writeFileSync(join(home, 'AGENTS.md'), agentsMd, 'utf-8');
  writeFileSync(join(home, 'persona/10-soul.md'), soul, 'utf-8');
}

/** 强制 mtime 前进，避免同毫秒写导致指纹不变 */
function bumpMtime(path: string): void {
  const now = Date.now() / 1000 + 1;
  utimesSync(path, now, now);
}

function userMsg(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() };
}

describe('PersonaSource', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'octopi-persona-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('load 返回 AGENTS.md + persona/*.md 组合内容', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const source = new PersonaSource();
    const content = await source.load(home);
    expect(content).toContain('# Main');
    expect(content).toContain('# Soul v1');
  });

  it('指纹未变时复用缓存，不重复读盘', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const source = new PersonaSource();

    readFileSpy.mockClear();
    const first = await source.load(home);
    expect(first).toContain('# Soul v1');
    const readsAfterFirst = readFileSpy.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = await source.load(home);
    expect(second).toBe(first);
    // 指纹未变：不应再 readFile
    expect(readFileSpy.mock.calls.length).toBe(readsAfterFirst);
  });

  it('修改文件后下一次 load 返回新内容', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const source = new PersonaSource();
    const first = await source.load(home);
    expect(first).toContain('# Soul v1');

    const soulPath = join(home, 'persona/10-soul.md');
    writeFileSync(soulPath, '# Soul v2', 'utf-8');
    bumpMtime(soulPath);

    const second = await source.load(home);
    expect(second).toContain('# Soul v2');
    expect(second).not.toContain('# Soul v1');
  });

  it('新增 persona 文件后下一次 load 包含新文件', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const source = new PersonaSource();
    const first = await source.load(home);
    expect(first).not.toContain('# Extra');

    writeFileSync(join(home, 'persona/50-extra.md'), '# Extra', 'utf-8');
    const second = await source.load(home);
    expect(second).toContain('# Extra');
  });

  it('删空文件后 load 返回空串', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const source = new PersonaSource();
    expect(await source.load(home)).toContain('# Soul v1');

    unlinkSync(join(home, 'AGENTS.md'));
    unlinkSync(join(home, 'persona/10-soul.md'));

    expect(await source.load(home)).toBe('');
  });

  it('多目录 compose：改其中一个目录后 load 更新', async () => {
    const homeB = mkdtempSync(join(tmpdir(), 'octopi-persona-b-'));
    try {
      writeAgentHome(home, '# Base', '# BaseSoul');
      writeAgentHome(homeB, '# Scenario', '# ScenSoul');
      const source = new PersonaSource();
      const first = await source.load(home, homeB);
      expect(first).toContain('# BaseSoul');
      expect(first).toContain('# ScenSoul');

      const soulB = join(homeB, 'persona/10-soul.md');
      writeFileSync(soulB, '# ScenSoul-v2', 'utf-8');
      bumpMtime(soulB);

      const second = await source.load(home, homeB);
      expect(second).toContain('# BaseSoul');
      expect(second).toContain('# ScenSoul-v2');
    } finally {
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  it('invalidate 后强制重读', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const source = new PersonaSource();
    await source.load(home);
    source.invalidate(home);
    const again = await source.load(home);
    expect(again).toContain('# Soul v1');
  });
});

describe('AgentBuilder + SessionAwareRunner 热更新', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'octopi-persona-run-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('build 后改 persona，下一轮 handle 使用新 systemPrompt', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));

    const { agent, runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .store(new InMemorySessionStore())
      .build();

    expect(agent.context.systemPrompt).toContain('# Soul v1');

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('hi'), runConfig)) {
      // drain
    }
    const firstSystem = captured[0]?.messages.find((m) => m.role === 'system');
    expect(String(firstSystem?.content ?? '')).toContain('# Soul v1');

    const soulPath = join(home, 'persona/10-soul.md');
    writeFileSync(soulPath, '# Soul v2-hot', 'utf-8');
    bumpMtime(soulPath);

    for await (const _ of runner.handle('s1', userMsg('again'), runConfig)) {
      // drain
    }
    const secondSystem = captured[1]?.messages.find((m) => m.role === 'system');
    expect(String(secondSystem?.content ?? '')).toContain('# Soul v2-hot');
    expect(String(secondSystem?.content ?? '')).not.toContain('# Soul v1');
  });

  it('删空文件后 systemPrompt 被清空，不粘住旧内容', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));
    const security = createMockSecurity();

    const { agent, runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .security(security)
      .store(new InMemorySessionStore())
      .build();

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('hi'), runConfig)) {
      // drain
    }
    expect(String(captured[0]?.messages.find((m) => m.role === 'system')?.content ?? '')).toContain('# Soul v1');

    unlinkSync(join(home, 'AGENTS.md'));
    unlinkSync(join(home, 'persona/10-soul.md'));

    for await (const _ of runner.handle('s1', userMsg('again'), runConfig)) {
      // drain
    }

    const secondSystem = captured[1]?.messages.find((m) => m.role === 'system');
    expect(secondSystem).toBeUndefined();
    expect(agent.context.systemPrompt).toBe('');
    expect(security.setSystemPromptMock).toHaveBeenLastCalledWith('');
  });

  it('热更新后 SecurityGuard 基线同步为新内容', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const provider = createMockProvider();
    const security = createMockSecurity();

    const { runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .security(security)
      .store(new InMemorySessionStore())
      .build();

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('hi'), runConfig)) {
      // drain
    }
    expect(security.setSystemPromptMock).toHaveBeenLastCalledWith(expect.stringContaining('# Soul v1'));

    const soulPath = join(home, 'persona/10-soul.md');
    writeFileSync(soulPath, '# Soul v2-sec', 'utf-8');
    bumpMtime(soulPath);

    for await (const _ of runner.handle('s1', userMsg('again'), runConfig)) {
      // drain
    }
    expect(security.setSystemPromptMock).toHaveBeenLastCalledWith(expect.stringContaining('# Soul v2-sec'));
  });

  it('resolver 失败时沿用上次干净 persona，且不叠加 injectedContext', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));
    const { DefaultEventBus } = await import('../src/core/primitives/event-bus.js');
    const bus = new DefaultEventBus();
    const failedEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
    bus.on('persona.resolve.failed', (e) => failedEvents.push(e));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { agent, runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .events(bus)
      .store(new InMemorySessionStore())
      .build();

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    // 第一轮：带注入，制造「persona + INJECT-A」的 context.systemPrompt
    for await (const _ of runner.handle('s1', userMsg('hi'), {
      ...runConfig,
      injectedContext: 'INJECT-A',
    })) {
      // drain
    }
    expect(agent.context.systemPrompt).toContain('INJECT-A');

    // 模拟磁盘读失败
    runner.setSystemPromptResolver(async () => {
      throw new Error('disk fail');
    });

    for await (const _ of runner.handle('s1', userMsg('again'), {
      ...runConfig,
      injectedContext: 'INJECT-B',
    })) {
      // drain
    }

    const sys = String(captured[1]?.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(sys).toContain('# Soul v1');
    expect(sys).toContain('INJECT-B');
    expect(sys).not.toContain('INJECT-A');

    // 可观测性：warn + 轻量事件
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('persona resolve failed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disk fail'));
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.data?.error).toBe('disk fail');

    warnSpy.mockRestore();
  });

  it('多轮后 session 仅保留一条 system 消息，且内容已刷新', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const store = new InMemorySessionStore();
    const provider = createMockProvider();

    const { runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .store(store)
      .build();

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('one'), runConfig)) {
      // drain
    }

    const soulPath = join(home, 'persona/10-soul.md');
    writeFileSync(soulPath, '# Soul v2', 'utf-8');
    bumpMtime(soulPath);

    for await (const _ of runner.handle('s1', userMsg('two'), runConfig)) {
      // drain
    }

    const session = await store.load('a', 's1');
    const systemMsgs = (session?.messages ?? []).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(String(systemMsgs[0]?.content ?? '')).toContain('# Soul v2');
  });

  it('历史脏数据：多条无 metadata 的 managed system 只保留一条', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));
    const store = new InMemorySessionStore();

    const { runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .store(store)
      .build();

    const now = Date.now();
    await store.save('a', 's1', {
      id: 's1',
      agentId: 'a',
      meta: {
        id: 's1',
        agentId: 'a',
        channelId: 'test',
        peerId: 'p',
        status: 'idle',
        createdAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
        updatedAt: now,
      },
      messages: [
        // 历史无 metadata → 视为 managed
        { role: 'system', content: 'STALE-MANAGED-A', timestamp: now },
        { role: 'user', content: 'prev', timestamp: now },
        { role: 'system', content: 'STALE-MANAGED-B', timestamp: now },
        {
          role: 'system',
          content: 'EXTERNAL-KEEP',
          timestamp: now,
          metadata: { source: 'external' },
        },
      ],
      turns: [],
      metadata: {},
    });

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('hi'), runConfig)) {
      // drain
    }

    const after = await store.load('a', 's1');
    const systems = (after?.messages ?? []).filter((m) => m.role === 'system');
    const managed = systems.filter(
      (m) => m.metadata?.source === 'systemPrompt' || m.metadata?.source === undefined,
    );
    const external = systems.filter((m) => m.metadata?.source === 'external');

    expect(managed).toHaveLength(1);
    expect(String(managed[0]?.content ?? '')).toContain('# Soul v1');
    expect(managed[0]?.content).not.toContain('STALE-MANAGED');
    expect(external).toHaveLength(1);
    expect(String(external[0]?.content ?? '')).toBe('EXTERNAL-KEEP');
  });

  it('外部 system 在首位时仍注入 persona，且外部消息保留', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));
    const store = new InMemorySessionStore();

    const { runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .store(store)
      .build();

    // 预置 session：只有外部 system，尚无引擎托管 system
    const now = Date.now();
    await store.save('a', 's1', {
      id: 's1',
      agentId: 'a',
      meta: {
        id: 's1',
        agentId: 'a',
        channelId: 'test',
        peerId: 'p',
        status: 'idle',
        createdAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
        updatedAt: now,
      },
      messages: [
        {
          role: 'system',
          content: 'CUSTOM-SYSTEM-KEEP-ME',
          timestamp: now,
          metadata: { source: 'external' },
        },
      ],
      turns: [],
      metadata: {},
    });

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('hi'), runConfig)) {
      // drain
    }

    const last = captured[captured.length - 1];
    const sysMessages = last?.messages.filter((m) => m.role === 'system') ?? [];
    const contents = sysMessages.map((m) => String(m.content ?? ''));
    // persona 必须在（托管 system 注入，不被首位外部 system 挡住）
    expect(contents.some((c) => c.includes('# Soul v1'))).toBe(true);
    // 外部 system 保留
    expect(contents.some((c) => c.includes('CUSTOM-SYSTEM-KEEP-ME'))).toBe(true);
    // 托管 system 在最前
    expect(contents[0]).toContain('# Soul v1');
  });

  it('空 persona 目录 + 有工具：首轮 run 保留默认 tools prompt', async () => {
    // home 存在但没有任何 AGENTS.md / persona/*.md（Gateway 刚注册、尚未写盘）
    mkdirSync(home, { recursive: true });
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));

    const { agent, runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .tool({
        definition: { name: 'noop', description: 'noop tool', parameters: {} },
        handler: async () => 'ok',
      })
      .store(new InMemorySessionStore())
      .build();

    // build：空 persona → 默认 tools prompt
    expect(agent.context.systemPrompt).toContain('noop');

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('hi'), runConfig)) {
      // drain
    }

    const firstSystem = captured[0]?.messages.find((m) => m.role === 'system');
    // 未写盘时不应被 resolver 空串清掉默认 prompt
    expect(String(firstSystem?.content ?? '')).toContain('noop');
    expect(agent.context.systemPrompt).toContain('noop');
  });

  it('空 persona 目录后写入文件：下一轮切到磁盘 persona', async () => {
    mkdirSync(home, { recursive: true });
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));

    const { runner } = await new AgentBuilder()
      .model(provider)
      .persona(home)
      .tool({
        definition: { name: 'noop', description: 'noop tool', parameters: {} },
        handler: async () => 'ok',
      })
      .store(new InMemorySessionStore())
      .build();

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('hi'), runConfig)) {
      // drain
    }
    expect(String(captured[0]?.messages.find((m) => m.role === 'system')?.content ?? '')).toContain('noop');

    writeAgentHome(home, '# Written', '# Soul-later');
    bumpMtime(join(home, 'AGENTS.md'));

    for await (const _ of runner.handle('s1', userMsg('again'), runConfig)) {
      // drain
    }
    const second = String(captured[1]?.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(second).toContain('# Soul-later');
  });

  it('显式 systemPrompt 时不挂 resolver，仍用固定内容', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    const provider = createMockProvider();
    const { agent } = await new AgentBuilder()
      .model(provider)
      .systemPrompt('Fixed prompt')
      .persona(home)
      .buildAgent();

    expect(agent.context.systemPrompt).toBe('Fixed prompt');
  });
});

describe('loadPersona 始终无缓存', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'octopi-persona-fresh-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('每次调用都读盘，立即反映文件内容', async () => {
    writeAgentHome(home, '# Main', '# Soul v1');
    expect(await loadPersona(home)).toContain('# Soul v1');
    writeFileSync(join(home, 'persona/10-soul.md'), '# Soul v3', 'utf-8');
    expect(await loadPersona(home)).toContain('# Soul v3');
  });
});

describe('composePersonas', () => {
  it('按目录顺序拼接', async () => {
    const a = mkdtempSync(join(tmpdir(), 'octopi-comp-a-'));
    const b = mkdtempSync(join(tmpdir(), 'octopi-comp-b-'));
    try {
      writeAgentHome(a, '# A', '# ASoul');
      writeAgentHome(b, '# B', '# BSoul');
      const content = await composePersonas(a, b);
      expect(content.indexOf('# ASoul')).toBeLessThan(content.indexOf('# BSoul'));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
