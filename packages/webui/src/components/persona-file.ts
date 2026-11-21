import { assertSafePersonaFileName } from '@octopi-agent/engine/config-admin/name-guard.js';

/**
 * 规整「新增自定义 persona 文件」输入：去空白、去用户多打的 `.md` 后缀、统一补 `.md`。
 *
 * 合法性与服务端 `assertSafePersonaFileName` 同一实现（单一真相源）——
 * 非空、无路径分隔符、无 `..` 穿越形态、尾部为 `.md`。
 *
 * @param raw - 用户输入的文件名（可不带后缀）
 * @returns 合法的 `.md` 文件名；输入为空或不合法时返回 null
 */
export function normalizePersonaFileName(raw: string): string | null {
  const base = raw
    .trim()
    .replace(/\.md$/i, '')
    .trim();
  if (!base) return null;
  const file = `${base}.md`;
  try {
    assertSafePersonaFileName(file);
  } catch {
    // 与服务端同一守卫：路径成分 / `..` / 尾点等一律拒绝（调用方给输入错误提示）
    return null;
  }
  return file;
}
