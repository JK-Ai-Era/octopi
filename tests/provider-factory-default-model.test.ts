/**
 * createProviderFromConfig 的 defaultModel 语义（F3-a 统一 provider 工厂的等价性锚点）
 *
 * 背景：被删除的 daemon 旧工厂不传 defaultModel（靠构造器 `models[0]` 回退），
 * 统一后的工厂显式传 `pc.models[0]?.name ?? pc.models[0]?.id`。两者必须同值——
 * core loop 每次调用都显式透传 `model.defaultModel`（call-model.ts），
 * 漂移会直接改变请求路由的模型。
 */
import { describe, it, expect } from 'vitest';
import { createProviderFromConfig } from '@octopi-agent/engine/config.js';
import type { ModelProviderConfig } from '@octopi-agent/engine/config.js';

function providerConfig(models: ModelProviderConfig['models']): ModelProviderConfig {
  return {
    api: 'openai-completions',
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:1', // 不发起网络请求（仅构造）
    models,
  };
}

describe('createProviderFromConfig defaultModel', () => {
  it('显式传 models[0].name（与构造器 models[0] 回退同值）', async () => {
    const provider = await createProviderFromConfig(
      'p',
      providerConfig([{ id: 'id-a', name: 'gpt-4o' }, { id: 'id-b' }]),
    );
    expect(provider.defaultModel).toBe('gpt-4o');
  });

  it('无 name 时回退 models[0].id', async () => {
    const provider = await createProviderFromConfig(
      'p',
      providerConfig([{ id: 'id-a' }]),
    );
    expect(provider.defaultModel).toBe('id-a');
  });

  it('计时装饰器透传 defaultModel 不丢', async () => {
    // 探针装饰链在最外层；defaultModel 若被装饰器吞掉，core loop 会路由到 undefined
    const provider = await createProviderFromConfig(
      'p',
      providerConfig([{ id: 'id-x', name: 'm1' }]),
    );
    expect(provider.defaultModel).toBe('m1');
    expect(typeof provider.chat).toBe('function');
    expect(typeof provider.stream).toBe('function');
  });
});
