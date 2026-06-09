/**
 * ModelInfo 测试
 *
 * 验证模型能力声明的配置解析、Provider 存储、查询和内置默认值。
 */

import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../src/integration/providers/openai.js';
import { AnthropicProvider } from '../src/integration/providers/anthropic.js';
import type { ModelInfo } from '../src/core/types.js';

describe('ModelInfo', () => {
  describe('OpenAIProvider', () => {
    it('纯字符串模型自动获取内置 ModelInfo', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: ['gpt-5.5', 'gpt-5.5-mini'],
      });

      expect(provider.models).toEqual(['gpt-5.5', 'gpt-5.5-mini']);

      const info55 = provider.getModelInfo('gpt-5.5');
      expect(info55).not.toBeNull();
      expect(info55!.contextWindow).toBe(256000);
      expect(info55!.maxOutputTokens).toBe(32768);

      const infoMini = provider.getModelInfo('gpt-5.5-mini');
      expect(infoMini).not.toBeNull();
      expect(infoMini!.contextWindow).toBe(128000);
    });

    it('未知模型返回 null', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: ['gpt-5.5'],
      });
      expect(provider.getModelInfo('unknown-model')).toBeNull();
    });

    it('用户 ModelInfo 优先于内置默认值', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: [
          'gpt-5.5',
          {
            name: 'gpt-5.5-mini',
            contextWindow: 99999,
            maxOutputTokens: 1234,
          },
        ],
      });

      // gpt-5.5-mini 用户配置优先
      const info = provider.getModelInfo('gpt-5.5-mini');
      expect(info!.contextWindow).toBe(99999);
      expect(info!.maxOutputTokens).toBe(1234);
    });

    it('用户 ModelInfo 部分字段 + 内置补全', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: [
          { name: 'gpt-5.5', contextWindow: 500000 },
        ],
      });

      const info = provider.getModelInfo('gpt-5.5');
      expect(info!.contextWindow).toBe(500000); // 用户值
      expect(info!.maxOutputTokens).toBe(32768); // 内置补全
    });
  });

  describe('AnthropicProvider', () => {
    it('纯字符串模型自动获取内置 ModelInfo', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test',
        models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
      });

      expect(provider.models).toEqual(['claude-sonnet-4-6', 'claude-opus-4-6']);

      const info = provider.getModelInfo('claude-sonnet-4-6');
      expect(info).not.toBeNull();
      expect(info!.contextWindow).toBe(200000);
      expect(info!.maxOutputTokens).toBe(16000);
    });

    it('用户 ModelInfo 优先于内置', () => {
      const provider = new AnthropicProvider({
        apiKey: 'test',
        models: [
          'claude-sonnet-4-6',
          {
            name: 'claude-opus-4-6',
            contextWindow: 500000,
            maxOutputTokens: 64000,
          },
        ],
      });

      const info = provider.getModelInfo('claude-opus-4-6');
      expect(info!.contextWindow).toBe(500000);
      expect(info!.maxOutputTokens).toBe(64000);
    });
  });

  describe('向后兼容', () => {
    it('纯字符串数组仍然工作（且获得内置信息）', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
        models: ['gpt-4o'],
      });

      expect(provider.models).toEqual(['gpt-4o']);
      expect(provider.getModelInfo('gpt-4o')).not.toBeNull();
    });

    it('不配置 models 时使用默认值（且获得内置信息）', () => {
      const provider = new OpenAIProvider({
        apiKey: 'test',
      });

      expect(provider.models.length).toBeGreaterThan(0);
      for (const model of provider.models) {
        // 默认模型都有内置信息
        expect(provider.getModelInfo(model)).not.toBeNull();
      }
    });
  });
});
