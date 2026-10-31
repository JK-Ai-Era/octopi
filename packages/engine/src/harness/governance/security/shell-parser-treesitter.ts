/**
 * Shell Parser (tree-sitter) — 主解析引擎
 *
 * 基于 web-tree-sitter + tree-sitter-bash（vendored wasm，见 vendor/）。
 * 容错解析：引号、`$()`、heredoc、`[[ ]]`、重定向等结构由语法树精确还原，
 * 不再依赖字符串启发式（字符串解析历史上曾在引号内 `2>/dev/null` 类文本上误判）。
 *
 * 适配职责：把 bash 语法树映射回 ParsedCommand/ParsedSegment 契约，
 * 风险评估（risk-evaluator）与降级策略（degradation）无需感知引擎差异。
 *
 * 映射约定：
 * - `variable_assignment`（`VAR=val`）/ `declaration_command`（export/declare/local）
 *   是声明不是命令执行，不产生命令段；值里的 `$(...)` 仍按子 shell 检测。
 * - 命令替换/进程替换/子 shell（`$(...)`、反引号、`<(…)`、`(…)`）里的命令
 *   会真实执行，因此展开为独立命令段参与风险评估。
 * - heredoc 正文是 stdin 数据：字面内容不解析、不产生路径目标；定界符未加引号时
 *   正文里的 `$(...)` 属真实执行，照常展开为命令段。
 * - 整句重定向（如 `for …; done > /dev/null`）挂在句内第一个命令段上；
 *   句内无命令时（`> file` 单独成句）记入 orphanRedirects，仍参与路径评估。
 * - 语法树含 ERROR/MISSING 时返回 null，由 facade 回退 fallback 引擎并标记不确定。
 *
 * 初始化是异步的（WASM 加载）；解析是同步的。生产路径在 Agent 构建时
 * await initShellParser()，未初始化时 facade 自动回退 fallback 引擎。
 */

import type { Parser, Node } from 'web-tree-sitter';

import type {
  ParsedCommand,
  ParsedSegment,
  Connector,
  Redirect,
} from './risk-types.js';
import {
  INTERPRETER_NAMES,
  unescapeToken,
  mergeSplitWindowsPaths,
  unwrapWrapperTokens,
  detectBackground,
  detectInlineCode,
} from './shell-parser-shared.js';

// ── 初始化 ──

let parserInstance: Parser | null = null;
let initPromise: Promise<void> | null = null;

/**
 * 初始化 tree-sitter 解析引擎（幂等）
 *
 * 失败不抛错：降级到 fallback 引擎（parseShellCommand 自动回退），仅告警。
 */
export async function initShellParser(): Promise<void> {
  if (parserInstance) return;
  initPromise ??= doInit();
  await initPromise;
}

async function doInit(): Promise<void> {
  try {
    const { Parser: TsParser, Language: TsLanguage } = await import('web-tree-sitter');
    await TsParser.init();
    const language = await TsLanguage.load(
      new URL('./vendor/tree-sitter-bash.wasm', import.meta.url),
    );
    const instance = new TsParser();
    instance.setLanguage(language);
    parserInstance = instance;
  } catch (err) {
    // 吞掉的是 WASM 加载/编译失败（环境问题，重试不会改变结果）：
    // 解析能力降级到 fallback 引擎，功能不中断；此处是加载失败唯一会到达的路径。
    console.warn('[shell-parser] tree-sitter 初始化失败，回退 fallback 解析器:', err);
  }
}

/**
 * tree-sitter 引擎是否就绪
 *
 * @returns 是否已成功初始化
 */
export function isShellParserReady(): boolean {
  return parserInstance !== null;
}

/**
 * 当前生效的解析引擎
 *
 * @returns 'treesitter' 或 'fallback'
 */
export function getShellParserEngine(): 'treesitter' | 'fallback' {
  return parserInstance ? 'treesitter' : 'fallback';
}

// ── 解析入口 ──

/**
 * 用 tree-sitter 解析 Shell 命令
 *
 * @param raw - 原始命令字符串
 * @returns 解析结果；引擎未就绪、语法树含 ERROR 或内部异常时返回 null（调用方回退）
 */
export function parseShellCommandWithTreeSitter(
  raw: string,
): (ParsedCommand & { parsed: boolean }) | null {
  if (!parserInstance) return null;
  try {
    const tree = parserInstance.parse(raw);
    try {
      if (!tree || tree.rootNode.hasError) return null;
      return mapTree(raw, tree.rootNode);
    } finally {
      // 映射已把数据拷成普通对象；显式释放 WASM 侧树内存（热路径，不等 GC）
      tree?.delete();
    }
  } catch {
    // 吞掉的是 web-tree-sitter 对极端输入的内部异常（如超长/异常字节序列）：
    // 返回 null 由 facade 回退 fallback 并标记不确定；解析本身无其他失败路径。
    return null;
  }
}

