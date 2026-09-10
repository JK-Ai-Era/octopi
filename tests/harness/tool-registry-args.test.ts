import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/harness/plugin-ecosystem/tools/registry.js';

function createRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: 'format_text',
      description: '格式化文本',
      parameters: {
        content: { type: 'string', description: 'text', required: true, minLength: 1, maxLength: 4, pattern: '^[a-z]+$' },
        level: { type: 'number', description: 'level', minimum: 1, maximum: 3 },
        mode: { type: 'string', description: 'mode', enum: ['fast', 'safe'] },
        tags: { type: 'array', description: 'tags', items: { type: 'string', description: 'tag' }, minItems: 1, maxItems: 2 },
        meta: {
          type: 'object',
          description: 'meta',
          properties: {
            key: { type: 'string', description: 'key', required: true },
          },
        },
      },
    },
    handler: async () => 'ok',
  });

  return registry;
}

describe('ToolRegistry 参数校验', () => {
  it('缺少必填参数时抛出错误', async () => {
    const registry = createRegistry();
    await expect(
      registry.execute('format_text', {}, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('missing required parameter');
  });

  it('参数类型不匹配时抛出错误', async () => {
    const registry = createRegistry();
    await expect(
      registry.execute('format_text', { content: 123, mode: 'fast' }, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('must be string');
  });

  it('枚举值不合法时抛出错误', async () => {
    const registry = createRegistry();
    await expect(
      registry.execute('format_text', { content: 'abc', mode: 'unknown' }, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('must be one of');
  });

  it('数值范围不合法时抛出错误', async () => {
    const registry = createRegistry();
    await expect(
      registry.execute('format_text', { content: 'abc', level: 9 }, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('must be <= 3');
  });

  it('字符串长度不合法时抛出错误', async () => {
    const registry = createRegistry();
    await expect(
      registry.execute('format_text', { content: 'abcde' }, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('length must be <= 4');
  });

  it('正则不匹配时抛出错误', async () => {
    const registry = createRegistry();
    await expect(
      registry.execute('format_text', { content: 'ABC' }, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('must match pattern');
  });

  it('数组数量不满足约束时抛出错误', async () => {
    const registry = createRegistry();
    await expect(
      registry.execute('format_text', { content: 'abc', tags: [] }, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('must have >= 1 items');
  });

  it('嵌套对象必填字段缺失时抛出错误', async () => {
    const registry = createRegistry();
    await expect(
      registry.execute('format_text', { content: 'abc', meta: {} }, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('nested parameter "meta.key" is required');
  });

  it('参数合法时正常执行', async () => {
    const registry = createRegistry();
    const result = await registry.execute(
      'format_text',
      { content: 'abc', level: 2, mode: 'fast', tags: ['x'], meta: { key: 'k' } },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );
    expect(result).toBe('ok');
  });
});
