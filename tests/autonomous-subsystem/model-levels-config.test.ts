import { describe, it, expect } from 'vitest';
import { ModelResolver } from '../../src/harness/autonomous-subsystem/think/model-resolver.js';
import type { ModelLevelMap } from '../../src/harness/autonomous-subsystem/types.js';

describe('ModelResolver with config-defined levels', () => {
  const levels: ModelLevelMap = {
    mini: { primary: 'bailian/qwen-turbo', fallback: ['ollama/qwen3:4b'] },
    standard: { primary: 'bailian/kimi-k2.5', fallback: ['bailian/glm-5'] },
    pro: { primary: 'bailian/deepseek-r1', fallback: ['bailian/kimi-k2.5', 'bailian/glm-5'] },
  };

  it('should resolve level name to primary model', () => {
    const resolver = new ModelResolver({ levels });
    const result = resolver.resolve('mini');

    expect(result.fromLevel).toBe(true);
    expect(result.primary).toEqual({ provider: 'bailian', model: 'qwen-turbo' });
  });

  it('should include fallback chain for level', () => {
    const resolver = new ModelResolver({ levels });
    const result = resolver.resolve('pro');

    expect(result.fromLevel).toBe(true);
    expect(result.primary).toEqual({ provider: 'bailian', model: 'deepseek-r1' });
    expect(result.fallback).toHaveLength(2);
    expect(result.fallback[0]).toEqual({ provider: 'bailian', model: 'kimi-k2.5' });
    expect(result.fallback[1]).toEqual({ provider: 'bailian', model: 'glm-5' });
  });

  it('should resolve provider/model format without level', () => {
    const resolver = new ModelResolver({ levels });
    const result = resolver.resolve('openai/gpt-4o');

    expect(result.fromLevel).toBe(false);
    expect(result.primary).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(result.fallback).toHaveLength(0);
  });

  it('should fallback to default provider for bare model name', () => {
    const resolver = new ModelResolver({ levels, defaultProvider: 'ollama' });
    const result = resolver.resolve('qwen3:4b');

    expect(result.fromLevel).toBe(false);
    expect(result.primary).toEqual({ provider: 'ollama', model: 'qwen3:4b' });
  });

  it('should support updating levels at runtime', () => {
    const resolver = new ModelResolver({
      levels: { mini: { primary: 'old/mini' } },
    });

    expect(resolver.resolve('mini').primary.model).toBe('mini');

    resolver.updateLevels({
      mini: { primary: 'bailian/qwen-turbo', fallback: ['ollama/qwen3:4b'] },
    });

    const result = resolver.resolve('mini');
    expect(result.primary).toEqual({ provider: 'bailian', model: 'qwen-turbo' });
    expect(result.fallback).toHaveLength(1);
  });
});
