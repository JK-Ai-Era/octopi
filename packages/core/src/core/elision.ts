/**
 * 上下文降级标记词汇表 —— 参数侧生成与检测的唯一权威（OP-TOOL-1）
 *
 * 背景：工具调用参数老化（`harness/context/tool-result-aging`）会把长值降级为
 * 「长度标记」。历史事故（2026-10~11）证明：降级标记一旦与真实内容同形，
 * 就会被模型当真实参数回抄、或在管道中被静默执行——`file_edit` 把 `…[N chars]`
 * 写进文件、`git_commit` 用标记当提交信息、shell 把标记当命令执行。
 *
 * 两条防线（本模块是它们的共同事实源）：
 * 1. **生成端语义隔离**：参数侧降级标记一律使用 `octopi:` 命名空间形态
 *    （`[octopi:elided N chars]`），一眼可辨、不再像正常文本；
 * 2. **执行端统一拒收**：`loop/agent-loop` 在工具派发前用 {@link findElisionMarkers}
 *    扫描参数，命中即 fail-loud 拒绝执行——一个收口覆盖全部经 loop 派发的工具。
 *
 * 词汇归属（诚实声明，勿把「检测」误读为「生成单一来源」）：
 * - **参数侧生成**（本模块导出，生产者 import）：`elidedCharsMarker` /
 *   `elidedCommandTail` / `TRUNCATED_MARK` / `ELIDED_MARK` / `ELIDED_PREVIEW_MARK` /
 *   `TRUNCATED_JSON_PREFIX` / `AGED_POINTER_PREFIX`。
 * - **检测端识别但生成在别处**（结果侧/子系统产物，快照式识别）：
 *   `[aged tool result · pointer]`（pointer 前缀已走本模块）、`[truncated: showing
 *   first N of M chars]`（summary/gate）、`[truncated input for summary]`
 *   （summary/executor）、`[Context truncated:`/`[Context compressed:`/
 *   `[Structural compact]`（compact/messages）。这些文案若原地改写，检测会静默
 *   弱化——改动那几处时请同步本模块的正则。
 * - **旧词汇**（存量污染形态，只检测不生成）：`…[N chars]`、`…[+N chars]`、
 *   `…[N chars, assetId=…]`、`…[truncated…]`、`…[preview omitted]`、
 *   `[... truncated]`、`[truncated JSON]`、`...[evidence truncated]...`。
 *
 * 检测语义（精确匹配，防误伤）：
 * - **整值即标记**：值本身（去首尾空白后）是一个降级标记；
 * - **值以标记收尾**：老化的命令摘要形态 `<头部100字符>[octopi:elided +N chars]`；
 * - **前缀形降级载体**：值以结果侧降级载铁（指针/截断告知）开头；
 * - **结构性降级**：值是老化兜底对象（`_aged` 键）。
 *
 * 刻意不拒绝「正文中间提到标记」的合法内容（讨论本缺陷的文档、测试、CHANGELOG
 * 都会引用标记字面量）；代价是「正文恰好以标记收尾/开头」会被误拒——fail-loud 且
 * 可自愈（错误文案引导模型回源重构），远好于静默写坏数据。
 *
 * 性能契约：检测只看**值尾窗口**（标记必然收尾/整值），长值先做触发子串预筛，
 * 正则输入被窗口常数封顶——1MB 参数不得退化为 O(n²) 扫描（OP-TOOL-1 评审 M1）。
 *
 * @module core/elision
 */

// ── 生成端（当前词汇；参数侧降级生产者使用） ──

/**
 * 值级省略标记：长值被省略时记录被省略的长度
 *
 * @param chars - 被省略内容的长度（生产者口径：JSON 序列化长度）
 * @param note - 可选补充说明（如 `assetId=…`），并入标记括号内
 * @returns 标记文本（如 `[octopi:elided 183 chars]`）
 */
export function elidedCharsMarker(chars: number, note?: string): string {
  return note ? `[octopi:elided ${chars} chars, ${note}]` : `[octopi:elided ${chars} chars]`;
}

/**
 * 命令类字段的尾部省略标记：头部保留后，被省略的剩余长度
 *
 * @param omittedChars - 头部之外被省略的字符数
 * @returns 标记文本（如 `[octopi:elided +30 chars]`）
 */
