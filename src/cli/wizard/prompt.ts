/**
 * CLI 向导 TTY 提示原语 — 数字列表 + 回车默认项 + 隐藏输入（零第三方依赖）。
 *
 * 约定：所有函数返回用户原始输入（trim 后）；`b` 语义（回上一步）由调用方解释，
 * 本模块不吞。非 TTY（管道/CI）下同样按行读；stdin 读尽（EOF）返回默认值。
 *
 * 行缓冲（e2e 冒烟实证的竞态修复）：readline.question() 只捕获挂起后的下一个
 * 'line' 事件——管道/粘贴多行时后续行会在两次 question 之间被静默丢弃。
 * 这里常驻 'line' 监听进队列，消费方从队列取；无排队行才挂 waiter。
 *
 * @module
 */

import { createInterface } from 'node:readline';

let rl: import('node:readline').Interface | undefined;
const lineQueue: string[] = [];
let lineWaiter: ((line: string) => void) | null = null;
let closed = false;
let exhausted = false;

/** stdin 是否已耗尽（EOF）——向导据此优雅中止，不再绕无效输入死循环 */
export function stdinExhausted(): boolean {
  return exhausted;
}

function getRl(): import('node:readline').Interface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      const waiter = lineWaiter;
      if (waiter) {
        lineWaiter = null;
        waiter(line);
      } else {
        lineQueue.push(line);
      }
    });
    rl.on('close', () => {
      // EOF：标记 closed/exhausted（后续 nextLine 立即 ''），并唤醒挂起的消费者——绝不静默悬挂
      closed = true;
      exhausted = true;
      const waiter = lineWaiter;
      if (waiter) {
        lineWaiter = null;
        waiter('');
      }
    });
  }
  return rl;
}

/** 取下一行（已关闭=EOF 立即 ''；队列优先；空队列挂 waiter） */
function nextLine(): Promise<string> {
  if (closed) {
    exhausted = true;
    return Promise.resolve('');
  }
  getRl();
  const queued = lineQueue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve) => {
    lineWaiter = resolve;
  });
}

/**
 * 隐藏输入的占位回显（逐字符 '*'）——帧渲染纯逻辑（测试直驱 absorb 的写入序列）。
 *
 * 单一 stdin 消费者原则（评审 B4）：隐藏输入不另开 readline——第二接口会与
 * 共享队列同吃 stdin（key 进队列 + 双重回显）。行仍走 nextLine 队列。
 *
 * 拦截点是共享 rl 的 output 面（write 级），不是 _writeToOutput。PTY 实证
 * （Node 24）：键入回显逐字经 _writeToOutput，但退格/方向键/Ctrl-U 触发的整行
 * 重绘里，光标与擦除转义直接写 output，只有文本经 _writeToOutput（且带 rl 的
 * prompt，缺省 '> '）——只静音 _writeToOutput 会让退格把提示行清成「> …」残影。
 * 这里整帧自绘：普通键入逐字输出 '*'（粘贴即成串 '*'），编辑事件整帧重画
 * （提示 + '*'×当前长度），readline 的原始渲染一律吞掉。
 *
 * 换行帧：帧超过一行时（长 API Key 常见）重画要先上移到帧首行再清（\r 回不到
 * 上一行）。行数按显示宽度估算（CJK/全角=2 列），偏大无害（多清一空行）、
 * 终端中途缩放只影响美观。已知取舍：方向键移到行中再插字符时显示光标落在帧尾，
 * 行缓冲本身不受影响（Enter 语义正确）；含 ESC 与文本的合并写入整体丢弃、
 * 紧跟方向键后粘贴 '> ' 开头内容会被误判为重绘（帧自纠，无泄漏）；非 TTY（管道）
 * 下无回显流，行为与原先一致。
 */
export interface MaskedEcho {
  /** 吞掉 readline 的一条渲染写入，必要时向 write 输出占位帧 */
  absorb(chunk: string): void;
  /** 当前占位长度（= 行缓冲可见长度） */
  readonly length: number;
}

/** 显示宽度估算（CJK/全角=2 列；只用于换行帧行数，偏大无害） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

/**
 * 构造占位回显帧渲染器。
 *
 * @param promptText - 提示文本（整帧重画时保留可见）
 * @param write - 帧输出（写真实 stdout）
 * @param opts.columns - 终端列数取值（缺省 process.stdout.columns ?? 80）
 * @param opts.redrawPrefix - rl 整行重绘的行首前缀（rl prompt；缺省 '> '）
 * @returns 占位回显器
 */
export function createMaskedEcho(
  promptText: string,
  write: (s: string) => void,
  opts: { columns?: () => number; redrawPrefix?: string } = {},
): MaskedEcho {
  const redrawPrefix = opts.redrawPrefix ?? '> ';
  const columns = opts.columns ?? ((): number => process.stdout.columns ?? 80);
  const promptWidth = displayWidth(promptText);
  let len = 0;
  let rows = 1; // 上一帧占用行数（换行帧重画需先上移）
  let afterControl = false;
  const frameRows = (): number => Math.max(1, Math.ceil((promptWidth + len) / Math.max(1, columns())));
  return {
    absorb(chunk: string): void {
      if (chunk === '') return;
      if (chunk === '\r' || chunk === '\n' || chunk === '\r\n') return; // Enter：换行由 askText 显式输出（非 TTY 同样成立）
      if (chunk.includes('\x1b')) {
        afterControl = true; // 光标/擦除转义：帧自绘后不转发
        return;
      }
      if (afterControl && chunk.startsWith(redrawPrefix)) {
        // rl 整行重绘（文本带 rl prompt）：按行内容重算占位长度并整帧重画
        len = Array.from(chunk.slice(redrawPrefix.length)).length;
        afterControl = false;
        const up = rows > 1 ? `\x1b[${rows - 1}A` : '';
        write(`\r${up}\x1b[0J${promptText}${'*'.repeat(len)}`);
        rows = frameRows();
        return;
      }
      afterControl = false;
      len += Array.from(chunk).length;
      write('*'.repeat(Array.from(chunk).length));
      rows = frameRows();
    },
    get length(): number {
      return len;
    },
  };
}

