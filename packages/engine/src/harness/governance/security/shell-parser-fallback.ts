/**
 * Shell Parser (fallback) — 轻量级 Shell 命令解析器（回退引擎）
 *
 * 纯字符串解析。主引擎是 tree-sitter 适配层（shell-parser-treesitter.ts）；
 * 本解析器在 tree-sitter 不可用或解析报错时回退使用。
 * 入口统一走 shell-parser.ts 的 parseShellCommand。
 *
 * 四层解析：
 *   1. 按 |, &&, ||, ; 拆分 → 命令段
 *   2. 每个命令段 → [wrapper...] + [command, ...args]
 *   3. 识别 >, >>, < 重定向 → 提取目标路径
 *   4. 识别 sudo, env, exec 等 wrapper → 解包实际命令
 *
 * 设计原则：宁可解析不完整，不可解析错误。
 * 遇到无法解析的复杂结构，标记为 parsed: false，交给 LLM 判断。
 */

import type {
  ParsedCommand,
  ParsedSegment,
  Redirect,
  Connector,
} from './risk-types.js';
import {
  INTERPRETER_NAMES,
  BASH_ESCAPE_TARGETS,
  mergeSplitWindowsPaths,
  unwrapWrapperTokens,
  detectBackground,
  detectInlineCode,
} from './shell-parser-shared.js';

// ── 解析入口 ──

/**
 * 解析 Shell 命令（fallback 引擎）
 *
 * @param raw - 原始命令字符串
 * @returns 解析结果（parsed: true/false 表示解析是否成功）
 */
export function parseShellCommandFallback(raw: string): ParsedCommand & { parsed: boolean } {
  const trimmed = raw.trim();

  if (!trimmed) {
    return {
      parsed: true,
      raw,
      segments: [],
      connectors: [],
      hasShellPipe: false,
      hasInlineCode: false,
      hasSubshell: false,
      hasBackground: false,
    };
  }

  // 检测子 shell 和后台执行
  const hasSubshell = detectSubshell(trimmed);
  const hasBackground = detectBackground(trimmed);

  // 第一层：按连接符拆分
  const { parts, connectors } = splitByConnectors(trimmed);

  // 第二、三层：解析每个命令段
  const segments: ParsedSegment[] = [];
  let parsed = true;
  for (const part of parts) {
    const seg = parseSegment(part);
    if (!seg) {
      parsed = false;
      continue;
    }
    segments.push(seg);
  }

  // 第四层：检测特殊模式
  const hasShellPipe = detectPipeToInterpreter(segments, connectors);
  const hasInlineCode = detectInlineCode(segments);

  return {
    parsed,
    raw,
    segments,
    connectors,
    hasShellPipe,
    hasInlineCode,
    hasSubshell,
    hasBackground,
  };
}

// ── 第一层：按连接符拆分 ──

/**
 * 按连接符拆分命令
 *
 * 注意处理引号内的连接符。
 */
