/**
 * Plugin 生命周期管理测试
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { PluginLifecycleManager } from '../src/harness/plugin-ecosystem/plugins/lifecycle.js';

describe('Plugin 生命周期管理', () => {
  let manager: PluginLifecycleManager;

  beforeEach(() => {
    manager = new PluginLifecycleManager();
  });

  describe('register', () => {
    test('注册新 Plugin 为 discovered 状态', () => {
      manager.register('plugin-a');
      expect(manager.getState('plugin-a')).toBe('discovered');
    });

    test('重复注册不覆盖状态', () => {
      manager.register('plugin-a');
      manager.markLoaded('plugin-a');
      manager.register('plugin-a');
      expect(manager.getState('plugin-a')).toBe('loaded');
    });
  });

  describe('markLoaded', () => {
    test('标记为已加载', () => {
      manager.register('plugin-a');
      manager.markLoaded('plugin-a');
      expect(manager.getState('plugin-a')).toBe('loaded');
      expect(manager.getEntry('plugin-a')?.loadedAt).toBeDefined();
    });
  });

  describe('activate', () => {
    test('激活已加载的 Plugin', () => {
      manager.register('plugin-a');
      manager.markLoaded('plugin-a');
      manager.activate('plugin-a');
      expect(manager.getState('plugin-a')).toBe('activated');
      expect(manager.getEntry('plugin-a')?.activatedAt).toBeDefined();
    });

    test('不能激活已卸载的 Plugin', () => {
      manager.register('plugin-a');
      manager.unload('plugin-a');
      expect(() => manager.activate('plugin-a')).toThrow('Cannot activate unloaded');
    });
  });

  describe('suspend', () => {
    test('暂停已激活的 Plugin', () => {
      manager.register('plugin-a');
      manager.activate('plugin-a');
      manager.suspend('plugin-a');
      expect(manager.getState('plugin-a')).toBe('suspended');
    });

    test('不能暂停未激活的 Plugin', () => {
      manager.register('plugin-a');
      expect(() => manager.suspend('plugin-a')).toThrow('not activated');
    });
  });

  describe('resume', () => {
    test('恢复已暂停的 Plugin', () => {
      manager.register('plugin-a');
      manager.activate('plugin-a');
      manager.suspend('plugin-a');
      manager.resume('plugin-a');
      expect(manager.getState('plugin-a')).toBe('activated');
    });

    test('不能恢复未暂停的 Plugin', () => {
      manager.register('plugin-a');
      manager.activate('plugin-a');
      expect(() => manager.resume('plugin-a')).toThrow('not suspended');
    });
  });

  describe('deactivate', () => {
    test('停用已激活的 Plugin', () => {
      manager.register('plugin-a');
      manager.activate('plugin-a');
      manager.deactivate('plugin-a');
      expect(manager.getState('plugin-a')).toBe('deactivated');
    });

    test('停用已暂停的 Plugin', () => {
      manager.register('plugin-a');
      manager.activate('plugin-a');
      manager.suspend('plugin-a');
      manager.deactivate('plugin-a');
      expect(manager.getState('plugin-a')).toBe('deactivated');
    });
  });

  describe('unload', () => {
    test('卸载 Plugin', () => {
      manager.register('plugin-a');
      manager.activate('plugin-a');
      manager.unload('plugin-a');
      expect(manager.getState('plugin-a')).toBe('unloaded');
    });
  });

  describe('状态查询', () => {
    test('isActivated', () => {
      manager.register('plugin-a');
      expect(manager.isActivated('plugin-a')).toBe(false);
      manager.activate('plugin-a');
      expect(manager.isActivated('plugin-a')).toBe(true);
    });

    test('getActivatedIds', () => {
      manager.register('a');
      manager.register('b');
      manager.register('c');
      manager.activate('a');
      manager.activate('b');
      expect(manager.getActivatedIds()).toEqual(['a', 'b']);
    });

    test('listStates', () => {
      manager.register('a');
      manager.register('b');
      const states = manager.listStates();
      expect(states).toHaveLength(2);
      expect(states[0].id).toBe('a');
      expect(states[1].id).toBe('b');
    });
  });

  describe('错误处理', () => {
    test('markError 设置错误状态', () => {
      manager.register('plugin-a');
      manager.markError('plugin-a', new Error('load failed'));
      expect(manager.getState('plugin-a')).toBe('error');
      expect(manager.getEntry('plugin-a')?.error?.message).toBe('load failed');
    });

    test('激活清除错误状态', () => {
      manager.register('plugin-a');
      manager.markError('plugin-a', new Error('load failed'));
      manager.activate('plugin-a');
      expect(manager.getState('plugin-a')).toBe('activated');
      expect(manager.getEntry('plugin-a')?.error).toBeUndefined();
    });
  });
});
