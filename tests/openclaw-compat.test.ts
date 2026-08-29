/**
 * OpenClaw Plugin 兼容性测试
 *
 * 模拟 OpenClaw 官方插件的 API 使用模式，验证我们的 PluginApi 能正确支持。
 * 由于 OpenClaw 插件是编译后的 bundle，我们提取其 register() 逻辑来测试。
 *
 * 测试的插件模式：
 * 1. DuckDuckGo — registerWebSearchProvider
 * 2. Moonshot — registerWebSearchProvider + registerMediaUnderstandingProvider
 * 3. LMStudio — registerProvider + registerMemoryEmbeddingProvider
 * 4. OpenRouter — registerProvider + registerMediaUnderstanding + registerImageGeneration + registerModelCatalog + registerSpeech + registerMusic + registerVideo
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { PluginApi } from '../src/harness/plugin-ecosystem/plugins/api.js';
import { PluginManager } from '../src/harness/plugin-ecosystem/plugins/manager.js';
import { definePluginEntry } from '../src/harness/plugin-ecosystem/plugins/entry.js';
import type { LoadedPlugin } from '../src/harness/plugin-ecosystem/plugins/loader.js';

// ─────────────────────────────────────────────
// 模拟 OpenClaw 插件的 register 逻辑
// ─────────────────────────────────────────────

/**
 * 模拟 DuckDuckGo 插件 — 最简单的插件，只注册一个 web search provider
 *
 * OpenClaw 原始代码：
 * ```js
 * api.registerWebSearchProvider(createDuckDuckGoWebSearchProvider());
 * ```
 */
function createMockDuckDuckGoPlugin() {
  return definePluginEntry({
    id: 'duckduckgo',
    name: 'DuckDuckGo Plugin',
    description: 'Bundled DuckDuckGo web search plugin',
    register(api) {
      // 模拟 createDuckDuckGoWebSearchProvider() 返回的对象
      const searchProvider = {
        id: 'duckduckgo',
        name: 'DuckDuckGo',
        async search(query: string, options?: { region?: string; safeSearch?: string }) {
          return {
            results: [
              { title: `Result for: ${query}`, url: `https://example.com?q=${query}`, snippet: 'Test result' },
            ],
            provider: 'duckduckgo',
          };
        },
      };
      api.registerWebSearchProvider(searchProvider);
    },
  });
}

/**
 * 模拟 Moonshot 插件 — 注册 web search + media understanding
 *
 * OpenClaw 原始代码：
 * ```js
 * api.registerWebSearchProvider(createMoonshotWebSearchProvider(...));
 * api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
 * ```
 */
function createMockMoonshotPlugin() {
  return definePluginEntry({
    id: 'moonshot',
    name: 'Moonshot Plugin',
    description: 'Moonshot AI web search and media understanding plugin',
    register(api) {
      // 模拟 web search provider
      api.registerWebSearchProvider({
        id: 'moonshot',
        name: 'Moonshot Search',
        async search(query: string) {
          return {
            results: [
              { title: `Moonshot: ${query}`, url: `https://moonshot.cn?q=${query}`, snippet: 'Moonshot result' },
            ],
            provider: 'moonshot',
          };
        },
      });

      // 模拟 media understanding provider
      api.registerMediaUnderstandingProvider({
        id: 'moonshot',
        name: 'Moonshot Vision',
        models: ['moonshot-v1-8k-vision'],
        supportsModel: (model: string) => model.startsWith('moonshot-'),
        async understand(input: { image: string; prompt: string }) {
          return { description: `Moonshot analyzed: ${input.prompt}` };
        },
      });
    },
  });
}

/**
 * 模拟 LMStudio 插件 — 注册 LLM provider + memory embedding
 *
 * OpenClaw 原始代码：
 * ```js
 * api.registerProvider({ id: PROVIDER_ID, provider: createLmstudioProvider(config) });
 * api.registerMemoryEmbeddingProvider(createLmstudioMemoryEmbeddingProvider(config));
 * ```
 */
