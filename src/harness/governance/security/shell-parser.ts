/**
 * Shell Parser — 轻量级 Shell 命令解析器
 *
 * 不依赖 tree-sitter，纯字符串解析。
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

// ── Wrapper 命令 ──

/**
 * 已知的解释器名称（管道到解释器 = 执行外部代码）
 *
 * 不止 shell，python/ruby/perl/node 等也是解释器。
 * curl ... | python3 和 curl ... | sh 本质相同。
 */
const INTERPRETER_NAMES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'python', 'python3', 'ruby', 'perl', 'node', 'php',
  'lua', 'tclsh', 'Rscript', 'scala', 'groovy',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe',
]);

/**
 * 已知的内联代码执行参数
 *
 * python -c "...", node -e "...", ruby -e "...", perl -e "..."
 */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  'python': ['-c'], 'python3': ['-c'],
  'node': ['-e', '--eval'],
  'ruby': ['-e'],
  'perl': ['-e'],
  'php': ['-r'],
  'bash': ['-c'], 'sh': ['-c'], 'zsh': ['-c'],
  // Windows shells
  'powershell': ['-Command', '-command', '-c', '-EncodedCommand', '-encodedcommand'],
  'powershell.exe': ['-Command', '-command', '-c', '-EncodedCommand', '-encodedcommand'],
  'pwsh': ['-Command', '-command', '-c', '-EncodedCommand', '-encodedcommand'],
  'pwsh.exe': ['-Command', '-command', '-c', '-EncodedCommand', '-encodedcommand'],
  'cmd': ['/c', '/C', '/k', '/K'],
  'cmd.exe': ['/c', '/C', '/k', '/K'],
};

/**
 * 仅对真正的 wrapper 剥壳。
 *
 * 不要把 cmd/start 放进来：它们的选项（/c、/b）会被误当成命令名，
 * 且 cmd /c 本身就是内联执行，应保留原命令以便 INLINE_CODE_FLAGS 识别。
 */
const WRAPPER_COMMANDS = new Set([
  'sudo', 'env', 'exec', 'nohup', 'strace', 'time',
]);

// ── 解析入口 ──

/**
 * 解析 Shell 命令
 *
 * @param raw - 原始命令字符串
 * @returns 解析结果（parsed: true/false 表示解析是否成功）
 */
