import { describe, it, expect } from 'vitest';
import { ModelResolver } from '../../src/harness/autonomous-subsystem/think/model-resolver.js';

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
    it('resolves bare model name with default provider', () => {
      const resolver = new ModelResolver({ levels, defaultProvider: 'openai-main' });
      const result = resolver.resolve('gpt-4o-mini');

      expect(result.fromLevel).toBe(false);
      expect(result.primary).toEqual({ provider: 'openai-main', model: 'gpt-4o-mini' });
      expect(result.fallback).toHaveLength(0);
    });

    it('uses "default" as default provider when not configured', () => {
      const resolver = new ModelResolver({ levels });
      const result = resolver.resolve('gpt-4o-mini');

      expect(result.primary).toEqual({ provider: 'default', model: 'gpt-4o-mini' });
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
