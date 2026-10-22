import { describe, it, expect } from 'vitest';
import {
  ModelResolver,
  resolveProviderInstance,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/model-resolver.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

const fakeProvider = (name: string): ModelProvider =>
  ({ name, chat: async () => { throw new Error('no chat in tests'); } }) as unknown as ModelProvider;

describe('ModelResolver', () => {
  const levels = {
    mini: {
      primary: 'openai-main/gpt-4o-mini',
      fallback: ['anthropic/claude-haiku-4-5'],
    },
    standard: {
      primary: 'openai-main/gpt-5.5',
      fallback: ['anthropic/claude-sonnet-4-6', 'openai-main/gpt-4o'],
    },
    pro: {
      primary: 'anthropic/claude-opus-4-6',
      fallback: ['openai-main/gpt-5.5'],
    },
  };

  describe('level name resolution', () => {
    it('resolves "mini" to primary + fallback', () => {
      const resolver = new ModelResolver({ levels });
      const result = resolver.resolve('mini');

      expect(result.fromLevel).toBe(true);
      expect(result.primary).toEqual({ provider: 'openai-main', model: 'gpt-4o-mini' });
      expect(result.fallback).toHaveLength(1);
      expect(result.fallback[0]).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    });

    it('resolves "standard" with multiple fallbacks', () => {
      const resolver = new ModelResolver({ levels });
      const result = resolver.resolve('standard');

      expect(result.fromLevel).toBe(true);
      expect(result.primary).toEqual({ provider: 'openai-main', model: 'gpt-5.5' });
      expect(result.fallback).toHaveLength(2);
      expect(result.fallback[0]).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
      expect(result.fallback[1]).toEqual({ provider: 'openai-main', model: 'gpt-4o' });
    });

    it('resolves "pro"', () => {
      const resolver = new ModelResolver({ levels });
      const result = resolver.resolve('pro');

      expect(result.fromLevel).toBe(true);
      expect(result.primary).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6' });
    });

    it('level with no fallback returns empty fallback array', () => {
      const resolver = new ModelResolver({
        levels: { mini: { primary: 'openai/gpt-4o-mini' } },
      });
      const result = resolver.resolve('mini');

      expect(result.fromLevel).toBe(true);
      expect(result.fallback).toHaveLength(0);
    });
  });

  describe('provider/model format', () => {
    it('resolves "openai-main/gpt-4o-mini" directly', () => {
      const resolver = new ModelResolver({ levels });
      const result = resolver.resolve('openai-main/gpt-4o-mini');

      expect(result.fromLevel).toBe(false);
      expect(result.primary).toEqual({ provider: 'openai-main', model: 'gpt-4o-mini' });
      expect(result.fallback).toHaveLength(0);
    });

    it('handles provider names with hyphens', () => {
      const resolver = new ModelResolver({ levels });
      const result = resolver.resolve('my-custom-provider/some-model');

      expect(result.primary).toEqual({ provider: 'my-custom-provider', model: 'some-model' });
    });
  });

  describe('bare model name', () => {
    it('resolves bare model name to main provider (no provider name)', () => {
      const resolver = new ModelResolver({ levels });
      const result = resolver.resolve('gpt-4o-mini');

      expect(result.fromLevel).toBe(false);
      expect(result.primary).toEqual({ provider: undefined, model: 'gpt-4o-mini' });
      expect(result.fallback).toHaveLength(0);
    });

    it('well-known level alias not configured fails loud', () => {
      const resolver = new ModelResolver({ levels: {} });
      expect(() => resolver.resolve('mini')).toThrow(/unresolved_model_level/);
    });
  });

  describe('resolveRef', () => {
    it('defaults to "standard" level when configured', () => {
      const resolver = new ModelResolver({ levels });
      const result = resolver.resolveRef();

      expect(result.fromLevel).toBe(true);
      expect(result.primary).toEqual({ provider: 'openai-main', model: 'gpt-5.5' });
    });

    it('falls back to main provider default model when no levels configured', () => {
      const resolver = new ModelResolver({ levels: {} });
      const result = resolver.resolveRef();

      expect(result.fromLevel).toBe(false);
      expect(result.primary.provider).toBeUndefined();
      expect(result.primary.model).toBeUndefined();
    });
  });

  describe('priority: level > provider/model > bare', () => {
    it('level name takes priority over slash format', () => {
      // If someone names a level "openai/something", it should resolve as level
      const resolver = new ModelResolver({
        levels: { 'openai/special': { primary: 'anthropic/claude-3-opus' } },
      });
      const result = resolver.resolve('openai/special');

      expect(result.fromLevel).toBe(true);
      expect(result.primary).toEqual({ provider: 'anthropic', model: 'claude-3-opus' });
    });
  });

  describe('updateLevels', () => {
    it('merges new levels into existing ones', () => {
      const resolver = new ModelResolver({ levels });
      resolver.updateLevels({
        fast: { primary: 'google/gemini-flash' },
        mini: { primary: 'new-provider/new-mini' }, // override
      });

      expect(resolver.levelNames).toContain('fast');
      expect(resolver.resolve('fast').primary).toEqual({ provider: 'google', model: 'gemini-flash' });
      // mini should be overridden
      expect(resolver.resolve('mini').primary).toEqual({ provider: 'new-provider', model: 'new-mini' });
    });
  });
});

describe('resolveProviderInstance', () => {
  const main = fakeProvider('main');
  const named = fakeProvider('openai');

  it('returns the named provider when registered', () => {
    const providers = new Map([['openai', named]]);
    expect(
      resolveProviderInstance({ provider: 'openai', model: 'gpt-5.5' }, providers, main),
    ).toBe(named);
  });

  it('returns the main provider when no provider name is given', () => {
    expect(
      resolveProviderInstance({ provider: undefined, model: 'gpt-5.5' }, undefined, main),
    ).toBe(main);
  });

  it('falls back to the main provider when the named provider is missing', () => {
    expect(
      resolveProviderInstance({ provider: 'missing', model: 'x' }, new Map(), main),
    ).toBe(main);
  });
});