// ── 树 → ParsedCommand 映射 ──

interface SpannedSegment {
  seg: ParsedSegment;
  start: number;
  end: number;
}

interface ExtractCtx {
  segments: SpannedSegment[];
  orphans: Redirect[];
}

function mapTree(raw: string, root: Node): ParsedCommand & { parsed: boolean } {
  const ctx: ExtractCtx = { segments: [], orphans: [] };
  extract(root, ctx, null);

  const spanned = ctx.segments.sort((a, b) => a.start - b.start);
  const segments = spanned.map((s) => s.seg);
  const connectors = buildConnectors(raw, spanned);

  return {
    parsed: true,
    raw,
    segments,
    connectors,
    hasShellPipe: detectShellPipe(root),
    hasInlineCode: detectInlineCode(segments),
    hasSubshell: detectSubshellNodes(root),
    hasBackground: detectBackground(raw),
    orphanRedirects: ctx.orphans.length > 0 ? ctx.orphans : undefined,
  };
}

/**
 * 提取命令段
 *
 * @param node - 当前语法树节点
 * @param ctx - 收集器
 * @param spanNode - 整句包装节点（redirected_statement），用于连接符定位
 */
function extract(node: Node, ctx: ExtractCtx, spanNode: Node | null): void {
  switch (node.type) {
    case 'redirected_statement': {
      const redirects: Redirect[] = [];
      let body: Node | null = null;
      for (const child of node.namedChildren) {
        if (child.type === 'file_redirect') {
          const redirect = mapFileRedirect(child);
          if (redirect) redirects.push(redirect);
          // 重定向目标里的命令替换仍会执行
          extract(child, ctx, null);
        } else if (child.type === 'heredoc_redirect') {
          // heredoc 正文是 stdin 数据：字面内容不执行，也不产生路径目标；
          // 但定界符未加引号时正文里的 $(...) 会真实执行
          // （语法树只在未引号 heredoc 中展开命令替换）——照常下钻提取
          extract(child, ctx, null);
        } else if (!body) {
          body = child;
        }
      }
      const before = ctx.segments.length;
      if (body) extract(body, ctx, node);
      if (redirects.length > 0) {
        if (ctx.segments.length > before) {
          // 整句重定向挂在句内第一个命令段上（目标风险由重定向目标评估兜底）
          ctx.segments[before].seg.redirects.push(...redirects);
        } else {
          // 句内无命令（`> file` 单独成句）：目标仍可能是写入，不可丢
          ctx.orphans.push(...redirects);
        }
      }
      return;
    }

    case 'command': {
      const seg = mapCommand(node);
      if (seg) {
        const span = spanNode ?? node;
        ctx.segments.push({ seg, start: span.startIndex, end: span.endIndex });
      }
      break;
    }

    default:
      break;
  }

  // 通用递归：命令替换/子 shell/进程替换里的命令会真实执行
  for (const child of node.namedChildren) {
    extract(child, ctx, null);
  }
}

/**
 * 映射单条命令节点
 *
 * @param node - command 节点
 * @returns 命令段；无命令名（纯赋值等）时返回 null
 */
function mapCommand(node: Node): ParsedSegment | null {
  let commandName: Node | null = null;
  const argNodes: Node[] = [];
  const redirects: Redirect[] = [];
  for (const child of node.namedChildren) {
    // 命令名之前的 KEY=VAL 是环境赋值不是参数；命令名之后的是实参
    if (child.type === 'variable_assignment' && !commandName) continue;
    if (child.type === 'file_redirect') {
      // 挂在命令节点自身的重定向（少见形态）：目标不可静默丢弃
      const redirect = mapFileRedirect(child);
      if (redirect) redirects.push(redirect);
      continue;
    }
    if (child.type === 'heredoc_redirect') continue;
    if (!commandName && child.type === 'command_name') {
      commandName = child;
      continue;
    }
    argNodes.push(child);
  }
  if (!commandName) return null;

  const command = wordValue(commandName);
  const args = argNodes.map(wordValue);
  // Windows 未加引号的空格路径先合并（`del C:\Program Files\App\x.exe`），
  // 再走与 fallback 相同的 wrapper 拆壳；两引擎此语义必须一致
  const unwrapped = unwrapWrapperTokens(mergeSplitWindowsPaths([command, ...args]));
  if (!unwrapped) return null;

  return {
    command: unwrapped.command,
    args: unwrapped.args,
    redirects,
    isSudo: unwrapped.isSudo,
    wrappers: unwrapped.wrappers,
    raw: node.text,
  };
}