export function elidedCommandTail(omittedChars: number): string {
  return `[octopi:elided +${omittedChars} chars]`;
}

/** 轮廓截断标记：原文被机械截断（不表长度；生产者为 outline/拼接视图） */
export const TRUNCATED_MARK = '[octopi:truncated]';

/** 整条省略占位（无长度可记时，如 file_search 预览整条省略） */
export const ELIDED_MARK = '[octopi:elided]';

/** 预览整条省略占位（file+line 永远全保；语义区别于通用 ELIDED_MARK） */
export const ELIDED_PREVIEW_MARK = '[octopi:elided: preview]';

/** JSON 整体降级前缀（工具结果封顶的非字符串分支） */
export const TRUNCATED_JSON_PREFIX = '[octopi:truncated JSON]';

/** 老化结果指针前缀（生成在 tool-result-aging / wire-dump-diff，文本共用此常量） */
export const AGED_POINTER_PREFIX = '[aged tool result · pointer]';

// ── 检测端（新旧全词汇；执行边界拒收使用） ──

/** 一次命中：路径 + 命中的标记片段 + 匹配形态 */
export interface ElisionMarkerHit {
  /** 参数内的定位路径，如 `arguments.new_text` / `arguments.steps[0]` */
  path: string;
  /** 命中的标记片段（截断至 64 字符便于入错误文案） */
  marker: string;
  /** 整值即标记 / 以标记收尾 / 前缀形降级载体 / 结构性降级对象 */
  form: 'whole' | 'suffix' | 'prefix' | 'structure';
}

/**
 * 标记家族（整值或值尾匹配；新旧词汇都要认）：
 * - `…[N chars]` / `…[+N chars]` / `…[N chars, assetId=…]`（旧值级/旧命令尾/客户端 html）
 * - `…[truncated]` / `…[truncated N chars]` / `…[truncated: N chars omitted]`（旧轮廓族）
 * - `…[preview omitted]`（旧整条省略）
 * - `[... truncated]`（旧结果封顶尾注）
 * - `[octopi:elided …]` / `[octopi:truncated …]`（当前词汇，含计数/备注变体）
 */
const MARKER_TOKEN_RE =
  /^(…\[[^\]]*chars[^\]]*\]|…\[truncated[^\]]*\]|…\[preview omitted\]|\[\.\.\. truncated\]|\[octopi:elided[^\]]*\]|\[octopi:truncated[^\]]*\])$/;

/** 同上，锚定值尾（命令摘要 `<头部>…[+N chars]` 形态） */
const MARKER_TAIL_RE =
  /(…\[[^\]]*chars[^\]]*\]|…\[truncated[^\]]*\]|…\[preview omitted\]|\[\.\.\. truncated\]|\[octopi:elided[^\]]*\]|\[octopi:truncated[^\]]*\])$/;

/** 触发子串预筛（值尾窗口内先廉价确认，再跑正则；性能契约见模块头） */
const TAIL_TRIGGERS = ['…[', '[octopi:', '[... truncated', '[aged tool result'];

/**
 * 前缀形降级载体（整段即降级产物；值以它开头即命中）：
 * - `[aged tool result · pointer]`：老化结果指针（旧复制事故的主要形态之一）
 * - `[truncated: showing first N of M chars]`：摘要截断告知（summary/gate）
 * - `[truncated input for summary]`：摘要输入截断（summary/executor）
 * - `[Context truncated:` / `[Context compressed:` / `[Structural compact]`：压缩机械占位
 * - `[truncated JSON]` / `[octopi:truncated …]`：结果封顶的头部形态
 */
