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
 * 已知的 wrapper 命令
 *
 * wrapper 不是实际执行的命令，而是"包装器"。
 * 例如 sudo npm install → 实际命令是 npm install。
 */
const WRAPPER_COMMANDS = new Set([
  'sudo', 'su',
  'env', 'export',
  'exec', 'nohup',
  'nice', 'time',
  'strace', 'ltrace',
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

  // 第四层：检测管道到 shell
  const hasShellPipe = detectShellPipe(segments, connectors);

  return {
    parsed,
    raw,
    segments,
    connectors,
    hasShellPipe,
    hasSubshell,
    hasBackground,
  };
}

// ── 第一层：按连接符拆分 ──

const CONNECTOR_CHARS = new Set(['|', '&', ';']);

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
      // 单独的 & 是后台执行标记，不算连接符
      current += ch;
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
  const tokens = tokenize(raw);
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
 * 简单的 tokenizer
 *
 * 处理引号和转义字符。
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      escape = true;
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
 * 检测管道到 shell
 *
 * | sh, | bash, | zsh, | dash, | ksh
 */
function detectShellPipe(segments: ParsedSegment[], connectors: Connector[]): boolean {
  const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

  for (let i = 0; i < connectors.length; i++) {
    if (connectors[i] === '|') {
      const nextSeg = segments[i + 1];
      if (nextSeg && SHELL_NAMES.has(nextSeg.command) && nextSeg.args.length === 0) {
        return true;
      }
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
