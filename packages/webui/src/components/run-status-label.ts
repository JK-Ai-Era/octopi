/**
 * 顶栏运行状态标签：RunStatus → i18n 键的唯一映射。
 * 压缩进行中（手动按钮态或 store 压缩态）覆盖显示「正在压缩」。
 */
import type { RunStatus } from '@octopi-agent/gateway/web/runtime/store';
import type { MessageKey } from '../i18n/core';

export const RUN_STATUS_LABEL_KEY: Record<RunStatus, MessageKey> = {
  idle: 'chatWorkspace.statusIdle',
  sending: 'chatWorkspace.statusSending',
  waiting: 'chatWorkspace.statusWaiting',
  streaming: 'chatWorkspace.statusStreaming',
  tools: 'chatWorkspace.statusTools',
  aborted: 'chatWorkspace.statusAborted',
  error: 'chatWorkspace.statusError',
};

/**
 * @param runStatus 当前运行状态
 * @param compactActive 压缩是否进行中（手动 compacting 或 store inspector.compact.active）
 * @returns 顶栏状态标签的 i18n 键
 */
export function runStatusLabelKey(runStatus: RunStatus, compactActive: boolean): MessageKey {
  return compactActive ? 'chatWorkspace.statusCompacting' : RUN_STATUS_LABEL_KEY[runStatus];
}
