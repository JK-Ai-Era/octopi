/**
 * Tool 版本管理测试
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { VersionedToolRegistry } from '../src/harness/tools/versioning.js';
import type { VersionedTool } from '../src/harness/tools/versioning.js';

function createTool(overrides?: Partial<VersionedTool>): VersionedTool {
  return {
    definition: {
      name: 'test-tool',
      description: 'A test tool',
      parameters: {},
    },
    handler: vi.fn().mockResolvedValue({ success: true }),
    version: '1.0.0',
    ...overrides,
  };
}

describe('VersionedToolRegistry', () => {
  let registry: VersionedToolRegistry;

  beforeEach(() => {
    registry = new VersionedToolRegistry();
  });

  describe('基本注册和获取', () => {
    test('注册并获取工具', () => {
      const tool = createTool();
      registry.register(tool);
      expect(registry.get('test-tool')).toBe(tool);
    });

    test('获取不存在的工具返回 undefined', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    test('列出所有工具', () => {
      registry.register(createTool({ definition: { name: 'tool-a', description: '', parameters: {} } }));
      registry.register(createTool({ definition: { name: 'tool-b', description: '', parameters: {} } }));
      expect(registry.list()).toHaveLength(2);
    });
  });

  describe('版本管理', () => {
    test('存储版本历史', () => {
      const v1 = createTool({ version: '1.0.0' });
      const v2 = createTool({ version: '2.0.0' });

      registry.register(v1);
      registry.register(v2);

      expect(registry.getVersion('test-tool', '1.0.0')).toBe(v1);
      expect(registry.getVersion('test-tool', '2.0.0')).toBe(v2);
    });

    test('获取指定版本的工具', () => {
      const v1 = createTool({ version: '1.0.0' });
      registry.register(v1);

      expect(registry.getVersion('test-tool', '1.0.0')).toBe(v1);
      expect(registry.getVersion('test-tool', '2.0.0')).toBeUndefined();
    });
  });

  describe('废弃警告', () => {
    test('废弃工具触发警告', async () => {
      const tool = createTool({
        deprecated: true,
        deprecatedMessage: 'Use new-tool instead',
      });

      registry.register(tool);
      await registry.execute('test-tool', {}, { timeoutMs: 1000 });

      const warnings = registry.getDeprecationWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toBe('Use new-tool instead');
    });

    test('不重复记录相同警告', async () => {
      const tool = createTool({ deprecated: true });

      registry.register(tool);
      await registry.execute('test-tool', {}, { timeoutMs: 1000 });
      await registry.execute('test-tool', {}, { timeoutMs: 1000 });

      expect(registry.getDeprecationWarnings()).toHaveLength(1);
    });

    test('清除警告', async () => {
      const tool = createTool({ deprecated: true });

      registry.register(tool);
      await registry.execute('test-tool', {}, { timeoutMs: 1000 });
      registry.clearDeprecationWarnings();

      expect(registry.getDeprecationWarnings()).toHaveLength(0);
    });
  });

  describe('版本适配', () => {
    test('请求旧版本时调用适配函数', async () => {
      const adaptCall = vi.fn().mockReturnValue({ adapted: true });
      const tool = createTool({
        version: '2.0.0',
        adaptCall,
      });

      registry.register(tool);
      await registry.execute('test-tool', { old: 'format' }, { timeoutMs: 1000 }, '1.0.0');

      expect(adaptCall).toHaveBeenCalledWith('1.0.0', { old: 'format' });
      expect(tool.handler).toHaveBeenCalledWith({ adapted: true }, expect.any(Object));
    });

    test('版本适配触发警告', async () => {
      const tool = createTool({
        version: '2.0.0',
        adaptCall: vi.fn().mockReturnValue({}),
        migrationGuide: 'See docs/migration.md',
      });

      registry.register(tool);
      await registry.execute('test-tool', {}, { timeoutMs: 1000 }, '1.0.0');

      const warnings = registry.getDeprecationWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].usedVersion).toBe('1.0.0');
      expect(warnings[0].migrationGuide).toBe('See docs/migration.md');
    });
  });

  describe('Agent 级工具', () => {
    test('注册 Agent 级工具', () => {
      const tool = createTool();
      registry.register(tool, 'agent-1');
      expect(registry.get('test-tool', 'agent-1')).toBe(tool);
    });

    test('Agent 级工具优先于全局工具', () => {
      const globalTool = createTool({ handler: vi.fn().mockResolvedValue('global') });
      const agentTool = createTool({ handler: vi.fn().mockResolvedValue('agent') });

      registry.register(globalTool);
      registry.register(agentTool, 'agent-1');

      expect(registry.get('test-tool', 'agent-1')).toBe(agentTool);
      expect(registry.get('test-tool')).toBe(globalTool);
    });
  });
});
