// @vitest-environment jsdom
/**
 * i18n core — 初始语言解析顺序、查表/插值、字典完整性。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh, en, type MessageKey } from './messages';
import { translate, getLang, setLang, subscribeLang } from './core';

/** 重新加载 core（初始语言在模块导入时求值，状态用例需全新实例） */
async function freshCore(): Promise<typeof import('./core')> {
  vi.resetModules();
  return await import('./core');
}

describe('字典完整性', () => {
  it('en 与 zh 键全集一致且每条非空', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const key of Object.keys(zh)) {
      expect(en[key as MessageKey].trim().length, `en 空译文: ${key}`).toBeGreaterThan(0);
    }
  });
});

describe('translate', () => {
  it('按语言取值', () => {
    expect(translate('zh', 'app.panelToggle')).toBe('面板');
    expect(translate('en', 'app.panelToggle')).toBe('Panel');
  });

  it('{name} 占位符插值；缺参保留原文不吞', () => {
    expect(translate('zh', 'theme.toggleTitle', { mode: '深色' })).toBe('主题：深色（点击切换）');
    expect(translate('zh', 'theme.toggleTitle')).toBe('主题：{mode}（点击切换）');
    expect(translate('en', 'theme.toggleTitle', { mode: 'Dark' })).toBe('Theme: Dark (click to switch)');
  });

  it('未知键回落键名', () => {
    expect(translate('en', 'nope.notAKey' as MessageKey)).toBe('nope.notAKey');
  });
});

describe('初始语言解析顺序', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.__OCTOPI_WEB__;
  });

  it('无覆盖无配置时默认 zh', async () => {
    const core = await freshCore();
    expect(core.getLang()).toBe('zh');
  });

  it('配置下发 en 生效（octopi.json → window.__OCTOPI_WEB__.language）', async () => {
    window.__OCTOPI_WEB__ = { language: 'en' };
    const core = await freshCore();
    expect(core.getLang()).toBe('en');
  });

  it('localStorage 显式选择覆盖配置', async () => {
    window.__OCTOPI_WEB__ = { language: 'en' };
    localStorage.setItem('octopi.lang', 'zh');
    const core = await freshCore();
    expect(core.getLang()).toBe('zh');
  });

  it('localStorage 非法值回落配置', async () => {
    window.__OCTOPI_WEB__ = { language: 'en' };
    localStorage.setItem('octopi.lang', 'fr');
    const core = await freshCore();
    expect(core.getLang()).toBe('en');
  });
});

describe('setLang / subscribeLang', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.__OCTOPI_WEB__;
    setLang('zh');
  });

  it('切换持久化、通知订阅者并同步 <html lang>', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLang(() => seen.push(getLang()));
    setLang('en');
    expect(getLang()).toBe('en');
    expect(localStorage.getItem('octopi.lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(seen).toEqual(['en']);
    unsubscribe();
    setLang('zh');
    expect(seen).toEqual(['en']);
    expect(localStorage.getItem('octopi.lang')).toBe('zh');
    expect(document.documentElement.lang).toBe('zh');
  });

  it('同值 setLang 仍持久化但不重复通知', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLang(() => seen.push(getLang()));
    setLang('zh');
    expect(seen).toEqual([]);
    expect(localStorage.getItem('octopi.lang')).toBe('zh');
    unsubscribe();
  });
});

afterEach(() => {
  localStorage.clear();
  delete window.__OCTOPI_WEB__;
});