function splitByConnectors(cmd: string): { parts: string[]; connectors: Connector[] } {
  const parts: string[] = [];
  const connectors: Connector[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];

    // 转义字符
    if (escape) {
      current += ch;
      escape = false;
      i++;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      current += ch;
      i++;
      continue;
    }

    // 引号状态
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

    // 在引号内，直接追加
    if (inSingleQuote || inDoubleQuote) {
      current += ch;
      i++;
      continue;
    }

    // 检测连接符
    if (ch === '|') {
      if (cmd[i + 1] === '|') {
        // ||
        pushPart(parts, current);
        current = '';
        connectors.push('||');
        i += 2;
        continue;
      } else {
        // |
        pushPart(parts, current);
        current = '';
        connectors.push('|');
        i++;
        continue;
      }
    }

    if (ch === '&') {
      if (cmd[i + 1] === '&') {
        // &&
        pushPart(parts, current);
        current = '';
        connectors.push('&&');
        i += 2;
        continue;
      }
      // `>&` / `N>&M`：文件描述符重定向（2>&1、>&2），不是命令分隔
      if (i > 0 && cmd[i - 1] === '>') {
        current += ch;
        i++;
        continue;
      }
      // `&>` / `&>>`：bash 重定向合一，不是命令分隔
      if (cmd[i + 1] === '>') {
        current += ch;
        i++;
        continue;
      }
      // 单 `&` 既是后台标记也是命令分隔：`true & rm -rf /` 必须拆段
      pushPart(parts, current);
      current = '';
      connectors.push('&');
      i++;
      continue;
    }

    if (ch === ';') {
      pushPart(parts, current);
      current = '';
      connectors.push(';');
      i++;
      continue;
    }

    if (ch === '\n') {
      pushPart(parts, current);
      current = '';
      connectors.push('\n');
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // 最后一段
  pushPart(parts, current);

  return { parts, connectors };
}

function pushPart(parts: string[], current: string): void {
  const trimmed = current.trim();
  if (trimmed) {
    parts.push(trimmed);
  }
}

// ── 第二、三层：解析命令段 ──

/**
 * 解析单个命令段
 *
 * 提取 wrapper、命令、参数、重定向。
 * 遇到无法解析的结构返回 null。
 */
function parseSegment(raw: string): ParsedSegment | null {
  const rawTokens = tokenize(raw);
  if (rawTokens.length === 0) return null;

  // 提取重定向（在 Windows 路径合并之前：目标语义按原始 token 粒度判定）
  const redirects: Redirect[] = [];
  const cleanTokens: string[] = [];
  let i = 0;

  while (i < rawTokens.length) {
    const token = rawTokens[i];

    // 独立重定向操作符（`> file`）：操作符与目标都必须是未引号字面量
    if (
      isUnquotedToken(token) &&
      (token.text === '>' || token.text === '>>' || token.text === '<')
    ) {
      const target = rawTokens[i + 1];
      if (!target || !isUnquotedToken(target)) return null; // 重定向后没有目标，解析失败

      redirects.push({
        type: token.text === '>' ? 'overwrite' : token.text === '>>' ? 'append' : 'input',
        target: target.text,
      });
      i += 2;
      continue;
    }

    // 检测 >file 格式（无空格）
    const redirectMatch = matchRedirect(token);
    if (redirectMatch) {
      redirects.push(redirectMatch);
      i++;
      continue;
    }

    cleanTokens.push(token.text);
    i++;
  }

  if (cleanTokens.length === 0) return null;

  // 提取 wrapper（共享拆壳逻辑：sudo/env/exec 等）
  const unwrapped = unwrapWrapperTokens(mergeSplitWindowsPaths(cleanTokens));
  if (!unwrapped) return null;

  return {
    command: unwrapped.command,
    args: unwrapped.args,
    redirects,
    isSudo: unwrapped.isSudo,
    wrappers: unwrapped.wrappers,
    raw,
  };
}

/**
 * Windows 绝对路径合并见 shell-parser-shared.ts（两个引擎共用）。
 */

/**
 * bash 需要被 `\` 转义的元字符见 shell-parser-shared.ts（两个引擎共用）。
 */

/**
 * tokenizer 输出：token 文本 + 每字符引号来源
 *
 * `quoted[i] === true` 表示 text[i] 来自引号内（字面量）——
 * 引号内的 `<`/`>` 是普通字符，不参与重定向识别。
 */
interface QuotedToken {
  text: string;
  quoted: boolean[];
}

/** token 是否整体未引号 */
function isUnquotedToken(token: QuotedToken): boolean {
  return token.quoted.every((q) => !q);
}

/**
 * 简单的 tokenizer
 *
 * 处理引号和转义字符，逐字符记录引号来源。
 * Windows 路径（`C:\Windows`、`\\server\share`）中的 `\` 不会被吃掉——
 * 否则保护路径判定会拿到被拆坏的字符串。
 */
function tokenize(raw: string): QuotedToken[] {
  const tokens: QuotedToken[] = [];
  let current = '';
  let mask: boolean[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;

  const pushChar = (ch: string, fromQuote: boolean): void => {
    current += ch;
    mask.push(fromQuote);
  };
  const flush = (): void => {
    if (current) {
      tokens.push({ text: current, quoted: mask });
      current = '';
      mask = [];
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const inQuote = inSingleQuote || inDoubleQuote;

    if (ch === '\\' && !inSingleQuote) {
      const next = raw[i + 1];
      if (next === undefined) {
        pushChar(ch, inQuote);
        break;
      }
      // 经典 bash 转义：吃掉 `\`，保留下一字符字面量
      if (BASH_ESCAPE_TARGETS.has(next)) {
        pushChar(next, inQuote);
        i++;
        continue;
      }
      // Windows 路径分隔符 / UNC：保留 `\`
      pushChar(ch, inQuote);
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if ((ch === ' ' || ch === '\t') && !inQuote) {
      flush();
      continue;
    }

    pushChar(ch, inQuote);
  }

  flush();
  return tokens;
}

// ── 重定向识别（matchRedirect，含引号来源判定） ──
/**
 * 匹配 >file 或 >>file 格式（无空格的重定向）
 *
 * 同时识别文件描述符重定向（`2>&1`、`>&2`、`&>file`）。
 * 只在未引号区域识别：引号内的 `<`/`>` 是字面量（bash 语义）——
 * 引号串被压成单 token 后，中缀启发式曾把引号内 `2>/dev/null` 误认成重定向、
 * 其后整段捏造成目标（2026-10 假 critical 误拦的根因），按引号来源精确排除。
 *
 * @param token - token 文本与逐字符引号来源
 * @returns 重定向信息；操作符或目标来自引号内时返回 null（宁可解析不完整，不可解析错误）
 */
function matchRedirect(token: QuotedToken): Redirect | null {
  const { text, quoted } = token;

  /** [from, to) 是否全部未引号 */
  const opAt = (from: number, to: number): boolean => {
    for (let k = from; k < to; k++) {
      if (quoted[k]) return false;
    }
    return true;
  };
  /** 构造重定向；目标区域含引号内容则放弃（目标可能被引号串拼接污染） */
  const make = (type: Redirect['type'], targetFrom: number): Redirect | null => {
    if (!opAt(targetFrom, text.length)) return null;
    return { type, target: text.slice(targetFrom) };
  };

  // `&>` / `&>>`：bash 重定向合一
  if (text.startsWith('&>>') && opAt(0, 3)) {
    return make('append', 3);
  }
  if (text.startsWith('&>') && text.length > 2 && opAt(0, 2)) {
    return make('overwrite', 2);
  }
  // 文件描述符重定向：`2>&1`、`>&2`、`1>&2` 等
  // target 用 fd: 标记，避免被当成路径做风险分类；整个 token 必须未引号
  const fdDup = text.match(/^(\d*)>{1,2}&(\d+)$/);
  if (fdDup && opAt(0, text.length)) {
    return {
      type: text.includes('>>') ? 'append' : 'overwrite',
      target: `fd:${fdDup[2]}`,
    };
  }
  // 先检查开头的重定向
  if (text.startsWith('>>') && opAt(0, 2)) {
    return make('append', 2);
  }
  if (text.startsWith('>') && text.length > 1 && opAt(0, 1)) {
    return make('overwrite', 1);
  }
  if (text.startsWith('<') && text.length > 1 && opAt(0, 1)) {
    return make('input', 1);
  }
  // 检查 token 中间的重定向（如 hello>/tmp/out.txt）；`>&N` 已由 fdDup 覆盖
  const gtIdx = text.indexOf('>');
  if (gtIdx > 0 && gtIdx < text.length - 1 && opAt(gtIdx, gtIdx + 1)) {
    if (text[gtIdx + 1] === '&') {
      return null;
    }
    if (text[gtIdx + 1] === '>') {
      return make('append', gtIdx + 2);
    }
    return make('overwrite', gtIdx + 1);
  }
  return null;
}

// ── 第四层：检测特殊模式 ──

/**
 * 检测子 shell（$(...) 或反引号）
 */
function detectSubshell(cmd: string): boolean {
  // $(...) 模式
  if (cmd.includes('$(')) return true;
  // 反引号模式
  if (cmd.includes('`')) return true;
  return false;
}

/**
 * 检测管道到解释器
 *
 * 不止 sh/bash，python/ruby/perl/node 等也是解释器。
 * curl ... | python3 和 curl ... | sh 本质相同（执行外部代码）。
 */
function detectPipeToInterpreter(segments: ParsedSegment[], connectors: Connector[]): boolean {
  for (let i = 0; i < connectors.length; i++) {
    if (connectors[i] === '|') {
      const nextSeg = segments[i + 1];
      if (nextSeg && INTERPRETER_NAMES.has(nextSeg.command) && nextSeg.args.length === 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 检测内联代码执行（共享实现，见 shell-parser-shared.ts）
 */

// ── 导出工具函数移至 shell-parser.ts facade ──
