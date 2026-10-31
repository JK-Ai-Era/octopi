/**
 * Shell Parser Shared — 解析引擎共享常量与命令拆壳
 *
 * tree-sitter 适配层与 fallback 字符串解析器共用：
 * 解释器名单、内联代码 flag、wrapper 命令拆壳、转义处理。
 * 两个解析引擎必须保持同一套语义，否则风险分档会在引擎切换时漂移。
 */

// ── Wrapper 命令 ──

/** 已知的解释器名称（管道到解释器 = 执行外部代码） */
export const INTERPRETER_NAMES = new Set([
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
export const INLINE_CODE_FLAGS: Record<string, string[]> = {
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
export const WRAPPER_COMMANDS = new Set([
  'sudo', 'env', 'exec', 'nohup', 'strace', 'time',
]);

/** sudo 中带参数值的选项（选项后一个 token 是选项值，不是命令名） */
const SUDO_VALUE_FLAGS = new Set([
  '-u', '-g', '-h', '-p', '-U', '-C', '-D', '-r', '-t', '-T',
  '--user', '--group', '--host', '--prompt', '--role', '--type',
  '--close-from', '--chdir', '--command-timeout',
]);

/** bash 需要被 `\` 转义的元字符。其余字符前的 `\` 视为 Windows 路径分隔符并原样保留。 */
export const BASH_ESCAPE_TARGETS = new Set([
  '"', "'", '$', '`', ' ', '\t', '\n',
  '|', '&', ';', '(', ')', '<', '>',
]);

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
export function mergeSplitWindowsPaths(tokens: string[]): string[] {
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
 * 去除单个 token 的 bash 反斜杠转义（引号已由解析层剥除）。
 *
 * `\` 仅在 BASH_ESCAPE_TARGETS 前被吃掉；其余位置的 `\`
 * 按 Windows 路径分隔符保留（保护路径判定依赖完整路径串）。
 *
 * @param text - token 文本
 * @returns 去转义后的值
 */
export function unescapeToken(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && BASH_ESCAPE_TARGETS.has(text[i + 1])) {
      out += text[i + 1];
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// ── Wrapper 拆壳 ──

/** 拆壳结果 */
export interface UnwrappedCommand {
  /** 真实命令名 */
  command: string;
  /** 真实参数 */
  args: string[];
  /** 剥下的 wrapper 链（如 ['sudo', 'env']） */
  wrappers: string[];
  /** 是否通过 sudo 执行 */
  isSudo: boolean;
}

/**
 * 剥掉 sudo/env/exec 等 wrapper，定位真实命令。
 *
 * @param tokens - 已去除重定向的 token 序列
 * @returns 拆壳结果；wrapper 后无命令残留时返回 null
 */
export function unwrapWrapperTokens(tokens: string[]): UnwrappedCommand | null {
  const wrappers: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!WRAPPER_COMMANDS.has(token)) break;
    wrappers.push(token);
    i++;
    // sudo 的选项：无值选项直接跳过；带值选项连同选项值一起跳过
    if (token === 'sudo') {
      while (i < tokens.length && tokens[i].startsWith('-')) {
        const flag = tokens[i].split('=', 1)[0];
        i++;
        if (SUDO_VALUE_FLAGS.has(flag) && i < tokens.length) {
          i++;
        }
      }
    }
    // env 跳过选项与环境变量（KEY=VALUE 格式）
    if (token === 'env') {
      while (
        i < tokens.length &&
        (tokens[i].startsWith('-') || /^[A-Z_][A-Z0-9_]*=/.test(tokens[i]))
      ) {
        i++;
      }
    }
  }

  if (i >= tokens.length) return null;

  return {
    command: tokens[i],
    args: tokens.slice(i + 1),
    wrappers,
    isSudo: wrappers.includes('sudo'),
  };
}

// ── 特殊模式检测（与引擎无关的原始文本判定） ──

/**
 * 检测后台执行
 *
 * @param cmd - 原始命令字符串
 * @returns 是否以单个 `&` 结尾
 */
export function detectBackground(cmd: string): boolean {
  const trimmed = cmd.trim();
  return trimmed.endsWith('&') && !trimmed.endsWith('&&');
}

/**
 * 检测内联代码执行（按已拆壳的命令段）
 *
 * python -c "...", node -e "...", bash -c "...",
 * powershell -Command "...", cmd /c "..." 等。命令名大小写不敏感（Windows shell）。
 *
 * @param segments - 已拆壳的命令段列表
 * @returns 是否存在内联代码形态
 */
export function detectInlineCode(
  segments: Array<{ command: string; args: string[] }>,
): boolean {
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
