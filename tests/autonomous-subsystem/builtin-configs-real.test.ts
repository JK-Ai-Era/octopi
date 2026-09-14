import { describe, it, expect } from 'vitest';
import { SubsystemLoader } from '../../src/harness/autonomous-subsystem/loader.js';
import { join } from 'node:path';

const BUILTIN = join(process.cwd(), 'src/subsystems');

describe('real builtin subsystem configs', () => {
  it('loads memory-extractor and safety-guard', async () => {
    const loader = new SubsystemLoader({ builtinDir: BUILTIN });
    const result = await loader.loadAll();

    expect(result.errors).toEqual([]);
    const ids = result.specs.map((s) => s.id).sort();
    expect(ids).toEqual(['memory.extractor', 'safety-guard']);

    const me = result.specs.find((s) => s.id === 'memory.extractor')!;
    expect(me.think.implementation).toBe('code');
    expect(typeof me.think.handler).toBe('function');
    expect(me.sense.filter?.events).toEqual([
      'session.lifecycle.updated',
      'memory.extractor.bundle.ready',
    ]);
    expect(me.sense.filter?.condition).toContain('sessionLifecycle');
    expect(me.signal.channel).toEqual(['context', 'event']);
    expect(me.act.mode).toBe('inject');
    expect(me.runtimeInject?.requires).toEqual(['memoryStore']);
    // SUBSYSTEM.md 应为认知指令，而非作者文档
    expect(me.think.systemPrompt).toContain('记忆提取专家');
    expect(me.think.systemPrompt).not.toContain('注入依赖');
    expect(me.resume?.enabled).toBe(true);
    expect(me.metadata?.config).toMatchObject({
      minConfidence: 0.6,
      llmEnrichment: { temperature: 0.3, maxTokens: 2048 },
    });
    // 观测前缀与 emit 声明（若有）
    expect(me.observability?.eventPrefix).toBe('memory.extractor');

    const sg = result.specs.find((s) => s.id === 'safety-guard')!;
    expect(sg.think.implementation).toBe('llm');
    expect(sg.think.model).toBe('mini');
    expect(sg.think.maxIterations).toBe(1);
    expect(sg.act.mode).toBe('block');
    expect(sg.boundary.authority).toBe('act');
    expect(sg.lifecycle?.maxDurationMs).toBe(15000);
    expect(sg.lifecycle?.degradeOn).toBe('timeout');
    // llm 模式 systemPrompt 来自 SUBSYSTEM.md
    expect(sg.think.systemPrompt && sg.think.systemPrompt.length > 0).toBe(true);
  });
});
