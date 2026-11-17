/**
 * 文案字典合并入口 — 分片按组件域拆分（并行抽取互不冲突），此处唯一合并点。
 *
 * 键规约：`<组件名小驼峰>.<语义>`，跨分片全局唯一（靠组件前缀保证）；
 * 分片契约见 arch/i18n-extraction-spec.md。
 *
 * @module
 */

import { zh as shellZh, en as shellEn } from './shell';
import { zh as onboardingZh, en as onboardingEn } from './onboarding';
import { zh as chatZh, en as chatEn } from './chat';
import { zh as settingsZh, en as settingsEn } from './settings';
import { zh as knowledgeZh, en as knowledgeEn } from './knowledge';
import { zh as observatoryZh, en as observatoryEn } from './observatory';
import { zh as miscZh, en as miscEn } from './misc';

/** 中文文案（键全集 = MessageKey） */
export const zh = {
  ...shellZh,
  ...onboardingZh,
  ...chatZh,
  ...settingsZh,
  ...knowledgeZh,
  ...observatoryZh,
  ...miscZh,
} as const;

/** 文案键（全字典键联合） */
export type MessageKey = keyof typeof zh;

/** 英文文案（分片层 `Record<keyof typeof zh, string>` 已保证与中文键全集一致） */
export const en: Record<MessageKey, string> = {
  ...shellEn,
  ...onboardingEn,
  ...chatEn,
  ...settingsEn,
  ...knowledgeEn,
  ...observatoryEn,
  ...miscEn,
};