function createMockLMStudioPlugin() {
  return definePluginEntry({
    id: 'lmstudio',
    name: 'LM Studio Plugin',
    description: 'LM Studio local inference plugin',
    register(api) {
      // 模拟 LLM provider
      api.registerProvider({
        id: 'lmstudio',
        provider: {
          name: 'lmstudio',
          models: ['local-model-7b', 'local-model-13b'],
          supportsModel: (model: string) => model.startsWith('local-model-'),
          async complete(request: any) {
            return {
              content: `LMStudio completed: ${request.messages?.[request.messages.length - 1]?.content ?? ''}`,
              model: request.model,
              usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            };
          },
        },
      });

      // 模拟 memory embedding provider
      api.registerMemoryEmbeddingProvider({
        id: 'lmstudio',
        name: 'LM Studio Embeddings',
        models: ['nomic-embed-text-v1'],
        async embed(text: string) {
          // 返回模拟的向量
          return new Array(384).fill(0).map(() => Math.random());
        },
      });
    },
  });
}

/**
 * 模拟 OpenRouter 插件 — 最复杂，注册多种 provider
 *
 * OpenClaw 原始代码：
 * ```js
 * api.registerProvider({ id: PROVIDER_ID, provider: createOpenRouterProvider(config) });
 * api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
 * api.registerImageGenerationProvider(buildOpenRouterImageGenerationProvider());
 * api.registerMusicGenerationProvider(buildOpenRouterMusicGenerationProvider());
 * api.registerVideoGenerationProvider(buildOpenRouterVideoGenerationProvider());
 * api.registerModelCatalogProvider({ provider: PROVIDER_ID, kinds: ['video_generation'], liveCatalog: ... });
 * api.registerSpeechProvider(buildOpenRouterSpeechProvider());
 * ```
 */
function createMockOpenRouterPlugin() {
  return definePluginEntry({
    id: 'openrouter',
    name: 'OpenRouter Plugin',
    description: 'OpenRouter multi-provider gateway plugin',
    register(api) {
      // LLM provider
      api.registerProvider({
        id: 'openrouter',
        provider: {
          name: 'openrouter',
          models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'meta-llama/llama-3.1-405b'],
          supportsModel: (model: string) => model.includes('/'),
          async complete(request: any) {
            return {
              content: `OpenRouter (${request.model}): completed`,
              model: request.model,
              usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            };
          },
        },
      });

      // Media understanding
      api.registerMediaUnderstandingProvider({
        id: 'openrouter',
        name: 'OpenRouter Vision',
        models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o'],
        supportsModel: (model: string) => model.includes('/'),
        async understand(input: any) {
          return { description: `OpenRouter analyzed image with ${input.prompt}` };
        },
      });

      // Image generation
      api.registerImageGenerationProvider({
        id: 'openrouter',
        name: 'OpenRouter Image Gen',
        models: ['dall-e-3', 'stable-diffusion-xl'],
        async generate(prompt: string) {
          return { url: `https://openrouter.ai/images/${encodeURIComponent(prompt)}.png` };
        },
      });

      // Music generation
      api.registerMusicGenerationProvider({
        id: 'openrouter',
        name: 'OpenRouter Music',
        async generate(prompt: string) {
          return { url: `https://openrouter.ai/music/${encodeURIComponent(prompt)}.mp3` };
        },
      });

      // Video generation
      api.registerVideoGenerationProvider({
        id: 'openrouter',
        name: 'OpenRouter Video',
        async generate(prompt: string) {
          return { url: `https://openrouter.ai/video/${encodeURIComponent(prompt)}.mp4` };
        },
      });

      // Model catalog
      api.registerModelCatalogProvider({
        provider: 'openrouter',
        kinds: ['video_generation'],
        liveCatalog: async () => [
          { id: 'runway/gen-3', name: 'Runway Gen-3', kind: 'video_generation' },
        ],
      });

      // Speech
      api.registerSpeechProvider({
        id: 'openrouter',
        name: 'OpenRouter TTS',
        models: ['openai/tts-1'],
        async speak(text: string) {
          return { audio: Buffer.from('fake-audio'), format: 'mp3' };
        },
      });
    },
  });
}

// ─────────────────────────────────────────────
// Helper: 创建 PluginManager 并注入模拟插件
// ─────────────────────────────────────────────

