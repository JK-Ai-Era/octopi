/**
 * 注释/文案乱码零容忍守卫（arch/open-problems.md H7′ ②）
 *
 * 背景：历史上模型生成侧曾反复把中文写成乱码（CJK 字符被替换成 ASCII `?`、
 * GBK 误解码残留 `鈥`/`锟`、U+FFFD 替换字符、行内 BOM），且整文件重写会把
 * 已污染的上下文回声复制，多次落盘（如 f75c90e 引入 gateway.ts/ingest.ts
 * 注释乱码）。本测试对源码树零容忍：任何命中即失败，逼迫在提交前发现。
 *
 * 检测面（正则全部用 `\u` 转义书写，避免测试文件自身携带触发字节）：
 * 1. CJK 字符后紧跟 ASCII `?`（非 `?:` 可选属性语法）——损坏签名；
 * 2. GBK 误解码残留 `鈥`（U+9225）/`锟`（U+951F）；
 * 3. U+FFFD 替换字符；
 * 4. 行内 U+FEFF BOM（文件首字节 BOM 同样不允许）。
 *
 * 合法例外（正则量词，非乱码）登记在 LEGIT_ALLOWLIST，按「文件 + 特征子串」
 * 匹配，新增例外必须在此注明理由。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const SCAN_ROOTS = [
  'src',
  'packages/core/src',
  'packages/engine/src',
  'packages/gateway/src',
  'packages/webui/src',
  'tests',
  'docs',
  'scripts',
];

const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.md', '.json']);

/**
 * 合法例外：正则量词里 CJK 后的 `?`（如“呢可选”量词）不是乱码。
 * 每项按「文件相对路径 + 该行特征子串」匹配；特征子串与理由以码点转义书写，
 * 避免本测试文件自身携带触发字节被自己扫出。
 */
const ALLOWLIST: Array<{ file: string; marker: string; reason: string }> = [
  {
    file: 'packages/engine/src/harness/context/layer-types.ts',
    marker: '\u7136\u540E\u5462' + String.fromCharCode(63) + '|',
    reason: 'ACK_LAYER_QUERY_RE 量词：\u7136\u540E\u5462?\u3001\u5F00\u59CB\u5427?\uFF08\u5462\u3001\u5427\u53EF\u9009\uFF09',
  },
  {
    file: 'packages/engine/src/harness/memory/gates.ts',
    marker: '\u51FA\u73B0\u4E86' + String.fromCharCode(63) + String.fromCharCode(92) + 's',
    reason: 'STAT/ACTIVITY_PATTERNS 量词：\u51FA\u73B0\u4E86?\u3001\u8C03\u7528\u4E86?\uFF08\u4E86\u53EF\u9009\uFF09',
  },
  {
    file: 'packages/engine/src/harness/memory/gates.ts',
    marker: '\u8C03\u7528\u4E86' + String.fromCharCode(63) + '|',
    reason: 'ACTIVITY_PATTERNS \u91CF\u8BCD\uFF1A\u8C03\u7528\u4E86?\uFF08\u4E86\u53EF\u9009\uFF09',
  },
  {
    file: 'packages/engine/src/integration/web-search/duckduckgo.ts',
    marker: 'duckduckgo.com/l/?uddg=',
    reason: 'DuckDuckGo redirect URL query',
  },
  {
    file: 'packages/gateway/src/web/api/router.ts',
    marker: 'messages?phase=',
    reason: 'debug endpoint URL query example',
  },
  {
    file: 'tests/harness/knowledge-external-ingest.test.ts',
    marker: '防 ?a/?b',
    reason: 'URL query folding regression case',
  },
];

