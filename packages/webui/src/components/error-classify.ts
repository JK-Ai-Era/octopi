/**
 * 错误人话化分类（§5d）：纯逻辑，无 React——组件与测试共用单源。
 * - self-heal（可自愈）：静默 + 顶栏状态点，不进卡
 * - user-action（需用户动作）：错误卡 + 出路按钮
 * - support（需支持）：错误卡 + 诊断 ID 可复制 + raw 折叠
 */

import { classifyErrorKind, runtimeErrorCopy } from '@octopi-agent/engine/config-admin/error-copy.js';

export type FlowErrorLevel = 'user-action' | 'support';

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

/** 生成诊断 ID（时间序 + 随机尾，可复制给支持） */
export function makeDiagnosticId(): string {
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * provider/运行期错误人话化分类（§5d 全链人话化）。
 * 分类与文案单源在 engine `config-admin/error-copy.ts`（批 3-2 四份单源化）——
 * 此处只做 UI 装配（level 分级 / CTA / 诊断 ID / raw 折叠）。
 *
 * @param raw - 原始错误文本
 * @param onOpenSettings - auth/network/model 类错误的「去设置」回调
 * @returns 可直接进时间线的错误卡数据（id/at 由调用方补）
 */
export function classifyProviderError(
  raw: string,
  onOpenSettings?: () => void,
): Omit<FlowErrorItem, 'id' | 'at'> {
  const kind = classifyErrorKind(raw);
  const copy = runtimeErrorCopy(kind, 'zh');
  if (kind === 'context') {
    return { level: 'user-action', title: copy.title, detail: copy.detail };
  }
  if (kind === 'server') {
    return {
      level: 'support',
      title: copy.title,
      detail: copy.detail,
      diagnosticId: makeDiagnosticId(),
      raw,
    };
  }
  // auth / network / model：用户可自救——带「去设置」出路
  return {
    level: 'user-action',
    title: copy.title,
    detail: copy.detail,
    action: onOpenSettings ? { label: '去设置', run: onOpenSettings } : undefined,
  };
}

