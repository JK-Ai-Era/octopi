/**
 * ModelInfo 测试
 *
 * 验证模型能力声明的配置解析、Provider 存储和查询。
 */

import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../src/integration/providers/openai.js';
import { AnthropicProvider } from '../src/integration/providers/anthropic.js';
import type { ModelInfo } from '../src/core/types.js';

describe('ModelInfo', () => {
  describe('OpenAIProvider', () => {
    it('models 为纯字符串时，getModelInfo 返回 null', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: ['gpt-5.5', 'gpt-5.5-mini'],
      });

      expect(provider.getModelInfo('gpt-5.5')).toBeNull();
      expect(provider.getModelInfo('gpt-5.5-mini')).toBeNull();
      expect(provider.getModelInfo('unknown')).toBeNull();
    });

    it('models 包含 ModelInfo 时，getModelInfo 返回对应信息', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: [
          'gpt-5.5',
          {
            name: 'gpt-5.5-mini',
            contextWindow: 128000,
            maxOutputTokens: 16384,
          },
        ],
      });

      expect(provider.models).toEqual(['gpt-5.5', 'gpt-5.5-mini']);

      // 纯字符串模型没有 ModelInfo
      expect(provider.getModelInfo('gpt-5.5')).toBeNull();

      // ModelInfo 模型有完整信息
      const info = provider.getModelInfo('gpt-5.5-mini');
      expect(info).not.toBeNull();
      expect(info!.name).toBe('gpt-5.5-mini');
      expect(info!.contextWindow).toBe(128000);
      expect(info!.maxOutputTokens).toBe(16384);
    });

    it('全部使用 ModelInfo 对象', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: [
          { name: 'gpt-5.5', contextWindow: 256000, maxOutputTokens: 32768 },
          { name: 'gpt-5.5-mini', contextWindow: 128000, maxOutputTokens: 16384 },
        ],
        defaultModel: 'gpt-5.5',
      });

      expect(provider.models).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
      expect(provider.getModelInfo('gpt-5.5')!.contextWindow).toBe(256000);
      expect(provider.getModelInfo('gpt-5.5-mini')!.maxOutputTokens).toBe(16384);
    });

    it('ModelInfo 字段可选，只填部分', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: [
          { name: 'gpt-5.5', contextWindow: 256000 },
        ],
      });

      const info = provider.getModelInfo('gpt-5.5');
      expect(info!.contextWindow).toBe(256000);
      expect(info!.maxOutputTokens).toBeUndefined();
    });
  });

  describe('AnthropicProvider', () => {
    it('models 包含 ModelInfo 时，getModelInfo 返回对应信息', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test',
        models: [
          'claude-sonnet-4-6',
          {
            name: 'claude-opus-4-6',
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        ],
      });

      expect(provider.models).toEqual(['claude-sonnet-4-6', 'claude-opus-4-6']);
      expect(provider.getModelInfo('claude-sonnet-4-6')).toBeNull();

      const info = provider.getModelInfo('claude-opus-4-6');
      expect(info).not.toBeNull();
      expect(info!.contextWindow).toBe(200000);
      expect(info!.maxOutputTokens).toBe(8192);
    });
  });

  describe('向后兼容', () => {
    it('纯字符串数组配置仍然正常工作', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: ['gpt-5.5'],
      });

      expect(provider.models).toEqual(['gpt-5.5']);
      expect(provider.getModelInfo('gpt-5.5')).toBeNull();
    });

    it('不配置 models 时使用默认值', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
      });

      expect(provider.models.length).toBeGreaterThan(0);
      for (const model of provider.models) {
        expect(provider.getModelInfo(model)).toBeNull();
      }
    });
  });
});
