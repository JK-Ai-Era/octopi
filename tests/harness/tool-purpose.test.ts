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
      .model('mock/m')
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
    expect(echo?.parameters?.required?.filter((r) => r === 'purpose')).toHaveLength(1);
  });

  it('does not duplicate required purpose when the tool already declares purpose', async () => {
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
    const seen: Record<string, unknown>[] = [];
    const tool: RegisteredTool = {
      definition: {
        name: 'photo_capture',
        description: 'Take a photo',
        parameters: {
          purpose: { type: 'string', description: 'Why the photo is needed', required: true },
        },
      },
      handler: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    };

    const builder = new AgentBuilder()
      .model('mock/m')
      .memoryStore(new InMemoryMemoryStore())
      .tool(tool as never);

    const built = await builder.build({ mode: 'core' });
    const tools = (built.agent.context.tools ?? []) as Array<{
      name: string;
      parameters?: { required?: string[]; properties?: Record<string, unknown> };
      execute?: (id: string, args: unknown) => Promise<unknown>;
    }>;
    const photo = tools.find((t) => t.name === 'photo_capture');
    expect(photo).toBeTruthy();
    expect(photo?.parameters?.required?.filter((r) => r === 'purpose')).toHaveLength(1);
    // 统一装配：purpose 始终是 TOOL_PURPOSE_PARAM（同名同义），且只出现一次
    expect(photo?.parameters?.properties?.purpose).toMatchObject({ type: 'string' });

    await photo?.execute?.('c1', { purpose: 'identify the plant' });
    expect(seen).toHaveLength(1);
    // 工具自带 purpose 是业务入参（device 同意/审计），必须进 handler
    expect(seen[0]).toMatchObject({ purpose: 'identify the plant' });
  });

  it('buildToolLlmParameters always injects purpose once and first', async () => {
    const { buildToolLlmParameters } = await import('@octopi-agent/engine/harness/agent/tool-purpose.js');
    const schema = buildToolLlmParameters({
      purpose: { type: 'string', description: 'Why the photo is needed', required: true },
      path: { type: 'string', description: 'p', required: true },
    }) as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties?.purpose).toBeTruthy();
    expect(schema.required?.filter((r) => r === 'purpose')).toHaveLength(1);
    expect(schema.required).toContain('path');
    // 不重复 required 的坏 schema（部分兼容接口 400 Invalid request parameters）
    expect(new Set(schema.required).size).toBe(schema.required?.length);
    // purpose 置首，降低模型漏填
    expect(Object.keys(schema.properties ?? {})[0]).toBe('purpose');
    expect(schema.required?.[0]).toBe('purpose');
  });

  it('derives fallback purpose when model omits it instead of failing the call', async () => {
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
    const seen: Record<string, unknown>[] = [];
    const tool: RegisteredTool = {
      definition: {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          query: { type: 'string', description: 'q', required: true },
          limit: { type: 'number', description: 'n' },
        },
      },
      handler: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    };

    const builder = new AgentBuilder()
      .model('mock/m')
      .memoryStore(new InMemoryMemoryStore())
      .tool(tool as never);

    const built = await builder.build({ mode: 'core' });
    const tools = (built.agent.context.tools ?? []) as Array<{
      name: string;
      parameters?: { required?: string[] };
      execute?: (id: string, args: unknown) => Promise<{ content?: unknown; purpose?: string; isError?: boolean }>;
    }>;
    const ws = tools.find((t) => t.name === 'web_search');
    expect(ws?.parameters?.required).toContain('purpose');

    // 模型漏填 purpose：不得 purpose_required 中断
    const result = await ws?.execute?.('c1', { query: '周杰伦 回到过去 总谱', limit: 10 });
    expect(result?.isError).not.toBe(true);
    expect(result?.purpose).toContain('web_search');
    expect(result?.purpose).toContain('周杰伦');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ query: '周杰伦 回到过去 总谱' });
    expect(seen[0]).not.toHaveProperty('purpose');
  });

  it('strips injected purpose before handler when tool does not declare purpose', async () => {
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
    const seen: Record<string, unknown>[] = [];
    const tool: RegisteredTool = {
      definition: {
        name: 'echo_inject',
        description: 'echo',
        parameters: {
          text: { type: 'string', description: 'text', required: true },
        },
      },
      handler: async (args) => {
        seen.push(args);
        return { echoed: args.text };
      },
    };

    const builder = new AgentBuilder()
      .model('mock/m')
      .memoryStore(new InMemoryMemoryStore())
      .tool(tool as never);

    const built = await builder.build({ mode: 'core' });
    const tools = (built.agent.context.tools ?? []) as Array<{
      name: string;
      execute?: (id: string, args: unknown) => Promise<unknown>;
    }>;
    const echo = tools.find((t) => t.name === 'echo_inject');
    await echo?.execute?.('c1', { text: 'hi', purpose: 'test inject strip' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('purpose');
    expect(seen[0]).toMatchObject({ text: 'hi' });
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

describe('TOOL_PURPOSE_PARAM stub ↔ TOOL_PURPOSE_SYSTEM_NOTE（方案 S 防漂移）', () => {
  it('schema stub 极短、详版+示例只在全局说明', async () => {
    const { TOOL_PURPOSE_PARAM, TOOL_PURPOSE_SYSTEM_NOTE } =
      await import('@octopi-agent/engine/harness/agent/tool-purpose.js');
    // stub 只作兜底自解释，不应再重复详版（55×157 字符的重复文案已移入全局说明）
    expect(TOOL_PURPOSE_PARAM.description.length).toBeLessThan(60);
    // 详版要素齐全：动词+对象+目的、120 上限、示例、非空要求
    expect(TOOL_PURPOSE_SYSTEM_NOTE).toContain('verb + object + goal');
    expect(TOOL_PURPOSE_SYSTEM_NOTE).toContain('120');
    expect(TOOL_PURPOSE_SYSTEM_NOTE).toContain('overwrite src/a.ts to fix timeout');
    expect(TOOL_PURPOSE_SYSTEM_NOTE).toContain('purpose');
    expect(TOOL_PURPOSE_SYSTEM_NOTE).toContain('MUST');
  });

  it('wire schema 的 purpose description 就是 stub 本体', async () => {
    const { buildToolLlmParameters, TOOL_PURPOSE_PARAM } =
      await import('@octopi-agent/engine/harness/agent/tool-purpose.js');
    const schema = buildToolLlmParameters({
      path: { type: 'string', description: 'p', required: true },
    }) as { properties?: Record<string, { description?: string }> };
    expect(schema.properties?.purpose?.description).toBe(TOOL_PURPOSE_PARAM.description);
  });

  it('file_search 参数 desc 承载去重下沉的语义单元（防再丢失）', async () => {
    const { createFileSearchTool } =
      await import('@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-search.js');
    const params = createFileSearchTool().definition.parameters;
    // pattern：auto 正则触发面全集（anchors/转义类/转义元字符/.* .+/{n}）+ 字面反例
    expect(params.pattern.description).toContain('anchors');
    expect(params.pattern.description).toContain('\\w');
    expect(params.pattern.description).toContain('.+');
    expect(params.pattern.description).toContain('arr[0]');
    // glob：裸名任意深度（实现 globToPathRegex 归一化 `**/<glob>` 的契约）
    expect(params.glob.description).toContain('any depth');
    // pattern_mode：强制档入口
    expect(params.pattern_mode.description).toContain('force');
  });
});
