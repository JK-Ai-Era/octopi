/**
 * 输入框草稿缓存（会话级）— localStorage 持久化，切换会话 / 刷新页面不丢未发送内容。
 *
 * 作用域：`session:<id>`；无活动会话时用 `new`（空态新建草稿）。
 * 每个作用域独立一个键，不做「读整表 → 改 → 写回」：多标签页各自编辑不同会话时不会互相覆盖。
 * localStorage 不可用（隐私模式 / 配额满）时静默降级为不持久化——输入本身仍在内存里，不影响发送。
 */

const PREFIX = 'octopi.composerDraft.v1.';

export interface ComposerDraftScope {
  /** 活动会话 id；null = 未选中会话（空态新建草稿，所有 agent 共用） */
  sessionId: string | null;
}

function storageKey(scope: ComposerDraftScope): string {
  return `${PREFIX}${scope.sessionId ? `session:${scope.sessionId}` : 'new'}`;
}

/**
 * 读取会话草稿。
 * @param scope 草稿归属的会话
 * @returns 草稿文本；无草稿或存储不可用时为空串
 */
export function readComposerDraft(scope: ComposerDraftScope): string {
  try {
    return localStorage.getItem(storageKey(scope)) ?? '';
  } catch {
    // localStorage 被禁用（Safari 隐私模式等）：本会话内不持久化，输入仍由组件 state 持有
    return '';
  }
}

/**
 * 写入会话草稿；空串等价于删除（发送成功 / 清空输入后不留空键）。
 * @param scope 草稿归属的会话
 * @param text 当前输入框内容
 */
export function writeComposerDraft(scope: ComposerDraftScope, text: string): void {
  try {
    const key = storageKey(scope);
    if (text === '') localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch {
    // 配额满 / 存储被禁用：放弃持久化，输入仍在组件 state 中，发送不受影响
  }
}

/**
 * 删除会话草稿（会话被删除时调用，避免留下孤儿键）。
 * @param scope 草稿归属的会话
 */
export function removeComposerDraft(scope: ComposerDraftScope): void {
  try {
    localStorage.removeItem(storageKey(scope));
  } catch {
    // 存储不可用：无键可删
  }
}

/**
 * 草稿迁移：空态草稿随会话创建搬进新会话（先写目标再删源，中途失败最多留一份重复，不丢内容）。
 * @param from 源作用域（通常是空态）
 * @param to 目标作用域（新建的会话）
 * @returns 迁移的文本；源草稿为空时返回空串
 */
export function moveComposerDraft(from: ComposerDraftScope, to: ComposerDraftScope): string {
  const text = readComposerDraft(from);
  if (text === '') return '';
  writeComposerDraft(to, text);
  removeComposerDraft(from);
  return text;
}
