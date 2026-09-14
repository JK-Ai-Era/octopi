/**
 * Session id to filesystem-safe base name
 *
 * Windows forbids <>:"/\|?* and control chars in file names,
 * reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9),
 * and trailing dots/spaces.
 *
 * Logical session ids may still contain colons; storage must map consistently.
 *
 * Legacy macOS/Linux data may still use raw session ids as filenames
 * (e.g. `default:web:123.jsonl`). Readers should fall back to that form
 * when the safe name is missing.
 */

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Windows 设备保留名（不区分大小写；含 `CON.txt` 这类带扩展名形式） */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Map a logical sessionId to a cross-platform safe file base name
 *
 * @param sessionId - logical session id (may contain colons)
 * @returns string safe for use as a filename stem
 */
export function toSessionFileName(sessionId: string): string {
  let name = sessionId.replace(ILLEGAL_FILENAME_CHARS, '_');
  // Windows 会静默去掉尾部点/空格，提前归一，避免两平台文件名漂移
  name = name.replace(/[. ]+$/g, '');

  const stem = name.split('.')[0]?.toUpperCase() ?? '';
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    name = `_${name}`;
  }

  return name.length > 0 ? name : '_';
}

/**
 * Legacy filename stem used before the Windows-safe mapping.
 *
 * @param sessionId - logical session id
 * @returns raw id when it differs from the safe form; otherwise null
 */
export function legacySessionFileName(sessionId: string): string | null {
  const safe = toSessionFileName(sessionId);
  return safe === sessionId ? null : sessionId;
}