function createPluginManagerWithMockPlugins(
  pluginDefs: ReturnType<typeof definePluginEntry>[],
): PluginManager {
  const pm = new PluginManager({ loadPaths: [] });

  const loadedPlugins: LoadedPlugin[] = pluginDefs.map((def) => {
    const api = new PluginApi({
      id: def.id,
      name: def.name ?? def.id,
      source: `test:${def.id}`,
      pluginConfig: {},
    });
    def.register(api);
    return {
      id: def.id,
      manifest: { id: def.id, configSchema: {} },
      definition: def,
      api,
      registered: true,
      source: `test:${def.id}`,
    };
  });

  const pluginMap = new Map<string, LoadedPlugin>();
  for (const p of loadedPlugins) {
    pluginMap.set(p.id, p);
  }
  (pm as any).loader.plugins = pluginMap;

  return pm;
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('OpenClaw Plugin 兼容性', () => {

  // ================================================================
  // 1. DuckDuckGo — 最简插件模式
  // ================================================================

  describe('DuckDuckGo 模式（registerWebSearchProvider）', () => {
    test('通过 PluginManager 注册并获取 web search provider', () => {
      const plugin = createMockDuckDuckGoPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      expect(pm.getRegisteredIds()).toContain('duckduckgo');

      const providers = pm.getWebSearchProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].pluginId).toBe('duckduckgo');
      expect((providers[0].provider as any).id).toBe('duckduckgo');
    });

    test('web search provider 可以执行搜索', async () => {
      const plugin = createMockDuckDuckGoPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const providers = pm.getWebSearchProviders();
      const searchProvider = providers[0].provider as any;

      const result = await searchProvider.search('hello world');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toContain('hello world');
      expect(result.provider).toBe('duckduckgo');
    });
  });

  // ================================================================
  // 2. Moonshot — 双能力注册模式
  // ================================================================

  describe('Moonshot 模式（web search + media understanding）', () => {
    test('通过 PluginManager 注册两种能力', () => {
      const plugin = createMockMoonshotPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      expect(pm.getRegisteredIds()).toContain('moonshot');

      const searchProviders = pm.getWebSearchProviders();
      expect(searchProviders).toHaveLength(1);
      expect(searchProviders[0].pluginId).toBe('moonshot');

      const mediaProviders = pm.getMediaUnderstandingProviders();
      expect(mediaProviders).toHaveLength(1);
      expect(mediaProviders[0].pluginId).toBe('moonshot');
    });

    test('web search provider 功能正常', async () => {
      const plugin = createMockMoonshotPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const searchProvider = pm.getWebSearchProviders()[0].provider as any;
      const result = await searchProvider.search('test query');
      expect(result.provider).toBe('moonshot');
      expect(result.results[0].title).toContain('Moonshot');
    });

    test('media understanding provider 功能正常', async () => {
      const plugin = createMockMoonshotPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const mediaProvider = pm.getMediaUnderstandingProviders()[0].provider as any;
      expect(mediaProvider.supportsModel('moonshot-v1-8k-vision')).toBe(true);
      expect(mediaProvider.supportsModel('gpt-4o')).toBe(false);

      const result = await mediaProvider.understand({ image: 'test.jpg', prompt: 'describe' });
      expect(result.description).toContain('Moonshot analyzed');
    });
  });

  // ================================================================
  // 3. LMStudio — LLM Provider + Memory Embedding 模式
  // ================================================================

  describe('LMStudio 模式（LLM provider + memory embedding）', () => {
    test('通过 PluginManager 注册 LLM provider', () => {
      const plugin = createMockLMStudioPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      expect(pm.getRegisteredIds()).toContain('lmstudio');

      const providers = pm.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('lmstudio');
      expect(providers[0].provider.name).toBe('lmstudio');
    });

    test('LLM provider 模型匹配', () => {
      const plugin = createMockLMStudioPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const provider = pm.getProviders()[0].provider;
      expect(provider.supportsModel('local-model-7b')).toBe(true);
      expect(provider.supportsModel('local-model-13b')).toBe(true);
      expect(provider.supportsModel('gpt-4o')).toBe(false);
    });

    test('LLM provider 可以执行推理', async () => {
      const plugin = createMockLMStudioPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const provider = pm.getProviders()[0].provider;
      const result = await provider.complete({
        model: 'local-model-7b',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(result.content).toContain('LMStudio completed');
      expect(result.model).toBe('local-model-7b');
      expect(result.usage.totalTokens).toBe(30);
    });

    test('memory embedding provider 可以生成向量', async () => {
      const plugin = createMockLMStudioPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const plugin_ = pm.getPlugin('lmstudio')!;
      const embeddingProvider = plugin_.api._memoryEmbeddingProviders[0].provider as any;

      expect(embeddingProvider.id).toBe('lmstudio');
      expect(embeddingProvider.models).toContain('nomic-embed-text-v1');

      const embedding = await embeddingProvider.embed('test text');
      expect(embedding).toHaveLength(384);
      expect(embedding.every((v: number) => v >= 0 && v <= 1)).toBe(true);
    });
  });

  // ================================================================
  // 4. OpenRouter — 最复杂的多能力插件
  // ================================================================

  describe('OpenRouter 模式（全能力注册）', () => {
    test('通过 PluginManager 注册所有能力类型', () => {
      const plugin = createMockOpenRouterPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      expect(pm.getRegisteredIds()).toContain('openrouter');

      // LLM provider
      expect(pm.getProviders()).toHaveLength(1);
      expect(pm.getProviders()[0].id).toBe('openrouter');

      // Media understanding
      expect(pm.getMediaUnderstandingProviders()).toHaveLength(1);

      // Image generation
      expect(pm.getImageGenerationProviders()).toHaveLength(1);

      // Model catalog
      expect(pm.getModelCatalogProviders()).toHaveLength(1);
      expect(pm.getModelCatalogProviders()[0].kinds).toContain('video_generation');

      // Plugin 内部存储
      const plugin_ = pm.getPlugin('openrouter')!;
      expect(plugin_.api._musicGenerationProviders).toHaveLength(1);
      expect(plugin_.api._videoGenerationProviders).toHaveLength(1);
      expect(plugin_.api._speechProviders).toHaveLength(1);
    });

    test('LLM provider 支持多种模型', () => {
      const plugin = createMockOpenRouterPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const provider = pm.getProviders()[0].provider;
      expect(provider.supportsModel('anthropic/claude-3.5-sonnet')).toBe(true);
      expect(provider.supportsModel('openai/gpt-4o')).toBe(true);
      expect(provider.supportsModel('meta-llama/llama-3.1-405b')).toBe(true);
      expect(provider.supportsModel('gpt-4o')).toBe(false); // 不含 '/'
    });

    test('LLM provider 可以执行推理', async () => {
      const plugin = createMockOpenRouterPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const provider = pm.getProviders()[0].provider;
      const result = await provider.complete({
        model: 'anthropic/claude-3.5-sonnet',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(result.content).toContain('OpenRouter');
      expect(result.model).toBe('anthropic/claude-3.5-sonnet');
    });

    test('media understanding provider 功能正常', async () => {
      const plugin = createMockOpenRouterPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const mediaProvider = pm.getMediaUnderstandingProviders()[0].provider as any;
      expect(mediaProvider.supportsModel('anthropic/claude-3.5-sonnet')).toBe(true);
      expect(mediaProvider.supportsModel('local-model')).toBe(false);

      const result = await mediaProvider.understand({ image: 'test.jpg', prompt: 'what is this?' });
      expect(result.description).toContain('OpenRouter analyzed');
    });

    test('image generation provider 功能正常', async () => {
      const plugin = createMockOpenRouterPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const imgProvider = pm.getImageGenerationProviders()[0].provider as any;
      const result = await imgProvider.generate('a cat wearing a hat');
      expect(result.url).toContain('openrouter.ai/images');
      expect(result.url).toContain('a%20cat');
    });

    test('model catalog provider 返回正确的 catalog', async () => {
      const plugin = createMockOpenRouterPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const catalog = pm.getModelCatalogProviders()[0];
      expect(catalog.provider).toBe('openrouter');
      expect(catalog.kinds).toContain('video_generation');

      const catalogFn = catalog.liveCatalog as () => Promise<any[]>;
      const models = await catalogFn();
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('runway/gen-3');
    });

    test('speech provider 功能正常', async () => {
      const plugin = createMockOpenRouterPlugin();
      const pm = createPluginManagerWithMockPlugins([plugin]);

      const plugin_ = pm.getPlugin('openrouter')!;
      const speechProvider = plugin_.api._speechProviders[0].provider as any;

      expect(speechProvider.id).toBe('openrouter');
      expect(speechProvider.models).toContain('openai/tts-1');

      const result = await speechProvider.speak('hello world');
      expect(result.format).toBe('mp3');
    });
  });

  // ================================================================
  // 5. 多插件共存
  // ================================================================

  describe('多插件共存', () => {
    test('所有 4 个插件同时注册', () => {
      const plugins = [
        createMockDuckDuckGoPlugin(),
        createMockMoonshotPlugin(),
        createMockLMStudioPlugin(),
        createMockOpenRouterPlugin(),
      ];

      const pm = createPluginManagerWithMockPlugins(plugins);

      expect(pm.getRegisteredIds()).toHaveLength(4);
      expect(pm.getRegisteredIds()).toContain('duckduckgo');
      expect(pm.getRegisteredIds()).toContain('moonshot');
      expect(pm.getRegisteredIds()).toContain('lmstudio');
      expect(pm.getRegisteredIds()).toContain('openrouter');
    });

    test('多个 web search provider 共存', () => {
      const plugins = [
        createMockDuckDuckGoPlugin(),
        createMockMoonshotPlugin(),
        createMockOpenRouterPlugin(),
      ];

      const pm = createPluginManagerWithMockPlugins(plugins);

      const searchProviders = pm.getWebSearchProviders();
      expect(searchProviders).toHaveLength(2); // duckduckgo + moonshot
      expect(searchProviders.map((p) => p.pluginId)).toContain('duckduckgo');
      expect(searchProviders.map((p) => p.pluginId)).toContain('moonshot');
    });

    test('多个 LLM provider 共存', () => {
      const plugins = [
        createMockLMStudioPlugin(),
        createMockOpenRouterPlugin(),
      ];

      const pm = createPluginManagerWithMockPlugins(plugins);

      const providers = pm.getProviders();
      expect(providers).toHaveLength(2);
      expect(providers.map((p) => p.id)).toContain('lmstudio');
      expect(providers.map((p) => p.id)).toContain('openrouter');
    });

    test('每个插件的 provider 独立工作', async () => {
      const plugins = [
        createMockLMStudioPlugin(),
        createMockOpenRouterPlugin(),
      ];

      const pm = createPluginManagerWithMockPlugins(plugins);

      const providers = pm.getProviders();

      // LMStudio
      const lmstudio = providers.find((p) => p.id === 'lmstudio')!;
      expect(lmstudio.provider.supportsModel('local-model-7b')).toBe(true);
      expect(lmstudio.provider.supportsModel('anthropic/claude-3.5-sonnet')).toBe(false);

      // OpenRouter
      const openrouter = providers.find((p) => p.id === 'openrouter')!;
      expect(openrouter.provider.supportsModel('anthropic/claude-3.5-sonnet')).toBe(true);
      expect(openrouter.provider.supportsModel('local-model-7b')).toBe(false);
    });
  });

  // ================================================================
  // 6. PluginManager 生命周期集成
  // ================================================================

  describe('生命周期集成', () => {
    test('所有插件在 gateway_start 时正常初始化', async () => {
      const plugins = [
        createMockDuckDuckGoPlugin(),
        createMockMoonshotPlugin(),
        createMockLMStudioPlugin(),
        createMockOpenRouterPlugin(),
      ];

      const pm = createPluginManagerWithMockPlugins(plugins);

      // gateway_start 不应抛出异常
      await pm.onGatewayStart();
    });

    test('插件注册后 PluginManager 的 API 查询一致', () => {
      const plugins = [
        createMockDuckDuckGoPlugin(),
        createMockMoonshotPlugin(),
        createMockLMStudioPlugin(),
        createMockOpenRouterPlugin(),
      ];

      const pm = createPluginManagerWithMockPlugins(plugins);

      // 一致性检查
      expect(pm.getProviders()).toHaveLength(2); // lmstudio + openrouter
      expect(pm.getWebSearchProviders()).toHaveLength(2); // duckduckgo + moonshot
      expect(pm.getMediaUnderstandingProviders()).toHaveLength(2); // moonshot + openrouter
      expect(pm.getImageGenerationProviders()).toHaveLength(1); // openrouter
      expect(pm.getModelCatalogProviders()).toHaveLength(1); // openrouter
    });
  });
});
