/**
 * WebUI i18n 内核 — 语言状态与文案查表。
 *
 * 默认语言解析顺序（单一真相源）：用户显式选择（localStorage `octopi.lang`）
 * > 配置下发（octopi.json 顶层 `language` → serve-webui `--language` →
 * `window.__OCTOPI_WEB__.language` > runtime-config.getLanguage）> 'zh'。
 * 语言切换按钮写 localStorage 持久化（同 ThemeToggle 的偏好模式）。
 *
 * 字典分片与键规约见 arch/i18n-extraction-spec.md；合并入口 ./messages。
 *
 * @module
 */

import { getLanguage } from '../runtime-config';
import { zh, en, type MessageKey } from './messages';

export type { MessageKey } from './messages';

/** 界面语言 */
export type Lang = 'zh' | 'en';

/** 插值参数（{name} 占位符替换） */
export type MessageParams = Record<string, string | number>;

const STORAGE_KEY = 'octopi.lang';

const CATALOGS: Record<Lang, Record<string, string>> = { zh, en };

/** 语言名（endonym，固定不随界面语言翻译） */
export const LANG_NAMES: Record<Lang, string> = { zh: '中文', en: 'English' };

function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'zh' || v === 'en' ? v : null;
  } catch {
    // 存储不可用（隐私模式等）：回落配置默认，非静默失败——getLanguage 仍有值
    return null;
  }
}

/** 初始语言：localStorage 显式覆盖 > 配置下发 > 'zh' */
function readInitialLang(): Lang {
  return readStoredLang() ?? getLanguage();
}

let current: Lang = readInitialLang();

/** 同步 <html lang>（globalThis 访问保持 lib 无关：本模块会进无 DOM lib 的 tests 类型检查图） */
function setDocLang(lang: Lang): void {
  const el = (globalThis as { document?: { documentElement?: { lang: string } } }).document
    ?.documentElement;
  if (el) el.lang = lang;
}

setDocLang(current);

const listeners = new Set<() => void>();

/**
 * 当前界面语言。
 *
 * @returns 当前语言
 */
export function getLang(): Lang {
  return current;
}

/**
 * 切换界面语言（显式用户选择，持久化 localStorage）。
 *
 * @param lang - 目标语言
 */
export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 存储不可用：本次会话生效（内存态仍切换成功）
  }
  if (current === lang) return;
  current = lang;
  setDocLang(lang);
  for (const listener of listeners) listener();
}

/**
 * 订阅语言变化。
 *
 * @param listener - 变化回调
 * @returns 退订函数
 */
export function subscribeLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * 查表翻译（纯函数，按指定语言）。
 *
 * @param lang - 语言
 * @param key - 文案键（messages 字典）
 * @param params - 插值参数（{name} 占位符；缺参保留占位符原文，不吞）
 * @returns 译文；缺译回落 zh，仍缺回落键名
 */
export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const template = CATALOGS[lang][key] ?? zh[key] ?? key;
  return params ? interpolate(template, params) : template;
}

/**
 * 按当前语言查表（非 React 模块用；React 组件用 useT 保证语言切换重渲染）。
 *
 * @param key - 文案键
 * @param params - 插值参数
 * @returns 当前语言译文
 */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}
