/**
 * Gateway 模型目录与 session 模型选择
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from '../src/integration/gateway/gateway.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';
import type { AgentDefinition } from '../src/harness/types/agent-definition.js';
import { InMemorySessionStore } from '../src/integration/storage/memory.js';

function makeProvider(name: string, models: string[], declaredWindow?: number): ModelProvider {
  return {
    name,
    defaultModel: models[0]!,
    getModelInfo: (m: string) =>
      models.includes(m)
        ? { name: m, contextWindow: declaredWindow }
        : null,
    getModelInfos: () => models.map(m => ({ name: m, contextWindow: declaredWindow })),
    isAvailable: async () => true,
    chat: async () => ({ content: '', model: models[0]!, finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  };
}

function makeAgent(id: string, provider: string, model: string, contextWindow?: number): AgentDefinition {
  return {
    id,
    home: '',
    workspace: '',
    persona: { name: id, description: '', systemPrompt: 'test' },
    tools: { allow: ['*'] },
    model: { provider, model, contextWindow },
  };
}

describe('Gateway model catalog & session model', () => {
  let gateway: Gateway;
  let store: InMemorySessionStore;

  beforeEach(async () => {
    store = new InMemorySessionStore();
    gateway = new Gateway(
      {
        agents: [makeAgent('assistant', 'openai', 'gpt-5-mini', 128000)],
        levels: {
          mini: { primary: 'openai/gpt-5-mini' },
        },
      },
      store,
    );
    gateway.registerProvider(makeProvider('openai', ['gpt-5.5', 'gpt-5-mini'], 100000));
    gateway.registerProvider(makeProvider('anthropic', ['claude-sonnet-4-6'])); // 无声明窗口
  });

  it('getModelCatalog：有声明 known=true；无声明 contextWindow=null', () => {
    const catalog = gateway.getModelCatalog();
    expect(catalog.agents).toEqual([
      { agentId: 'assistant', defaultModelId: 'openai/gpt-5-mini' },
    ]);

    const openai = catalog.models.find(m => m.id === 'openai/gpt-5.5');
    expect(openai?.contextWindow).toBe(100000);
    expect(openai?.known).toBe(true);

    const claude = catalog.models.find(m => m.id === 'anthropic/claude-sonnet-4-6');
    expect(claude?.contextWindow).toBeNull();
    expect(claude?.known).toBe(false);
  });

  it('agent 默认 explicit 窗口覆盖 catalog 中无能力条目', () => {
    // openai/gpt-5-mini 在 provider 声明 100000，agent 配置 128000
    const catalog = gateway.getModelCatalog();
    const hit = catalog.models.find(m => m.id === 'openai/gpt-5-mini');
    expect(hit?.contextWindow).toBe(128000);
    expect(hit?.known).toBe(true);
  });

  it('catalog 含无能力字段的纯字符串模型', () => {
    gateway.registerProvider(makeProvider('ollama', ['qwen3.5:2b'])); // declaredWindow undefined
    const catalog = gateway.getModelCatalog();
    const hit = catalog.models.find(m => m.id === 'ollama/qwen3.5:2b');
    expect(hit).toBeDefined();
    expect(hit!.contextWindow).toBeNull();
    expect(hit!.known).toBe(false);
  });

  it('setSessionModel 后 getSessionModel 返回 resolved 快照', async () => {
    const session = await gateway.createSession({ agentId: 'assistant' });
    const view = await gateway.setSessionModel(session.id, 'anthropic/claude-sonnet-4-6');
    expect(view.modelId).toBe('anthropic/claude-sonnet-4-6');
    expect(view.resolved?.contextWindow).toBeNull();
    expect(view.resolved?.known).toBe(false);
  });

  it('setSessionModel(null) 恢复 agent 默认', async () => {
    const session = await gateway.createSession({ agentId: 'assistant' });
    await gateway.setSessionModel(session.id, 'openai/gpt-5.5');
    const cleared = await gateway.setSessionModel(session.id, null);
    expect(cleared.modelId).toBeNull();
    expect(cleared.resolved?.id).toBe('openai/gpt-5-mini');
    // agent 配置的 explicit 窗口优先
    expect(cleared.resolved?.contextWindow).toBe(128000);
  });

  it('未知 provider 报错', async () => {
    const session = await gateway.createSession({ agentId: 'assistant' });
    await expect(gateway.setSessionModel(session.id, 'nope/gpt-x')).rejects.toThrow(/provider/i);
  });
});
