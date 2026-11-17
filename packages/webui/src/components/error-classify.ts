/**
 * 错误人话化分类（§5d）：纯逻辑，无 React——组件与测试共用单源。
 * - self-heal（可自愈）：静默 + 低调行/状态点，不进错误卡（工具执行失败、守卫拦截）
 * - user-action（需用户动作）：错误卡 + 出路按钮
 * - support（需支持）：错误卡 + 诊断 ID 可复制 + raw 折叠
 *
 * 分类与文案单源在 engine `config-admin/error-copy.ts`（域×档：来源域拆分）——
 * 此处只做 UI 装配（level 取值 / CTA / 诊断 ID / raw 折叠）。
 * 工具错误与 app 操作错误不再套 provider 文案（语义即契约）。
 */

import { classifyError, makeDiagnosticId, type ErrorDomain } from '@octopi-agent/engine/config-admin/error-copy.js';
import { t } from '../i18n/core';

// 诊断 ID 生成单源在 engine error-copy（gateway 写入侧同源）
export { makeDiagnosticId };

export type FlowErrorLevel = 'self-heal' | 'user-action' | 'support';

/** 对话流错误卡数据（按 createdAt 交错进时间线） */
export interface FlowErrorItem {
  id: string;
  at: number;
  level: FlowErrorLevel;
  /** 人话标题（发生了什么） */
  title: string;
  /** 人话细节（为什么 + 已知信息），不甩 raw error */
  detail?: string;
  /** 出路按钮（user-action 级：告诉用户下一步做什么） */
  action?: { label: string; run: () => void };
  /** support 级：诊断 ID（用户报障时提供） */
  diagnosticId?: string;
  /** support 级：原始错误（折叠、可复制；默认不展示） */
  raw?: string;
}

/**
 * 运行期错误人话化装配（§5d 全链人话化）。
 * 分类与文案单源在 engine `config-admin/error-copy.ts`（域×档）——
 * 此处只做 UI 装配（level 分级 / CTA / 诊断 ID / raw 折叠）。
 *
 * @param raw - 原始错误文本
 * @param source - 来源域：provider（模型服务）| tool（工具执行）| app（界面/会话操作）
 * @param onOpenSettings - provider 域 auth/network/model 类的「去设置」回调
 * @returns 可直接进时间线的错误卡数据（id/at 由调用方补）
 */
export function classifyFlowError(
  raw: string,
  source: ErrorDomain,
  onOpenSettings?: () => void,
): Omit<FlowErrorItem, 'id' | 'at'> {
  const { kind, level, copy } = classifyError(raw, source);
  if (level === 'self-heal') {
    return { level, title: copy.title, detail: copy.detail };
  }
  if (level === 'support') {
    return {
      level,
      title: copy.title,
      detail: copy.detail,
      diagnosticId: makeDiagnosticId(),
      raw,
    };
  }
  // user-action：raw 进「技术细节」折叠；仅 provider 域的密钥/网络/模型类有
  // 「去设置」出路（超时/限流是等，不是设置问题）
  const hasSettingsAction = source === 'provider' && (kind === 'auth' || kind === 'network' || kind === 'model');
  return {
    level,
    title: copy.title,
    detail: copy.detail,
    raw,
    action:
      hasSettingsAction && onOpenSettings
        ? { label: t('errorClassify.openSettings'), run: onOpenSettings }
        : undefined,
  };
}
