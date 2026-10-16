/**
 * 行尾（EOL）工具 — file 工具行尾感知
 *
 * 背景：file 工具按字节处理文本时，多行 old_text（`\n` 书写）在 CRLF 文件上
 * 永远匹配不上（静默 old_text not found），插入的新行又会把 LF 混进 CRLF 文件，
 * 造成混杂行尾并在 git 提交时产生整文件 churn。
 *
 * 约定：
 * - 编辑已有文件时跟随该文件的**主导行尾**（保持字节稳定，最小 diff）；
 * - 覆写/追加已有文件时把内容换算成文件主导行尾；
 * - 新建文件保持内容原样（模型输出默认 LF）。
 */

export type Eol = '\r\n' | '\n';

/**
 * 检测文本的主导行尾。
 *
 * @param content - 文本内容
 * @returns CRLF 行数多于纯 LF 行数时 `\r\n`，否则 `\n`（空文本默认 `\n`）
 */
export function detectEol(content: string): Eol {
  const crlf = content.split('\r\n').length - 1;
  const lfOnly = content.split('\n').length - 1 - crlf;
  return crlf > lfOnly ? '\r\n' : '\n';
}

/**
 * 把 text 中的所有行尾（CRLF / LF）统一成 eol。
 *
 * @param text - 原文本
 * @param eol - 目标行尾
 * @returns 行尾统一后的文本
 */
export function toEol(text: string, eol: Eol): string {
  return text.replace(/\r\n|\n/g, eol);
}

/**
 * 生成 old_text 的行尾候选项（原样优先），供匹配降级尝试。
 *
 * @param oldText - 调用方提供的匹配文本
 * @returns 去重后的候选项列表（按尝试顺序）
 */
export function oldTextCandidates(oldText: string): string[] {
  const candidates = [oldText, toEol(oldText, '\n'), toEol(oldText, '\r\n')];
  return candidates.filter((c, i) => candidates.indexOf(c) === i);
}
