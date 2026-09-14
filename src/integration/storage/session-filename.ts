/**
 * Session id to filesystem-safe base name
 *
 * Windows forbids <>:"/\|?* and control chars in file names.
 * Logical session ids may still contain colons; storage must map consistently.
 *
 * Legacy macOS/Linux data may still use raw session ids as filenames
 * (e.g. `default:web:123.jsonl`). Readers should fall back to that form
 * when the safe name is missing.
 */

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Map a logical sessionId to a cross-platform safe file base name
 *
 * @param sessionId - logical session id (may contain colons)
 * @returns string safe for use as a filename stem
 */
export function toSessionFileName(sessionId: string): string {
  return sessionId.replace(ILLEGAL_FILENAME_CHARS, '_');
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
