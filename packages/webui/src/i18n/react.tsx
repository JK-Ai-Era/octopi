/**
 * i18n React 绑定 — useSyncExternalStore 订阅语言 store，语言切换即重渲染。
 *
 * @module
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  getLang,
  setLang,
  subscribeLang,
  translate,
  type Lang,
  type MessageKey,
  type MessageParams,
} from './core';

/**
 * 当前语言与切换器。
 *
 * @returns [当前语言, 切换函数]
 */
export function useLang(): [Lang, (lang: Lang) => void] {
  const lang = useSyncExternalStore(subscribeLang, getLang, getLang);
  return [lang, setLang];
}

/**
 * 翻译函数 hook（返回的 t 随语言变化更新，触发重渲染）。
 *
 * @returns 绑定当前语言的 `t(key, params)`
 */
export function useT(): (key: MessageKey, params?: MessageParams) => string {
  const lang = useSyncExternalStore(subscribeLang, getLang, getLang);
  return useCallback(
    (key: MessageKey, params?: MessageParams) => translate(lang, key, params),
    [lang],
  );
}
