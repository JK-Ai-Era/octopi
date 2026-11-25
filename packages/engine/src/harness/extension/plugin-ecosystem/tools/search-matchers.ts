/**
 * 内容匹配器 — file_search 与 skill_search 的共享搜索语义（One source of truth）
 *
 * auto 模式判定、`a|b` 字面 OR、转义、多词 OR 的编译逻辑全在本模块：
 * 两个搜索工具共用，保证「同一个 pattern 在文件面和技能面命中一致」。
 * （S2：从 file-search.ts 平移为共享导出，语义未变。）
 */

/** pattern 解析模式 */
export type PatternMode = 'auto' | 'literal' | 'regex';

/** 编译后的内容匹配器 */
export interface ContentMatchers {
  mode: 'literal' | 'regex' | 'mixed';
  matchers: RegExp[];
  sources: string[];
  compiled: string[];
  kinds: Array<'literal' | 'regex'>;
  autoForcedLiteral: boolean;
}

/**
 * 判断 auto 模式下术语是否应按正则编译
 *
 * 只认强信号。代码字面量保持 literal：
 * `arr[0]` / `useState()` / `a+b` / `C++` / `foo.bar` / `memory*` 均不为正则。
 * `|` 不是正则信号：`a|b` 走 compileAlternationLiteral 的分支字面 OR。
 *
 * @param term - 搜索词
 * @returns 是否像正则
 */
export function looksLikeRegex(term: string): boolean {
  if (term.startsWith('^') || term.endsWith('$')) return true;
  // 转义类（\d \w …）或转义元字符（\[ \( …）→ 显式正则意图
  if (/\\[dDwWsSbBnrptfv0-9.*+?^${}()|[\]\\]/.test(term)) return true;
  if (/\.\*|\.\+/.test(term)) return true;
  if (/\{\d+(?:,\d*)?\}/.test(term)) return true;
  return false;
}

/**
 * auto 模式下把 `a|b|c` 编译为「分支字面 OR」
 *
 * 分支各自 trim + 转义后以 `|` 连接（`.` 是字面点，不是通配），
 * 对应模型自然写法 `foo()|a+b`。任一分支为空（`foo|`、`|`、`a||b`）
 * 则放弃（返回 null），整词按字面搜——竖线在正则里是空分支语义，代码里几乎从不想要。
 *
 * @param term - 含 `|` 的搜索词
 * @param flags - 正则标志（大小写敏感性由调用方给）
 * @returns 分支字面 OR 正则；不适合作交替时 null（调用方按整词字面处理）
 */
function compileAlternationLiteral(term: string, flags: string): RegExp | null {
  const branches = term.split('|').map((b) => b.trim());
  if (branches.length < 2 || branches.some((b) => b.length === 0)) return null;
  return new RegExp(branches.map((b) => escapeRegex(b)).join('|'), flags);
}

/**
 * 转义正则特殊字符
 *
 * @param str - 字面量
 * @returns 正则安全的字面量
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 编译内容匹配器（多词 OR）
 *
 * @param terms - 搜索词列表
 * @param requested - 请求的 pattern 模式
 * @param caseSensitive - 是否区分大小写
 * @returns 编译结果
 * @throws Error requested='regex' 且某词编译失败时（auto 下自动回退字面）
 */
export function compileContentMatchers(
  terms: string[],
  requested: PatternMode,
  caseSensitive: boolean,
): ContentMatchers {
  // 无需 `g`：.test() 不用 lastIndex 扫描
  const flags = caseSensitive ? '' : 'i';
  const matchers: RegExp[] = [];
  const sources: string[] = [];
  const compiled: string[] = [];
  const kinds: Array<'literal' | 'regex'> = [];
  let autoForcedLiteral = false;

  for (const term of terms) {
    sources.push(term);
    let asRegex: boolean;
    if (requested === 'regex') asRegex = true;
    else if (requested === 'literal') asRegex = false;
    else asRegex = looksLikeRegex(term);

    let re: RegExp | null = null;
    let forcedLiteral = false;
    if (asRegex) {
      try {
        re = new RegExp(term, flags);
      } catch (error) {
        if (requested === 'regex') {
          throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
        // auto 下像正则但编译失败 → 回退字面量
        forcedLiteral = true;
        autoForcedLiteral = true;
        asRegex = false;
      }
    }
    if (!re && requested === 'auto' && !forcedLiteral && term.includes('|')) {
      // auto 的 `a|b`：分支字面 OR（分支 trim + 转义，`.` 是字面点）；空分支 → 整词字面
      re = compileAlternationLiteral(term, flags);
    }
    if (!re) {
      re = new RegExp(escapeRegex(term), flags);
    }
    matchers.push(re);
    compiled.push(re.source);
    kinds.push(asRegex ? 'regex' : 'literal');
  }

  const usedRegex = kinds.some((k) => k === 'regex');
  const usedLiteral = kinds.some((k) => k === 'literal');
  return {
    mode: usedRegex && usedLiteral ? 'mixed' : usedRegex ? 'regex' : 'literal',
    matchers,
    sources,
    compiled,
    kinds,
    autoForcedLiteral,
  };
}

/**
 * 判断一行是否命中任一匹配器
 *
 * @param line - 文本行
 * @param matchers - 已编译匹配器
 * @returns 是否命中
 */
export function lineMatches(line: string, matchers: RegExp[]): boolean {
  for (const re of matchers) {
    if (re.test(line)) return true;
  }
  return false;
}

/**
 * 收集 pattern 词条（file_search / skill_search 同源；S2 评审 F4）
 *
 * 空白词过滤（空串会编译成匹配一切的空正则）；非字符串项宽容转字符串
 * （tool JSON 入参可能带数字）；全部为空时报错而非静默搜一切。
 *
 * @param args - 工具入参（pattern: string / patterns: array）
 * @returns 非空搜索词数组
 * @throws Error 无有效搜索词时
 */
export function collectPatternTerms(args: Record<string, unknown>): string[] {
  const terms: string[] = [];
  const single = args.pattern;
  if (typeof single === 'string' && single.trim()) terms.push(single);

  const multi = args.patterns;
  if (Array.isArray(multi)) {
    for (const item of multi) {
      const s = typeof item === 'string' ? item : String(item ?? '');
      if (s.trim()) terms.push(s);
    }
  }

  if (terms.length === 0) {
    throw new Error('Provide pattern (string) or patterns (non-empty string[])');
  }
  return terms;
}