let maskedIface: { output?: unknown } | undefined;
let maskedRealOutput: unknown;
let maskedEcho: MaskedEcho | undefined;

/**
 * 开/关共享 readline 的占位回显（隐藏输入用）。
 *
 * @param masked - true = 开启 '*' 占位回显并吞掉原始渲染；false = 恢复原样
 * @param promptText - 提示文本（整帧重画时保留可见）
 */
function setEchoMasked(masked: boolean, promptText: string): void {
  if (!masked) {
    // 只在确有挂起掩码时恢复；否则不得经 getRl() 顺手建出一个 readline（非交互路径的副作用）
    if (maskedIface) {
      maskedIface.output = maskedRealOutput;
      maskedIface = undefined;
      maskedRealOutput = undefined;
      maskedEcho = undefined;
    }
    return;
  }
  const iface = getRl() as unknown as { output?: unknown; getPrompt?: () => string };
  maskedIface = iface;
  maskedRealOutput = iface.output;
  const real = (iface.output ?? process.stdout) as { write: (s: string) => unknown };
  // 重绘前缀跟 rl 的实际 prompt 走（缺省 '> '；若日后给 createInterface 传 prompt 不会静默失配）
  const redrawPrefix = iface.getPrompt?.() || '> ';
  maskedEcho = createMaskedEcho(
    promptText,
    (s) => {
      real.write(s);
    },
    { redrawPrefix },
  );
  iface.output = new Proxy(real, {
    get(target, prop): unknown {
      if (prop === 'write')
        return (s: unknown): boolean => {
          maskedEcho?.absorb(String(s));
          return true;
        };
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** 关闭共享 readline（向导结束时调用） */
export function closePrompts(): void {
  setEchoMasked(false, ''); // 恢复 output 面（挂起的隐藏输入被 EOF 打断时不留代理）
  rl?.close();
  rl = undefined;
  lineQueue.length = 0;
  lineWaiter = null;
  closed = false;
  exhausted = false;
}

/**
 * 问一行文本
 *
 * @param question - 问题文案（含提示）
 * @param opts.default - 回车默认值（可空）
 * @param opts.hidden - 隐藏输入（密码/API Key 用）：内容不回显，逐字符以 '*' 占位
 *   （含粘贴反馈；非 TTY 管道下无回显流，明文读入但不回显）
 * @returns 用户输入（trim）；EOF 返回默认值 ?? ''
 */
export async function askText(
  question: string,
  opts: { default?: string; hidden?: boolean } = {},
): Promise<string> {
  const def = opts.default ?? '';
  const suffix = def ? ` [${def}]` : '';
  const promptText = `${question}${suffix}: `;

  if (opts.hidden) {
    // 隐藏输入：共享 rl 上 '*' 占位回显（单一 stdin 消费者，评审 B4）；非 TTY 管道下无回显流
    process.stdout.write(promptText);
    setEchoMasked(true, promptText);
    const answer = await nextLine();
    setEchoMasked(false, promptText);
    process.stdout.write('\n');
    return answer.trim() || def;
  }

  process.stdout.write(promptText);
  const answer = await nextLine();
  return answer.trim() || def;
}

/**
 * 选一项（数字列表）
 *
 * @param question - 问题文案
 * @param options - 选项（id + 展示文案）
 * @param opts.defaultId - 回车默认项（缺省第一项）
 * @param opts.hint - 自定义提示行（缺省中文「选择 (1-N，回车=…，b=回上一步)」；
 *   语言未定的首步用它给双语 chrome）
 * @param opts.invalidHint - 自定义非法输入提示（缺省中文）
 * @returns 选中 id；输入 `b` 返回 '__back__'
 */
export async function choose(
  question: string,
  options: Array<{ id: string; label: string; hint?: string }>,
  opts: { defaultId?: string; hint?: string; invalidHint?: string } = {},
): Promise<string> {
  const defId = opts.defaultId ?? options[0]?.id;
  process.stdout.write(`\n${question}\n`);
  options.forEach((o, i) => {
    const marker = o.id === defId ? ' *' : '  ';
    const hint = o.hint ? ` — ${o.hint}` : '';
    process.stdout.write(`${marker} ${i + 1}. ${o.label}${hint}\n`);
  });
  const defIndex = Math.max(0, options.findIndex((o) => o.id === defId)) + 1;

  for (;;) {
    const raw = await askText(opts.hint ?? `选择 (1-${options.length}，回车=${defIndex}，b=回上一步)`, {
      default: String(defIndex),
    });
    if (raw === 'b') return '__back__';
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].id;
    const byId = options.find((o) => o.id === raw);
    if (byId) return byId.id;
    process.stdout.write(`${opts.invalidHint ?? `请输入 1-${options.length} 之间的数字`}\n`);
  }
}

/**
 * 是/否确认
 *
 * @param question - 问题文案
 * @param opts.defaultYes - 回车默认（缺省 yes）
 * @returns 是否确认
 */
export async function confirm(question: string, opts: { defaultYes?: boolean } = {}): Promise<boolean> {
  const def = opts.defaultYes !== false;
  const raw = await askText(`${question} (y/n)`, { default: def ? 'y' : 'n' });
  return /^y(es)?$/i.test(raw);
}
