/**
 * 错误人话化分类（§5d）：纯逻辑，无 React——组件与测试共用单源。
 * - self-heal（可自愈）：静默 + 顶栏状态点，不进卡
 * - user-action（需用户动作）：错误卡 + 出路按钮
 * - support（需支持）：错误卡 + 诊断 ID 可复制 + raw 折叠
 */

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
 * provider/运行期错误人话化分类（§5d 全链人话化：auth/network/model/server 四类）。
 *
 * @param raw - 原始错误文本
 * @param onOpenSettings - auth/model 类错误的「去设置」回调
 * @returns 可直接进时间线的错误卡数据（id/at 由调用方补）
 */
export function classifyProviderError(
  raw: string,
  onOpenSettings?: () => void,
): Omit<FlowErrorItem, 'id' | 'at'> {
  const t = raw.toLowerCase();
  const isAuth = t.includes('401') || t.includes('unauthorized') || t.includes('api key') || t.includes('apikey') || t.includes('invalid key') || t.includes('authentication');
  const isNetwork = t.includes('econnrefused') || t.includes('etimedout') || t.includes('enotfound') || t.includes('fetch failed') || t.includes('network') || t.includes('econnreset');
  const isModel = t.includes('model') && (t.includes('not found') || t.includes('does not exist') || t.includes('unknown model') || t.includes('no such model'));
  const isContext = t.includes('context') && (t.includes('length') || t.includes('exceed') || t.includes('too long') || t.includes('maximum'));

  if (isAuth) {
    return {
      level: 'user-action',
      title: '模型服务的密钥无效或已过期',
      detail: '请到「设置 → 模型」更新 API Key 后重试。',
      action: onOpenSettings ? { label: '去设置', run: onOpenSettings } : undefined,
    };
  }
  if (isNetwork) {
    return {
      level: 'user-action',
      title: '连不上模型服务',
      detail: '请检查网络或模型服务地址（设置 → 模型），稍后重试。',
      action: onOpenSettings ? { label: '去设置', run: onOpenSettings } : undefined,
    };
  }
  if (isModel) {
    return {
      level: 'user-action',
      title: '所选模型不可用',
      detail: '模型名可能已下线或拼写有误，请到「设置 → 模型」换一个模型。',
      action: onOpenSettings ? { label: '去设置', run: onOpenSettings } : undefined,
    };
  }
  if (isContext) {
    return {
      level: 'user-action',
      title: '消息太长，超出模型的记忆容量',
      detail: '可以压缩早期消息（对话顶部「压缩」）或新开会话再试。',
    };
  }
  return {
    level: 'support',
    title: '模型服务出错了',
    detail: '这不是你的操作问题。复制下面的诊断 ID 反馈给支持人员即可。',
    diagnosticId: makeDiagnosticId(),
    raw,
  };
}

