/**
 * 待发附件缓存（会话级）— 已上传到服务端、尚未随消息发出的附件，切换会话 / 刷新页面后仍在。
 *
 * 只存描述符（id/name/sizeBytes/status），不存文件内容：文件本体在服务端会话附件登记处，
 * 这里记的是「哪些已上传附件算作待发」。附件被别处删除后由调用方与服务端列表核对后剔除。
 * 每个会话独立一个键；localStorage 不可用时静默降级（本次浏览仍可用，刷新后丢失）。
 */

const PREFIX = 'octopi.pendingAttachments.v1.session:';

export interface PendingAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  status: string;
}

function storageKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

/**
 * 读取会话的待发附件。
 * @param sessionId 会话 id
 * @returns 待发附件列表；无记录、存储不可用或内容损坏时为空数组
 */
export function readPendingAttachments(sessionId: string): PendingAttachment[] {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingAttachment => {
      if (typeof item !== 'object' || item === null) return false;
      const { id, name } = item as Partial<PendingAttachment>;
      return typeof id === 'string' && id !== '' && typeof name === 'string';
    }).map((item) => ({
      id: item.id,
      name: item.name,
      sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : 0,
      status: typeof item.status === 'string' ? item.status : 'ready',
    }));
  } catch {
    // 存储被禁用 / JSON 损坏：当作没有待发附件，附件本体仍可在附件面板看到
    return [];
  }
}

/**
 * 写入会话的待发附件；空列表等价于删除键，无会话（null）时不落盘。
 * @param sessionId 会话 id；null = 当前无会话，待发附件无处归属
 * @param items 当前待发附件
 */
export function writePendingAttachments(
  sessionId: string | null,
  items: PendingAttachment[],
): void {
  if (!sessionId) return;
  try {
    const key = storageKey(sessionId);
    if (items.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // 配额满 / 存储被禁用：放弃持久化，本次浏览的待发列表仍在组件 state 中
  }
}

/**
 * 删除会话的待发附件记录（会话被删除时调用，避免孤儿键）。
 * @param sessionId 会话 id
 */
export function removePendingAttachments(sessionId: string): void {
  try {
    localStorage.removeItem(storageKey(sessionId));
  } catch {
    // 存储不可用：无键可删
  }
}
