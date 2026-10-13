/**
 * tool call purpose — 统一注入 / 剥离 / 拒绝空 purpose
 */
import { describe, it, expect } from 'vitest';

import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';
import type { RegisteredTool } from '@octopi-agent/core/types.js';

// 通过 builder 内部 convert 不可直接 import；用 AgentBuilder 装配最小工具验证端到端参数面
// 这里直接测行为约定：purpose 必填语义由 convertToAgentTool 执行路径保证。

describe('tool purpose contract', () => {
  it('registers purpose on converted tool parameters via builder tool surface', async () => {
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
    const tool: RegisteredTool = {
      definition: {
        name: 'echo_test',
        description: 'echo',
        parameters: {
          text: { type: 'string', description: 'text', required: true },
        },
      },
      handler: async (args) => ({ echoed: args.text }),
    };

    const builder = new AgentBuilder()
      .model({ provider: 'mock', model: 'm' })
      .memoryStore(new InMemoryMemoryStore())
      .tool(tool as never);

    // build core 仅装配工具面
    const built = await builder.build({ mode: 'core' });
    const tools = (built.agent.context.tools ?? []) as Array<{
      name: string;
      parameters?: { required?: string[]; properties?: Record<string, unknown> };
    }>;
    const echo = tools.find((t) => t.name === 'echo_test');
    expect(echo).toBeTruthy();
    expect(echo?.parameters?.properties).toHaveProperty('purpose');
    expect(echo?.parameters?.required).toContain('purpose');
  });
});


describe('LLM tool schema sanitization', () => {
  it('does not leak maxLength to provider tool parameters', async () => {
    // 通过 OpenAI provider 构造请求体验证净化（buildRequestBody 为 private，用 JSON 往返近似）
    const { OpenAIProvider } = await import('@octopi-agent/engine/integration/providers/openai.js');
    const provider = new OpenAIProvider({ name: 't', apiKey: 'x', baseUrl: 'http://127.0.0.1:1' });
    // 直接调内部：用 any 访问 buildRequestBody
    const body = (provider as unknown as {
      buildRequestBody: (req: unknown) => { tools?: Array<{ function?: { parameters?: unknown } }> };
    }).buildRequestBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 't1',
            description: 'd',
            parameters: {
              type: 'object',
              properties: {
                purpose: { type: 'string', description: 'p', maxLength: 120 },
                path: { type: 'string', description: 'p', minLength: 1 },
              },
              required: ['purpose'],
            },
          },
        },
      ],
    });
    const params = body.tools?.[0]?.function?.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(params?.properties?.purpose).not.toHaveProperty('maxLength');
    expect(params?.properties?.path).not.toHaveProperty('minLength');
  });
});