export function parseShellCommand(raw: string): ParsedCommand & { parsed: boolean } {
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
  const tokens = mergeSplitWindowsPaths(tokenize(raw));
  if (tokens.length === 0) return null;

  // 提取重定向
  const redirects: Redirect[] = [];
  const cleanTokens: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    // 检测重定向
    if (token === '>' || token === '>>' || token === '<') {
      const target = tokens[i + 1];
      if (!target) return null; // 重定向后没有目标，解析失败

      redirects.push({
        type: token === '>' ? 'overwrite' : token === '>>' ? 'append' : 'input',
        target,
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

    cleanTokens.push(token);
    i++;
  }

  if (cleanTokens.length === 0) return null;

  // 提取 wrapper
  const wrappers: string[] = [];
  let cmdStart = 0;

  while (cmdStart < cleanTokens.length) {
    const token = cleanTokens[cmdStart];
    if (WRAPPER_COMMANDS.has(token)) {
      wrappers.push(token);
      cmdStart++;
      // sudo 可能有 -u user 等参数，跳过
      if (token === 'sudo') {
        while (cmdStart < cleanTokens.length && cleanTokens[cmdStart].startsWith('-')) {
          cmdStart++;
        }
      }
      // env 跳过环境变量（KEY=VALUE 格式）
      if (token === 'env') {
        while (cmdStart < cleanTokens.length && /^[A-Z_][A-Z0-9_]*=/.test(cleanTokens[cmdStart])) {
          cmdStart++;
        }
      }
    } else {
      break;
    }
  }

  if (cmdStart >= cleanTokens.length) return null;

  const command = cleanTokens[cmdStart];
  const args = cleanTokens.slice(cmdStart + 1);

  return {
    command,
    args,
    redirects,
    isSudo: wrappers.includes('sudo'),
    wrappers,
    raw,
  };
}

/**
 * 合并被空格切开的 Windows 绝对路径
 *
 * `del C:\Program Files\App\x.exe` → `C:\Program` + `Files\App\x.exe`
 * → `C:\Program Files\App\x.exe`
 *
 * 规则：当前 token 是盘符/UNC 绝对路径，下一段含路径分隔符，
 * 且当前最后一段无文件扩展名时合并。
 * 已知局限：`cp C:\data backup\old` 也可能被误合并。
 */
function mergeSplitWindowsPaths(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let cur = tokens[i];
    while (i + 1 < tokens.length) {
      if (!/^[A-Za-z]:[\\/]/.test(cur) && !cur.startsWith('\\\\')) break;
      const next = tokens[i + 1];
      if (!next || next.startsWith('-') || next.startsWith('/')) break;
      if (/^[A-Za-z]:[\\/]/.test(next) || next.startsWith('\\\\')) break;
      if (!next.includes('\\') && !next.includes('/')) break;
      const lastSeg = cur.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
      if (lastSeg.includes('.')) break;
      cur = `${cur} ${next}`;
      i++;
    }
    out.push(cur);
    i++;
  }
  return out;
}

/**
 * bash 需要被 `\` 转义的元字符。
 * 其余字符前的 `\` 视为 Windows 路径分隔符并原样保留。
 */
const BASH_ESCAPE_TARGETS = new Set([
  '"', "'", '$', '`', ' ', '\t', '\n',
  '|', '&', ';', '(', ')', '<', '>',
]);

/**
 * 简单的 tokenizer
 *
 * 处理引号和转义字符。
 * Windows 路径（`C:\Windows`、`\\server\share`）中的 `\` 不会被吃掉——
 * 否则保护路径判定会拿到被拆坏的字符串。
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (ch === '\\' && !inSingleQuote) {
      const next = raw[i + 1];
      if (next === undefined) {
        current += ch;
        break;
      }
      // 经典 bash 转义：吃掉 `\`，保留下一字符字面量
      if (BASH_ESCAPE_TARGETS.has(next)) {
        current += next;
        i++;
        continue;
      }
      // Windows 路径分隔符 / UNC：保留 `\`
      current += ch;
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

    if ((ch === ' ' || ch === '\t') && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * 匹配 >file 或 >>file 格式（无空格的重定向）
 */
function matchRedirect(token: string): Redirect | null {
  // 先检查开头的重定向
  if (token.startsWith('>>')) {
    return { type: 'append', target: token.slice(2) };
  }
  if (token.startsWith('>') && token.length > 1) {
    return { type: 'overwrite', target: token.slice(1) };
  }
  if (token.startsWith('<') && token.length > 1) {
    return { type: 'input', target: token.slice(1) };
  }
  // 检查 token 中间的重定向（如 hello>/tmp/out.txt）
  const gtIdx = token.indexOf('>') ;
  if (gtIdx > 0 && gtIdx < token.length - 1) {
    if (token[gtIdx + 1] === '>') {
      return { type: 'append', target: token.slice(gtIdx + 2) };
    }
    return { type: 'overwrite', target: token.slice(gtIdx + 1) };
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
 * 检测后台执行
 */
function detectBackground(cmd: string): boolean {
  const trimmed = cmd.trim();
  return trimmed.endsWith('&') && !trimmed.endsWith('&&');
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
 * 检测内联代码执行
 *
 * python -c "...", node -e "...", bash -c "...",
 * powershell -Command "...", cmd /c "..." 等。
 * 命令名大小写不敏感（Windows shell）。
 */
function detectInlineCode(segments: ParsedSegment[]): boolean {
  for (const seg of segments) {
    const flags =
      INLINE_CODE_FLAGS[seg.command] ??
      INLINE_CODE_FLAGS[seg.command.toLowerCase()];
    if (!flags) continue;
    const argSet = new Set(seg.args.map((a) => a.toLowerCase()));
    if (flags.some((f) => argSet.has(f.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

// ── 导出工具函数 ──

/**
 * 获取所有命令名（不含 wrapper）
 */
export function getCommandNames(parsed: ParsedCommand): string[] {
  return parsed.segments.map(s => s.command);
}

/**
 * 获取所有重定向目标路径
 */
export function getRedirectTargets(parsed: ParsedCommand): string[] {
  return parsed.segments.flatMap(s => s.redirects.map(r => r.target));
}

/**
 * 判断命令是否包含指定的命令名
 */
export function hasCommand(parsed: ParsedCommand, command: string): boolean {
  return parsed.segments.some(s => s.command === command);
}