/**
 * 映射重定向节点
 *
 * @param node - file_redirect 节点
 * @returns 重定向信息；缺目标时返回 null
 */
function mapFileRedirect(node: Node): Redirect | null {
  let op = '';
  let destination: Node | null = null;
  for (const child of node.children) {
    // 操作符是匿名 token（>、>>、<、&>、>& 等），type 等于原文
    if (child.namedChildren.length === 0 && /^[<>&]+$/.test(child.text)) {
      op += child.text;
      continue;
    }
    if (child.type === 'file_descriptor') continue;
    destination = child;
  }
  if (!destination) return null;

  // fd 复制（`2>&1`、`>&2`）：目标是 fd 号不是路径，沿用 fd:N 标记
  const target =
    destination.type === 'number' && op.includes('&')
      ? `fd:${destination.text}`
      : wordValue(destination);

  let type: Redirect['type'];
  if (op.includes('>>')) type = 'append';
  else if (op.includes('<')) type = 'input';
  else type = 'overwrite';

  return { type, target };
}

/**
 * 提取词值：剥引号、去 bash 转义，插值/命令替换保留原文
 *
 * @param node - 词类节点（word/string/raw_string/number/expansion/…）
 * @returns 风险评估用的词值
 */
function wordValue(node: Node): string {
  switch (node.type) {
    case 'ansi_c_string':
      // $'...' ANSI-C 引用：剥掉 `$'` 与收尾 `'`，按转义规则还原
      return unescapeToken(node.text.slice(2, -1));

    case 'raw_string':
      // 单引号内全字面量（含反斜杠），只剥外层引号
      return node.text.slice(1, -1);

    case 'string':
    case 'concatenation': {
      let out = '';
      for (const child of node.namedChildren) {
        out += wordValue(child);
      }
      return out;
    }

    case 'command_name':
    case 'word':
    case 'number': {
      if (node.namedChildren.length > 0) {
        let out = '';
        for (const child of node.namedChildren) {
          out += wordValue(child);
        }
        return out;
      }
      return unescapeToken(node.text);
    }

    case 'string_content':
      return unescapeToken(node.text);

    default:
      // expansion / simple_expansion / command_substitution / process_substitution /
      // arithmetic_expansion 等：保留原文（内联载荷探测按原文匹配）
      return node.text;
  }
}

// ── 连接符（按相邻命令段之间的原文定位） ──

/**
 * 构建连接符列表
 *
 * @param raw - 原始命令
 * @param spanned - 按源位置排序的命令段
 * @returns 相邻命令段之间的连接符
 */
function buildConnectors(raw: string, spanned: SpannedSegment[]): Connector[] {
  const connectors: Connector[] = [];
  for (let i = 0; i + 1 < spanned.length; i++) {
    const prev = spanned[i];
    const next = spanned[i + 1];
    // 嵌套命令替换（下一段落在上一段源区间内）没有分隔原文，按 ; 处理
    if (next.start < prev.end) {
      connectors.push(';');
      continue;
    }
    const slice = raw.slice(prev.end, next.start);
    const match = slice.match(/\|\||&&|[|;&\n]/);
    connectors.push((match ? match[0] : '\n') as Connector);
  }
  return connectors;
}

// ── 特殊模式检测（结构判定） ──

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

/**
 * 检测管道到解释器（管道最后一级是裸解释器）
 */
function detectShellPipe(root: Node): boolean {
  let found = false;
  walk(root, (n) => {
    if (found || n.type !== 'pipeline') return;
    const named = n.namedChildren;
    if (named.length < 2) return;
    // 末级可能被整句重定向包裹（`a | bash >log | …`）：剥一层再看
    const last = named[named.length - 1];
    const target =
      last.type === 'redirected_statement'
        ? last.namedChildren.find((c) => c.type === 'command')
        : last;
    const seg = target && target.type === 'command' ? mapCommand(target) : null;
    if (seg && INTERPRETER_NAMES.has(seg.command) && seg.args.length === 0) {
      found = true;
    }
  });
  return found;
}

/**
 * 检测子 shell（$(...)、反引号、(...)）
 *
 * 结构判定：单引号里的字面 `$(...)` 不会误报（fallback 的 raw 扫描会）。
 */
function detectSubshellNodes(root: Node): boolean {
  let found = false;
  walk(root, (n) => {
    if (found) return;
    if (n.type === 'command_substitution' || n.type === 'subshell') {
      found = true;
    }
  });
  return found;
}
