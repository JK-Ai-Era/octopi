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
let originalWrite: ((s: string) => void) | undefined;

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
 * 静音/恢复共享 readline 的渲染（隐藏输入用）。
 *
 * 单一 stdin 消费者原则（评审 B4）：隐藏输入不另开 readline——第二接口会与
 * 共享队列同吃 stdin（key 进队列 + 双重回显）。这里只临时接管共享接口的
 * 输出渲染（_writeToOutput 是 readline 唯一静音点），行仍走 nextLine 队列。
 */
function setEchoMuted(muted: boolean, promptText: string): void {
  const iface = getRl() as unknown as { _writeToOutput?: (s: string) => void };
  if (muted) {
    originalWrite = iface._writeToOutput?.bind(iface);
    iface._writeToOutput = (s: string): void => {
      if (s.includes(promptText)) process.stdout.write(promptText); // 只显示提示，吞掉键入渲染
    };
  } else if (originalWrite) {
    iface._writeToOutput = originalWrite;
    originalWrite = undefined;
  }
}

/** 关闭共享 readline（向导结束时调用） */
export function closePrompts(): void {
  rl?.close();
  rl = undefined;
  lineQueue.length = 0;
  lineWaiter = null;
  closed = false;
  exhausted = false;
  originalWrite = undefined;
}

/**
 * 问一行文本
 *
 * @param question - 问题文案（含提示）
 * @param opts.default - 回车默认值（可空）
 * @param opts.hidden - 隐藏输入（API Key 用；非 TTY 下退化明文读）
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
    // 隐藏输入：共享 rl 上临时静音渲染（单一 stdin 消费者，评审 B4）；非 TTY 管道下静音无副作用
    process.stdout.write(promptText);
    setEchoMuted(true, promptText);
    const answer = await nextLine();
    setEchoMuted(false, promptText);
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
 * @returns 选中 id；输入 `b` 返回 '__back__'
 */
export async function choose(
  question: string,
  options: Array<{ id: string; label: string; hint?: string }>,
  opts: { defaultId?: string } = {},
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
    const raw = await askText(`选择 (1-${options.length}，回车=${defIndex}，b=回上一步)`, {
      default: String(defIndex),
    });
    if (raw === 'b') return '__back__';
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].id;
    const byId = options.find((o) => o.id === raw);
    if (byId) return byId.id;
    process.stdout.write(`请输入 1-${options.length} 之间的数字\n`);
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