const DEGRADED_PREFIX_RE =
  /^\[aged tool result · pointer\]|^\[truncated: showing first \d+ of \d+ chars|^\[truncated input for summary\]|^\[Context truncated:|^\[Context compressed:|^\[Structural compact\]|^\[truncated JSON\]|^\[octopi:(elided|truncated)/;

/** 老化兜底对象的保留键（结构上即「参数已被降级」的自白） */
const AGED_FALLBACK_KEY = '_aged';

/** 值尾检测窗口（字符）：所有生成端标记都远短于此，窗口外部分不参与正则 */
const TAIL_SCAN_WINDOW = 512;

/** 整值标记的长度上限（超过即不可能是纯标记） */
const WHOLE_MAX_CHARS = 512;

/** walk 深度上限（防插件变换注入深嵌套/循环结构把守卫拖垮） */
const MAX_WALK_DEPTH = 20;

const MAX_MARKER_IN_ERROR = 64;

function clip(text: string): string {
  return text.length <= MAX_MARKER_IN_ERROR ? text : `${text.slice(0, MAX_MARKER_IN_ERROR)}…`;
}

/**
 * 单值是否整值即降级标记（廉价谓词；预算账目等场景复用）
 *
 * @param value - 待判值
 * @returns 是否整值即标记
 */
export function isElisionToken(value: unknown): boolean {
  return typeof value === 'string' && MARKER_TOKEN_RE.test(value.trim());
}

/**
 * 扫描任意 JSON 值中的降级标记（深度遍历对象/数组）
 *
 * @param value - 待扫描的参数值（工具入参的任意 JSON 形状）
 * @param path - 定位路径前缀（递归用；调用方通常传 `'arguments'`）
 * @returns 命中列表（无命中为空数组；扫描自身绝不抛错——守卫不得比工具先崩）
 */
export function findElisionMarkers(value: unknown, path = 'arguments'): ElisionMarkerHit[] {
  const hits: ElisionMarkerHit[] = [];
  try {
    walk(value, path, hits, 0);
  } catch {
    // 扫描器自身故障不阻断工具执行：拒收防线 fail-open 于自身异常，
    // 但绝不 fail-open 于真实命中（异常只可能来自非 JSON 结构的怪异注入）。
  }
  return hits;
}

function walk(value: unknown, path: string, hits: ElisionMarkerHit[], depth: number): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (typeof value === 'string') {
    scanString(value, path, hits);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, hits, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    // 只走纯对象/数组：Buffer/Map/Date 等宿主对象不遍历（防逐字节展开）
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return;
    if (AGED_FALLBACK_KEY in (value as Record<string, unknown>)) {
      hits.push({ path, marker: AGED_FALLBACK_KEY, form: 'structure' });
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, `${path}.${k}`, hits, depth + 1);
    }
  }
}

function scanString(value: string, path: string, hits: ElisionMarkerHit[]): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) return;

  // 整值即标记（含首尾空白容忍——B1：尾随换行不得绕过防线）
  if (trimmed.length <= WHOLE_MAX_CHARS && MARKER_TOKEN_RE.test(trimmed)) {
    hits.push({ path, marker: clip(trimmed), form: 'whole' });
    return;
  }

  // 值尾窗口预筛 + 正则（M1：正则输入被 TAIL_SCAN_WINDOW 封顶）
  const tail = trimmed.length <= TAIL_SCAN_WINDOW ? trimmed : trimmed.slice(-TAIL_SCAN_WINDOW);
  if (TAIL_TRIGGERS.some((t) => tail.includes(t))) {
    if (MARKER_TAIL_RE.test(tail)) {
      hits.push({
        path,
        marker: clip(tail.slice(Math.max(0, tail.length - MAX_MARKER_IN_ERROR))),
        form: 'suffix',
      });
      return;
    }
  }

  // 前缀形降级载体（值开头；模板字面量天然锚定，长值同样廉价）
  if (DEGRADED_PREFIX_RE.test(trimmed)) {
    hits.push({ path, marker: clip(trimmed), form: 'prefix' });
  }
}

/**
 * 把命中列表渲染为拒绝执行的错误文案（面向模型：是什么、绝不做什么、怎么自愈）
 *
 * @param hits - 命中列表（非空）
 * @returns 错误文案（不含 `Error:` 前缀，由调用方拼接）
 */
export function describeElisionHits(hits: ElisionMarkerHit[]): string {
  const shown = hits
    .slice(0, 3)
    .map((h) => `${h.path}=${h.marker}`)
    .join(', ');
  const more = hits.length > 3 ? ` (+${hits.length - 3} more)` : '';
  return (
    `tool arguments contain context-degradation placeholders (${shown}${more}). ` +
    'These markers are degraded views of older calls — they are not real content and must never be executed or written. ' +
    'Do not resend this call unchanged. Re-derive the full value from the source (file_edit/file_write: re-read the file first; shell/git: re-read the record or retype the full command; task tools: rewrite the note in full), then send a new call with complete arguments. ' +
    'If you cannot reconstruct the full value, stop and report the blocker to the user instead of retrying.'
  );
}