const PATTERNS: Array<{ name: string; re: RegExp; explain: string }> = [
  {
    name: 'cjk-question-mark',
    re: /[\u4E00-\u9FFF]\?(?!:)/g,
    explain: 'CJK 字符后紧跟 ASCII `?`（排除 `?:` 可选属性）——典型注释损坏签名',
  },
  {
    name: 'gbk-mojibake',
    re: /[\u9225\u951F]|锟斤拷|[\u20AC][\u4E00-\u9FFF]|[\u4E00-\u9FFF]\u20AC|[\uFE30-\uFE4F]/g,
    explain: 'GBK 误解码残留家族：鈥/锟、锟斤拷、欧元符邻 CJK、CJK 兼容形态区——均非正常中文文本',
  },
  {
    name: 'replacement-char',
    re: /\uFFFD/g,
    explain: 'U+FFFD 替换字符（解码失败占位）',
  },
  {
    name: 'inline-bom',
    re: /\uFEFF/g,
    explain: '行内/文件头 U+FEFF BOM',
  },
];

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const CJK_CHAR = /[\u4E00-\u9FFF]/;
// 良性邻域：TS 可选语法（?. ?: ??）、glob/URL/XML 文档里的 `?`、英文尾问，
// 其两侧字符都属于该集合；损坏残留的 `?` 一侧多为 CJK 或行首/行尾注释边界。
const BENIGN_NEIGHBOR = /[A-Za-z0-9_()[\].,;:'"/\\|+*=&%$#@!~^<?`…\s-]/;

/** 注释行内可疑 `?`：先剥离反引号代码段（glob/URL/类型示例不参与判定），
 * 再按三层规则判定——
 * 1. `?` 紧贴 JSDoc 收尾符（右括号被吃）；
 * 2. 中文注释行尾 `?`（句末句号/右括号被吃）；
 * 3. `?` 紧跟字母（`view?Knowledge` 类中缀被吃；URL query 形态登记白名单）；
 * 4. 其余：`?:`/`??` 豁免，两侧全属良性邻域豁免。
 * 已知盲区：纯掉字损坏（无 `?` 残留，如「报警」整词消失）无模式可查，
 * 依赖评审/对照历史发现，本守卫不覆盖。 */
function suspiciousQuestionMark(line: string): boolean {
  const stripped = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
  if (/\?\*\//.test(stripped)) return true;
  if (CJK_CHAR.test(stripped) && /\?\s*$/.test(stripped)) return true;
  if (/\?[A-Za-z]/.test(stripped)) return true;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] !== '?') continue;
    const prev = stripped[i - 1] ?? '';
    const next = stripped[i + 1] ?? '';
    if (next === ':' || next === '?') continue;
    if (prev !== '' && BENIGN_NEIGHBOR.test(prev) && (next === '' || BENIGN_NEIGHBOR.test(next))) continue;
    return true;
  }
  return false;
}

/** 本守卫测试自身引用了模式字面量，豁免自扫。 */
const SELF = 'tests/architecture/comment-mojibake.test.ts';

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (SCAN_EXTS.has(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkFiles(join(REPO_ROOT, root))) {
      const rel = file.slice(REPO_ROOT.length + 1);
      if (rel === SELF) continue; // 本测试自身携带模式字面量，豁免自扫
      const text = readFileSync(file, 'utf-8');
      const lines = text.split('\n');
      for (const { name, re, explain } of PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          re.lastIndex = 0;
          if (!re.test(line)) continue;
          if (ALLOWLIST.some((a) => a.file === rel && line.includes(a.marker))) {
            continue;
          }
          violations.push({
            file: rel,
            line: i + 1,
            pattern: `${name}（${explain}）`,
            snippet: line.trim().slice(0, 120),
          });
        }
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!COMMENT_LINE.test(line) || !suspiciousQuestionMark(line)) continue;
        if (ALLOWLIST.some((a) => a.file === rel && line.includes(a.marker))) {
          continue;
        }
        violations.push({
          file: rel,
          line: i + 1,
          pattern: 'suspicious-question-mark（注释行内可疑 ASCII `?`——多字节字符被截断成 `?` 的残留）',
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }
  return violations;
}

describe('mojibake zero-tolerance guard (H7)', () => {
  it('no corrupted CJK / GBK-residue / U+FFFD / BOM in source trees', () => {
    const violations = scan();
    const report = violations
      .map((v) => `${v.file}:${v.line} [${v.pattern}]\n    ${v.snippet}`)
      .join('\n');
    expect(violations, `发现 ${violations.length} 处乱码：\n${report}`).toEqual([]);
  });
});
