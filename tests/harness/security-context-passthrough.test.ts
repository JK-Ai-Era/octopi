/**
 * Security context must reach tools through the real assembly path.
 *
 * A guard that is configured but never delivered is worse than no guard: the
 * deployment believes it is protected. This exact failure happened once —
 * `refuseFinalSymlink` was added to RunScope but dropped by the context provider
 * in `builder.ts`, because the fields were copied one by one and nothing failed
 * to compile. These tests assert the properties from the tool's own view.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTokenUsage } from '@octopi-agent/core/types/turn.js';
import type { ModelProvider, RegisteredTool, ToolExecutionContext } from '@octopi-agent/core/index.js';
import type { LLMStreamChunk } from '@octopi-agent/core/interfaces/model-provider.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/index.js';

function mockProvider(): ModelProvider {
  let call = 0;
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: 'done',
      model: 'mock-model',
      finishReason: 'stop',
      usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }),
    }),
    stream: async function* (): AsyncGenerator<LLMStreamChunk> {
      call += 1;
      if (call === 1) {
        yield { type: 'tool_call', toolCall: { id: 'p1', name: 'probe', arguments: '{}' } };
        yield { type: 'done', finishReason: 'tool_calls', usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }) };
        return;
      }
      yield { type: 'content', content: 'done' };
      yield { type: 'done', usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }) };
    },
    isAvailable: vi.fn().mockResolvedValue(true),
    getModelInfo: () => null,
    getModelInfos: () => [],
  };
}

/**
 * Run one turn with a probe tool and return the context the tool actually saw.
 *
 * @param configure - builder configuration applied before build
 * @returns captured tool context
 */
async function captureToolContext(
  configure: (builder: AgentBuilder) => AgentBuilder,
): Promise<ToolExecutionContext> {
  const workdir = await mkdtemp(join(tmpdir(), 'octopi-ctx-'));
  try {
    const root = join(workdir, 'workspace');
    await mkdir(root, { recursive: true });
    let seen: ToolExecutionContext | undefined;

    const probe: RegisteredTool = {
      definition: { name: 'probe', description: 'captures context', parameters: {} },
      handler: async (_args, context) => {
        seen = context;
        return 'ok';
      },
    };

    const built = await configure(
      new AgentBuilder()
        .model(mockProvider())
        .tool(probe)
        .agentId('ctx-probe')
        .constitution({ mode: 'off' })
        .systemPrompt('probe')
        .effectPolicy({ opsAudit: 'off' })
        .budget({ maxWallClockMs: 5000, maxIterations: 2 }),
    ).build({ autoLoadSubsystems: false });

    for await (const _event of built.runner.handle(
      'ctx-session',
      { role: 'user', content: 'go', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'ctx-probe', sessionId: 'ctx-session' },
    )) void _event;

    expect(seen, 'the probe tool must have run').toBeDefined();
    return seen as ToolExecutionContext;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

describe('security context reaches tools', () => {
  it('delivers pathDenylist declared in effectPolicy', async () => {
    const context = await captureToolContext((builder) =>
      builder.effectPolicy({
        mode: 'workspace',
        opsAudit: 'off',
        pathContainment: 'strict',
        pathDenylist: ['.env*', '.git/**'],
      }),
    );
    expect(context.pathDenylist).toEqual(['.env*', '.git/**']);
  });

  it('delivers pathContainment and refuseFinalSymlink together', async () => {
    const context = await captureToolContext((builder) =>
      builder.effectPolicy({
        mode: 'workspace',
        opsAudit: 'off',
        pathContainment: 'strict',
        refuseFinalSymlink: true,
      }),
    );
    expect(context.pathContainment).toBe('strict');
    expect(context.refuseFinalSymlink).toBe(true);
  });

  it('defaults to an empty denylist when none is declared', async () => {
    const context = await captureToolContext((builder) =>
      builder.effectPolicy({ mode: 'workspace', opsAudit: 'off', pathContainment: 'strict' }),
    );
    expect(context.pathDenylist).toEqual([]);
  });
});
