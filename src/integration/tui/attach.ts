/**
 * TUI 文件引用内联（@path）— 纯函数
 *
 * 发送前把消息里的 `@<path>` 引用展开为带围栏的文件文本（附件语义），
 * 让 agent 无需先跑工具就能看到文件内容。读取经注入的 readFileText——
 * 无 IO 依赖，单测用假文件表钉行为。
 *
 * 规则：
 * - 引用语法：`@path`（无空白）或 `@"path with spaces"`；token 尾部中英标点剥离；
 * - 读不到 / 二进制（含 NUL）→ 引用保持原文并在 failed 列出（消息照发，不半途拦截）；
 * - 单文件超限截断（带截断标注）；总预算耗尽后剩余引用不再展开（记 failed）。
 */

export interface AttachDeps {
  /**
   * 读取文件文本；不存在/不可读/二进制返回 null。
   *
   * @param path - 用户写的路径（相对 cwd 或绝对）
   * @returns 文件文本；不可内联时返回 null
   */
  readFileText(path: string): string | null;
}

export interface AttachOptions {
  /** 单文件字符上限（缺省 32000） */
  maxCharsPerFile?: number;
  /** 全部附件总字符预算（缺省 120000） */
  maxTotalChars?: number;
}

export interface AttachResult {
  /** 展开后的消息文本 */
  text: string;
  /** 成功内联的文件 */
  expanded: Array<{ path: string; chars: number; truncated: boolean }>;
  /** 未内联的引用（保持原文） */
  failed: Array<{ path: string; reason: 'not_found' | 'binary' | 'over_budget' }>;
}

/** token 尾部剥离的标点（路径合法字符之外的收尾符号） */
const TRAILING_PUNCT = /[，。、,.;:!?！？）)\]】｝}'"‘’“”]+$/u;

/** 引用 token：@ 后跟引号包路径或非空白串 */
const REF_TOKEN = /(^|[\s（(【["'])@("[^"]+"|\S+)/gu;

/**
 * 语言围栏标注（按扩展名；未知回退空标注）。
 *
 * @param path - 文件路径
 * @returns 围栏语言串
 */
function fenceLang(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/u.exec(path);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 展开消息中的 `@path` 引用为文件内联文本。
 *
 * @param text - 原消息文本
 * @param deps - 文件读取（注入）
 * @param options - 体积上限
 * @returns 展开结果（文本 + 展开/失败清单）
 */
export function expandFileReferences(
  text: string,
  deps: AttachDeps,
  options: AttachOptions = {},
): AttachResult {
  const maxPerFile = options.maxCharsPerFile ?? 32_000;
  const maxTotal = options.maxTotalChars ?? 120_000;
  const expanded: AttachResult['expanded'] = [];
  const failed: AttachResult['failed'] = [];
  let totalChars = 0;

  const out = text.replace(REF_TOKEN, (whole, lead: string, rawToken: string) => {
    const quoted = rawToken.startsWith('"') && rawToken.endsWith('"') && rawToken.length >= 2;
    const inner = quoted ? rawToken.slice(1, -1) : rawToken;
    const path = inner.replace(TRAILING_PUNCT, '');
    const tail = inner.slice(path.length); // 被剥离的尾部标点——归还给消息，不得吞字
    if (!path) return whole;

    const content = deps.readFileText(path);
    if (content === null) {
      failed.push({ path, reason: 'not_found' });
      return whole;
    }
    if (content.includes('\u0000')) {
      failed.push({ path, reason: 'binary' });
      return whole;
    }
    if (totalChars >= maxTotal) {
      failed.push({ path, reason: 'over_budget' });
      return whole;
    }
    const truncated = content.length > maxPerFile;
    const body = truncated ? content.slice(0, maxPerFile) : content;
    expanded.push({ path, chars: body.length, truncated });
    totalChars += body.length;
    const note = truncated
      ? `（截断：原 ${content.length} 字符，仅内联前 ${maxPerFile}）\n`
      : '';
    return `${lead}[附件 ${path}]\n\`\`\`${fenceLang(path)}\n${note}${body}\n\`\`\`\n${tail}`;
  });

  return { text: out, expanded, failed };
}
