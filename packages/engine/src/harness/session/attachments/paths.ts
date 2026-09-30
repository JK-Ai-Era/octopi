/**
 * 会话附件路径 — OCTOPI_HOME/sessions/&lt;sessionId&gt;/attachments/
 */

import { join } from 'node:path';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';

export interface SessionAttachmentsPaths {
  /** attachments 根目录 */
  root: string;
  manifestPath: string;
}

/**
 * 解析某会话的附件目录
 *
 * @param sessionsDir - 通常 `OCTOPI_HOME/sessions`
 * @param sessionId - 会话 id（经 toSessionFileName 消毒）
 */
export function resolveSessionAttachmentsPaths(
  sessionsDir: string,
  sessionId: string,
): SessionAttachmentsPaths {
  const root = join(sessionsDir, toSessionFileName(sessionId), 'attachments');
  return {
    root,
    manifestPath: join(root, '.manifest.json'),
  };
}
