/**
 * Runtime datetime 注入回归
 */

import { describe, it, expect } from 'vitest';
import {
  formatRuntimeDatetimeInjection,
  formatRuntimeWorkspaceInjection,
  withRuntimeDatetimeInjection,
  withRuntimeEnvironmentInjection,
} from '../../src/harness/context/runtime-datetime.js';
import { AgentBuilder } from '../../src/harness/agent/builder.js';
import { InMemorySessionStore } from '../../src/integration/storage/memory.js';
import type { ModelProvider, LLMRequest } from '../../src/core/interfaces/model-provider.js';
import type { Message } from '../../src/core/types.js';

function createMockProvider(capture?: (req: LLMRequest) => void): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat(req: LLMRequest) {
      capture?.(req);
      return { content: 'ok', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return { name: 'm', contextWindow: 32000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 32000 }];
    },
  };
}

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('formatRuntimeDatetimeInjection', () => {
  it('输出本地 datetime 与 IANA 时区，精度到分钟', () => {
    const now = new Date(2026, 2, 18, 14, 30, 45);
    const text = formatRuntimeDatetimeInjection(now);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedDate = `2026-03-18`;
    const expectedTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    expect(text).toContain(`Current datetime: ${expectedDate} ${expectedTime} (${tz})`);
    expect(text).not.toContain('time-sensitive');
    expect(text).not.toContain(`:${pad(45)}`);
  });
});

describe('withRuntimeDatetimeInjection', () => {
  it('无既有注入时仅返回 datetime 块', () => {
    const text = withRuntimeDatetimeInjection(undefined, new Date(2026, 0, 1, 8, 0));
    expect(text).toMatch(/^Current datetime: 2026-01-01 08:00 \(/);
  });

  it('有既有注入时 datetime 在前，原内容保留', () => {
    const text = withRuntimeDatetimeInjection('INJECT-A', new Date(2026, 0, 1, 8, 0));
    const dtIdx = text.indexOf('Current datetime:');
    const injectIdx = text.indexOf('INJECT-A');
    expect(dtIdx).toBeGreaterThanOrEqual(0);
    expect(injectIdx).toBeGreaterThan(dtIdx);
  });
});

describe('formatRuntimeWorkspaceInjection', () => {
  it('输出 Workspace 锚点与检索指引', () => {
    const text = formatRuntimeWorkspaceInjection('C:\\Users\\me\\.octopi\\workspace\\default');
    expect(text).toContain('Workspace: C:\\Users\\me\\.octopi\\workspace\\default');
    expect(text).toContain('Relative tool paths resolve against this directory.');
    expect(text).toContain('Prefer searching here first');
  });

  it('cwd 为空时返回空串', () => {
    expect(formatRuntimeWorkspaceInjection(undefined)).toBe('');
    expect(formatRuntimeWorkspaceInjection('  ')).toBe('');
  });
});

describe('withRuntimeEnvironmentInjection', () => {
  it('datetime + workspace + 既有注入按序拼接', () => {
    const text = withRuntimeEnvironmentInjection('TASKS', {
      now: new Date(2026, 0, 1, 8, 0),
      cwd: '/home/me/workspace',
    });
    const dtIdx = text.indexOf('Current datetime:');
    const wsIdx = text.indexOf('Workspace: /home/me/workspace');
    const taskIdx = text.indexOf('TASKS');
    expect(dtIdx).toBeGreaterThanOrEqual(0);
    expect(wsIdx).toBeGreaterThan(dtIdx);
    expect(taskIdx).toBeGreaterThan(wsIdx);
  });

  it('无 cwd 时不注入 Workspace 块', () => {
    const text = withRuntimeEnvironmentInjection(undefined, { now: new Date(2026, 0, 1, 8, 0) });
    expect(text).toContain('Current datetime:');
    expect(text).not.toContain('Workspace:');
  });
});

describe('SessionAwareRunner 注入 datetime', () => {
  it('每轮 system prompt 含 Current datetime，且叠加调用方 injectedContext', async () => {
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));
    const { runner } = await new AgentBuilder()
      .model(provider)
      .systemPrompt('You are test-agent.')
      .store(new InMemorySessionStore())
      .build();

    const runConfig = { systemPrompt: '', agentId: 'a', sessionId: 's1' };
    for await (const _ of runner.handle('s1', userMsg('hi'), {
      ...runConfig,
      injectedContext: 'CALLER-INJECT',
    })) {
      // drain
    }

    const system = String(captured[0]?.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(system).toContain('You are test-agent.');
    expect(system).toContain('Current datetime:');
    expect(system).toContain('CALLER-INJECT');
    // I1：装配结果在 Run 工作区；共享 agent.context 不再作为「当前会话 system」权威
    expect(system.indexOf('Current datetime:')).toBeGreaterThan(-1);
  });

  it('配置 agent.workspace 时 system prompt 含 Workspace 锚点', async () => {
    const captured: LLMRequest[] = [];
    const provider = createMockProvider((req) => captured.push(req));
    const ws = 'C:\\Users\\me\\.octopi\\workspace\\default';
    const { runner } = await new AgentBuilder()
      .model(provider)
      .systemPrompt('You are test-agent.')
      .workspace(ws)
      .store(new InMemorySessionStore())
      .build();

    for await (const _ of runner.handle('s2', userMsg('find my doc'), {
      systemPrompt: '',
      agentId: 'a',
      sessionId: 's2',
    })) {
      // drain
    }

    const system = String(captured[0]?.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(system).toContain(`Workspace: ${ws}`);
    expect(system).toContain('Prefer searching here first');
  });
});
