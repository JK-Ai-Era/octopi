/**
 * playwright 后端 — BrowserPort 的 Playwright 实现（arch/browser-capability.md §3.3）
 *
 * 可选依赖纪律：`playwright-core` 经 optionalDependencies 提供，运行时动态 import
 * （零编译期耦合，结构化类型自描述）；缺失/浏览器二进制缺失时 fail-loud
 * （`not_implemented` + 安装指引），不装哑 stub。
 *
 * 请求级策略（arch/browser-capability.md §3.6）：经 CDP Fetch 域逐请求暂停
 * 对**每个网络请求**（含重定向/子资源/页内导航）执行注入的 BrowserRequestPolicy——
 * URL 判定与外部写闸门在网络层收口，DOM 层敏感标记只是提前预判。
 */

import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { BROWSER_DEFAULT_TIMEOUT_MS } from '../../harness/extension/plugin-ecosystem/tools/browser-types.js';

import type {
  ActResult,
  ActionIntent,
  BrowserAttachOptions,
  BrowserEngineId,
  BrowserIdentity,
  BrowserLaunchOptions,
  BrowserPort,
  BrowserRequestPolicy,
  BrowserSession,
  BrowserSessionId,
  BrowserSessionInfo,
  ChallengeInfo,
  ElementRef,
  ExtractOutcome,
  ExtractSpec,
  GotoOptions,
  GotoResult,
  PageAction,
  PageSnapshot,
  ScreenshotOptions,
  ScreenshotResult,
  SnapshotItem,
  SnapshotOptions,
  SnapshotTag,
} from '../../harness/extension/plugin-ecosystem/tools/browser-types.js';

/** playwright-core 的最小编译期零耦合结构（运行时再 import 校验） */
interface PwLocator {
  click(options?: unknown): Promise<void>;
  fill(value: string, options?: unknown): Promise<void>;
  selectOption(value: string, options?: unknown): Promise<unknown>;
  check(options?: unknown): Promise<void>;
  uncheck(options?: unknown): Promise<void>;
  hover(options?: unknown): Promise<void>;
  press(key: string, options?: unknown): Promise<void>;
  screenshot(options?: unknown): Promise<Uint8Array>;
  count(): Promise<number>;
  setInputFiles(path: string, options?: unknown): Promise<void>;
}
interface PwPage {
  goto(url: string, options?: unknown): Promise<{ status(): number } | null>;
  url(): string;
  title(): Promise<string>;
  close(): Promise<void>;
  evaluate<R>(fn: (arg: unknown) => R, arg?: unknown): Promise<R>;
  locator(selector: string): PwLocator;
  screenshot(options?: unknown): Promise<Uint8Array>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  on(event: string, handler: (...args: never[]) => void): unknown;
  mainFrame(): unknown;
  /** 打开本页的源页面（弹窗归属判定：attach 模式不得误关用户自己的标签） */
  opener(): Promise<PwPage | null>;
}
interface PwBrowserContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
  newCDPSession(page: PwPage): Promise<PwCDPSession>;
  storageState(options?: unknown): Promise<unknown>;
}
interface PwBrowser {
  newContext(options?: unknown): Promise<PwBrowserContext>;
  contexts(): PwBrowserContext[];
  close(): Promise<void>;
}
interface PwChromium {
  launch(options?: unknown): Promise<PwBrowser>;
  /** CDP 接入已打开的浏览器（attach；close 语义 = 断开，不杀浏览器） */
  connectOverCDP(endpoint: string, options?: unknown): Promise<PwBrowser>;
}
interface PwModule {
  chromium: PwChromium;
}
/** CDP Fetch 域（网络栈级逐请求拦截；重定向每跳都停） */
interface PwCDPSession {
  on(event: 'Fetch.requestPaused', handler: (e: CdpRequestPaused) => void): void;
  send(method: string, params?: unknown): Promise<unknown>;
}
interface CdpRequestPaused {
  requestId: string;
  request: { url: string; method: string };
  resourceType?: string;
}

// ── 页内 DOM 走查（page.evaluate 序列化到浏览器执行；最小结构类型，不引 lib.dom） ──

interface DomEl {
  tagName: string;
  type?: string;
  value?: string;
  checked?: boolean;
  children: ArrayLike<DomEl>;
  getClientRects(): { length: number };
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  innerText?: string;
  textContent?: string | null;
}

interface RawSnapshotEntry {
  ref?: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  tags?: SnapshotTag[];
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=option]',
  '[role=switch]',
  '[role=textbox]',
  '[contenteditable="true"]',
].join(',');

const TEXTY_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'PRE']);

// 网络层外部写方法（非 GET/HEAD/OPTIONS）
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 挑战页识别标记（启发式、刻意小表；命中透出 marker，漏检是已知边界）。
// `titleOnly` 标记（captcha 一类）只匹配标题——正文子串极易在帮助页/文档里误伤（评审 F11）
const CHALLENGE_MARKERS: Array<{ kind: ChallengeInfo['kind']; marker: string; titleOnly?: boolean }> =
  [
    { kind: 'interstitial', marker: 'just a moment' }, // Cloudflare
    { kind: 'interstitial', marker: 'attention required' },
    { kind: 'interstitial', marker: 'checking your browser' },
    { kind: 'interstitial', marker: 'enable javascript and cookies' },
    { kind: 'captcha', marker: 'captcha', titleOnly: true },
    { kind: 'captcha', marker: '人机验证', titleOnly: true },
    { kind: 'captcha', marker: '安全验证', titleOnly: true },
    { kind: 'captcha', marker: 'verify you are human', titleOnly: true },
  ];



let pwModulePromise: Promise<PwModule> | undefined;

/** profile 文件存在性（不存在 = 全新身份，从零开始；不抛） */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 隔离不可用的 storageState 档（改名保留现场，不静默删）；返回是否隔离成功 */
async function quarantineProfileState(path: string): Promise<boolean> {
  try {
    const { rename } = await import('node:fs/promises');
    await rename(path, `${path}.corrupt-${Date.now()}`);
    return true;
  } catch {
    // 隔离失败：调用方禁用 persist（不得覆盖现场）；后续 launch 仍会撞同一错（fail-loud 仍在）
    return false;
  }
}

async function resolvePlaywright(): Promise<PwModule> {
  if (!pwModulePromise) {
    pwModulePromise = (async () => {
      // 变量 specifier：编译期零解析（可选依赖缺席时 tsc 也能过）；运行期解析缺席即 fail-loud
      const spec = 'playwright-core';
      try {
        return (await import(spec)) as unknown as PwModule;
      } catch (err) {
        pwModulePromise = undefined; // 允许安装后重试
        throw new Error(
          'not_implemented: browser engine not installed (playwright-core) — run "octopi browser install"',
          { cause: err },
        );
      }
    })();
  }
  return pwModulePromise;
}

/** chromium 启动失败→安装指引（二进制缺失 fail-loud，不静默换引擎） */
function mapLaunchError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/executable|browser.*not.*(found|installed)|doesn't exist/i.test(message)) {
    return new Error(
      `not_implemented: browser engine not installed (chromium) — run "octopi browser install" (${message})`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

const PAGE_WALK_FN = (arg: unknown) => {
  const { epoch, interactiveOnly, selector, textyTags } = arg as {
    epoch: number;
    interactiveOnly: boolean;
    selector: string;
    textyTags: string[];
  };
  const doc = (globalThis as unknown as { document: { body: DomEl } }).document;
  const texty = new Set(textyTags);
  const out: RawSnapshotEntry[] = [];
  let n = 0;

  const visible = (el: DomEl): boolean => el.getClientRects().length > 0;
  const nameOf = (el: DomEl): string =>
    el.getAttribute('aria-label') ||
    (el.innerText || el.textContent || '').trim().slice(0, 120) ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.getAttribute('name') ||
    '';
  const tagsOf = (el: DomEl): SnapshotTag[] => {
    const tags: SnapshotTag[] = [];
    if (el.type === 'password') tags.push('password');
    if (el.type === 'submit' || el.type === 'image') tags.push('submit');
    if (el.type === 'file') tags.push('file');
    if (/^H[1-6]$/.test(el.tagName)) tags.push('heading');
    return tags;
  };
  const roleOf = (el: DomEl): string => {
    const attrRole = el.getAttribute('role');
    if (attrRole) return attrRole;
    const t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      if (el.type === 'checkbox') return 'checkbox';
      if (el.type === 'radio') return 'radio';
      if (el.type === 'submit' || el.type === 'image') return 'button';
      return 'textbox';
    }
    return t.toLowerCase();
  };

  const walk = (node: DomEl): void => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      if (!visible(child)) continue;
      const interactive = child.matches(selector);
      const isHeading = /^H[1-6]$/.test(tag);
      const isTexty = texty.has(tag);
      if (interactive) {
        n += 1;
        const ref = `r${epoch}-e${n}`;
        child.setAttribute('data-octopi-ref', ref);
        const entry: RawSnapshotEntry = {
          ref,
          role: roleOf(child),
          name: nameOf(child),
        };
        const tags = tagsOf(child);
        if (tags.length) entry.tags = tags;
        if (child.value !== undefined && child.value !== '') entry.value = child.value.slice(0, 200);
        if (child.type === 'checkbox' || child.type === 'radio') entry.checked = Boolean(child.checked);
        out.push(entry);
      } else if (!interactiveOnly && (isHeading || isTexty)) {
        const text = (child.innerText || child.textContent || '').trim().slice(0, 300);
        if (text) {
          const entry: RawSnapshotEntry = {
            role: isHeading ? 'heading' : 'text',
            name: text,
          };
          const tags = tagsOf(child);
          if (tags.length) entry.tags = tags;
          out.push(entry);
        }
      }
      walk(child);
    }
  };
  walk(doc.body);
  return out;
};

export class PlaywrightBrowserSession implements BrowserSession {
  readonly id: BrowserSessionId;
  readonly engine: BrowserEngineId;
  readonly identity: BrowserIdentity;
  readonly ownerKey: string;
  /** 当前快照的 ref 元数据（ref 绑定快照代数；导航/重渲染即失效） */
  private readonly refMeta = new Map<string, { role: string; name: string; tags: SnapshotTag[] }>();
  private epoch = 0;
  /** 最近一次被策略拦截的 URL/原因（goto 报错时给人话，不裸抛 ERR_BLOCKED_BY_CLIENT） */
  private lastBlock: { url: string; reason: string } | undefined;
  private closed = false;

  constructor(
    private readonly browser: PwBrowser,
    private readonly context: PwBrowserContext,
    private readonly page: PwPage,
    private readonly actionTimeoutMs: number,
    ownerKey: string,
    private readonly onClosed?: (id: BrowserSessionId) => void,
    private readonly sessionOptions?: {
      identity?: BrowserIdentity;
      /** 引擎标识（attach 会话报 cdp-attach，不谎报 playwright） */
      engine?: BrowserEngineId;
      /** attach：只关自己开的页 + 断开连接；managed：关 context + browser */
      closeMode?: 'managed' | 'attach';
      /** 持久 profile 归档（managed + persist 才生效；attach 是用户活身份，不归档） */
      profile?: { id: string; dir: string; persist: boolean };
    },
  ) {
    this.id = `bs_${randomUUID()}` as BrowserSessionId;
    this.engine = sessionOptions?.engine ?? 'playwright';
    this.identity = sessionOptions?.identity ?? { kind: 'incognito' };
    this.ownerKey = ownerKey;
    // 顶层导航（goto 与 act 引起的跳转都算）→ 旧 ref 全失效（stale_ref 契约对 act 导航成立）
    (page as unknown as { on(event: string, cb: (frame: unknown) => void): void }).on(
      'framenavigated',
      (frame: unknown) => {
        if (frame === page.mainFrame()) this.invalidateRefs();
      },
    );
  }

  /** 策略拦截回调（port 路由处理器注入） */
  noteBlocked(url: string, reason: string): void {
    this.lastBlock = { url, reason };
  }

  /**
   * ref 全失效（导航时由监听触发）。epoch 保持单调递增——
   * **不得归零**：归零会让导航前后的 ref 命名空间碰撞（旧 ref 静默命中新页面元素）。
   */
  private invalidateRefs(): void {
    this.refMeta.clear();
  }

  get url(): string {
    return this.page.url();
  }

  async goto(url: string, options?: GotoOptions): Promise<GotoResult> {
    this.lastBlock = undefined;
    let resp: { status(): number } | null;
    try {
      resp = await this.page.goto(url, {
        waitUntil: options?.waitUntil ?? 'load',
        timeout: options?.timeoutMs ?? this.actionTimeoutMs,
      });
    } catch (err) {
      throw this.mapBlockedError(err);
    }
    const result: GotoResult = { url: this.page.url(), title: await this.page.title() };
    // 无 HTTP 响应（同文档导航/特殊 scheme）时省略 status，不编造
    const status = resp?.status();
    if (typeof status === 'number') result.status = status;
    return result;
  }

  /** 策略拦截导致的失败 → 报人话原因（不裸抛 ERR_BLOCKED_BY_CLIENT） */
  private mapBlockedError(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    if (this.lastBlock && /ERR_BLOCKED_BY_CLIENT|net::ERR/.test(message)) {
      return new Error(this.lastBlock.reason);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    this.epoch += 1;
    this.refMeta.clear();
    const raw = await this.page.evaluate(PAGE_WALK_FN, {
      epoch: this.epoch,
      interactiveOnly: options?.interactiveOnly ?? false,
      selector: INTERACTIVE_SELECTOR,
      textyTags: [...TEXTY_TAGS],
    });

    const maxChars = options?.maxChars ?? 8000;
    let cost = 0;
    let truncated = false;
    const items: SnapshotItem[] = [];
    for (const entry of raw) {
      const item: SnapshotItem = entry.ref
        ? {
            ref: entry.ref as ElementRef,
            role: entry.role,
            name: entry.name,
            ...(entry.value === undefined ? {} : { value: entry.value }),
            ...(entry.checked === undefined ? {} : { checked: entry.checked }),
            ...(entry.tags?.length ? { tags: entry.tags } : {}),
          }
        : { role: entry.role === 'heading' ? 'heading' : 'text', name: entry.name };
      cost += item.name.length + ('value' in item ? item.value?.length ?? 0 : 0);
      if (cost > maxChars) {
        truncated = true;
        break;
      }
      items.push(item);
      if (entry.ref) {
        this.refMeta.set(entry.ref, {
          role: entry.role,
          name: entry.name,
          tags: entry.tags ?? [],
        });
      }
    }
    return {
      url: this.page.url(),
      title: await this.page.title(),
      items,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  async inspectAction(action: PageAction): Promise<ActionIntent> {
    const target = 'ref' in action && action.ref ? this.refMeta.get(action.ref) : undefined;
    if ('ref' in action && action.ref && !target) {
      throw new Error(`stale_ref: ${action.ref} is not in the latest snapshot — call browser_snapshot`);
    }
    let sensitive: false | { kind: 'passwordField' | 'formSubmit' | 'fileUpload'; description: string } =
      false;
    if (target?.tags.includes('password') && action.kind === 'fill') {
      sensitive = {
        kind: 'passwordField',
        description: `fill password field "${target.name || 'password'}"`,
      };
    } else if (target?.tags.includes('submit') && action.kind === 'click') {
      sensitive = {
        kind: 'formSubmit',
        description: `submit form via "${target.name || 'submit'}"`,
      };
    } else if (action.kind === 'upload') {
      sensitive = {
        kind: 'fileUpload',
        description: `upload file to "${target?.name || 'file input'}"`,
      };
    }
    return {
      action,
      sensitive,
      ...(target ? { target: { role: target.role, name: target.name } } : {}),
    };
  }

  async act(action: PageAction): Promise<ActResult> {
    try {
      await this.runAction(action);
    } catch (err) {
      // act 引起的导航被策略拦截时同样报人话原因（与 goto 同一映射）
      throw this.mapBlockedError(err);
    }
    return { ok: true, url: this.page.url(), title: await this.page.title() };
  }

  private async runAction(action: PageAction): Promise<void> {
    const locatorFor = async (ref: ElementRef): Promise<PwLocator> => {
      if (!this.refMeta.has(ref)) {
        throw new Error(`stale_ref: ${ref} is not in the latest snapshot — call browser_snapshot`);
      }
      const loc = this.page.locator(`[data-octopi-ref="${ref}"]`);
      // DOM 重渲染会抹掉属性：找不到目标即 stale_ref fail-loud（不 30s 干等）
      if ((await loc.count()) === 0) {
        throw new Error(
          `stale_ref: ${ref} no longer present in the page (re-rendered?) — call browser_snapshot`,
        );
      }
      return loc;
    };

    switch (action.kind) {
      case 'click':
        await (await locatorFor(action.ref)).click({ timeout: this.actionTimeoutMs });
        break;
      case 'fill':
        await (await locatorFor(action.ref)).fill(action.value, { timeout: this.actionTimeoutMs });
        break;
      case 'select':
        await (await locatorFor(action.ref)).selectOption(action.value, {
          timeout: this.actionTimeoutMs,
        });
        break;
      case 'check':
        await (await locatorFor(action.ref)).check({ timeout: this.actionTimeoutMs });
        break;
      case 'uncheck':
        await (await locatorFor(action.ref)).uncheck({ timeout: this.actionTimeoutMs });
        break;
      case 'hover':
        await (await locatorFor(action.ref)).hover({ timeout: this.actionTimeoutMs });
        break;
      case 'press':
        if (action.ref) {
          await (await locatorFor(action.ref)).press(action.key, {
            timeout: this.actionTimeoutMs,
          });
        } else {
          await this.page.keyboard.press(action.key);
        }
        break;
      case 'scroll':
        await this.page.mouse.wheel(0, action.deltaY);
        break;
      case 'wait':
        await this.page.waitForTimeout(Math.min(Math.max(action.ms, 0), 10_000));
        break;
      case 'upload':
        await (await locatorFor(action.ref)).setInputFiles(action.path, {
          timeout: this.actionTimeoutMs,
        });
        break;
    }
  }

  /**
   * 挑战页启发式识别（arch/browser-capability.md §3.7）。
   * 标记表刻意小而诚实：命中即透出 kind+marker，不装懂（漏检是已知边界）。
   */
  async detectChallenge(): Promise<ChallengeInfo | undefined> {
    const probe = await this.page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { title: string; body: { innerText?: string } | null } })
        .document;
      return {
        title: (doc.title || '').toLowerCase(),
        text: ((doc.body?.innerText || '') as string).slice(0, 4000).toLowerCase(),
      };
    });
    for (const entry of CHALLENGE_MARKERS) {
      const haystack = entry.titleOnly ? probe.title : `${probe.title}\n${probe.text}`;
      if (haystack.includes(entry.marker)) {
        return { kind: entry.kind, marker: entry.marker };
      }
    }
    return undefined;
  }

  /** 确定性结构化抽取（CSS 选择器 → 真实数据；无匹配字段/属性 = null，不编造） */
  async extract(spec: ExtractSpec): Promise<ExtractOutcome> {
    return this.page.evaluate((rawSpec) => {
      const doc = (
        globalThis as unknown as {
          document: {
            querySelectorAll(sel: string): ArrayLike<{
              getAttribute(name: string): string | null;
              textContent?: string | null;
            }>;
          };
        }
      ).document;
      const out: Record<string, string | Array<string | null> | null> = {};
      const counts: Record<string, number> = {};
      let truncated = false;
      for (const [key, field] of Object.entries(
        rawSpec as Record<
          string,
          { selector: string; attribute?: string; multiple?: boolean; maxItems?: number }
        >,
      )) {
        const els = Array.from(doc.querySelectorAll(field.selector));
        const pick = (el: {
          getAttribute(n: string): string | null;
          textContent?: string | null;
        }): string | null =>
          field.attribute
            ? el.getAttribute(field.attribute) // 属性缺失 = null（如实，不编空串）
            : ((el.textContent ?? '') as string).trim();
        // multiple 预算：maxItems（缺省 50）截断并回报命中总数（评审 N5：截断≠全量）
        const maxItems =
          typeof field.maxItems === 'number' && field.maxItems > 0 ? field.maxItems : 50;
        if (field.multiple) {
          counts[key] = els.length;
          if (els.length > maxItems) truncated = true;
          out[key] = els.slice(0, maxItems).map(pick);
        } else {
          out[key] = els.length > 0 ? pick(els[0]) : null;
        }
      }
      return { data: out, truncated, counts };
    }, spec as unknown);
  }

  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const type = options?.type === 'jpeg' ? 'jpeg' : 'png';
    const data =
      options?.ref != null
        ? await this.locatorForScreenshot(options.ref).screenshot({ type })
        : await this.page.screenshot({ type, ...(options?.fullPage ? { fullPage: true } : {}) });
    return { mimeType: type === 'jpeg' ? 'image/jpeg' : 'image/png', data };
  }

  private locatorForScreenshot(ref: ElementRef): PwLocator {
    if (!this.refMeta.has(ref)) {
      throw new Error(`stale_ref: ${ref} is not in the latest snapshot — call browser_snapshot`);
    }
    return this.page.locator(`[data-octopi-ref="${ref}"]`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.refMeta.clear();
    // 两个关闭步骤都尽力执行；无论成败都自报（否则端口表残留死会话）
    let firstError: unknown;
    // profile 归档必须在上下文关闭前（storageState 需要活上下文）；失败如实带出（登录态未存盘）
    const profile = this.sessionOptions?.profile;
    if (profile?.persist && this.sessionOptions?.closeMode !== 'attach') {
      try {
        await this.persistProfileState(profile);
      } catch (err) {
        firstError = err;
      }
    }
    try {
      if (this.sessionOptions?.closeMode === 'attach') {
        // attach：只关我们开的页 + 断开连接——绝不动用户的上下文/浏览器（close=断开，已实证）。
        // 页已被用户手动关掉时 close 会抛：目标已达成，幂等化不冒泡（评审 F15）
        await this.page.close().catch(() => {
          /* 用户已自行关页：视为目标达成 */
        });
      } else {
        await this.context.close();
      }
    } catch (err) {
      firstError ??= err;
    }
    try {
      await this.browser.close();
    } catch (err) {
      firstError ??= err;
    }
    this.onClosed?.(this.id);
    if (firstError) throw firstError;
  }

  private async persistProfileState(profile: { id: string; dir: string }): Promise<void> {
    const state = await this.context.storageState();
    const { mkdir, rename, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // storageState 含全部站点 cookie（凭据级）：目录 0700、文件 0600、原子替换（评审 F6）
    await mkdir(profile.dir, { recursive: true, mode: 0o700 });
    const target = join(profile.dir, `${profile.id}.json`);
    const tmp = `${target}.tmp-${randomUUID()}`;
    await writeFile(tmp, typeof state === 'string' ? state : JSON.stringify(state), {
      mode: 0o600,
    });
    await rename(tmp, target); // 半写 JSON 会把 profile 永久 brick——必须原子落盘
  }
}

/** Playwright BrowserPort 实现 */
export class PlaywrightBrowserPort implements BrowserPort {
  private readonly sessions = new Map<BrowserSessionId, PlaywrightBrowserSession>();

  constructor(
    private readonly defaults: {
      headless?: boolean;
      channel?: 'chromium' | 'chrome';
      viewport?: { width: number; height: number };
      locale?: string;
      timeoutMs?: number;
      /** attach 引擎模式：launch() 派发到 attach（engine='cdp-attach'） */
      attachMode?: boolean;
      /** attach 默认 CDP 端点 */
      attachEndpoint?: string;
    } = {},
  ) {}

  async launch(options?: BrowserLaunchOptions): Promise<BrowserSession> {
    // attach 引擎：会话建立在用户已打开的真实浏览器上（复用登录/指纹）
    if (this.defaults.attachMode) {
      return this.attach({
        endpoint: this.defaults.attachEndpoint,
        timeoutMs: options?.timeoutMs,
        ownerKey: options?.ownerKey,
        policy: options?.policy,
      });
    }
    const pw = await resolvePlaywright();
    const channel = options?.channel ?? this.defaults.channel;
    let browser: PwBrowser;
    try {
      browser = await pw.chromium.launch({
        headless: options?.headless ?? this.defaults.headless ?? true,
        ...(channel === 'chrome' ? { channel: 'chrome' } : {}),
      });
    } catch (err) {
      throw mapLaunchError(err);
    }

    // 持久 profile：恢复既有 storageState（文件不存在 = 全新，如实从零开始）
    const profile =
      options?.profileId && options?.profileDir
        ? {
            id: options.profileId,
            dir: options.profileDir,
            persist: options.persistProfile ?? false,
          }
        : undefined;
    const statePath = profile ? join(profile.dir, `${profile.id}.json`) : undefined;
    const storageState = statePath && (await fileExists(statePath)) ? statePath : undefined;

    const newContextPage = async (state?: string) => {
      const context = await browser.newContext({
        ...(state ? { storageState: state } : {}),
        ...(options?.viewport ?? this.defaults.viewport
          ? { viewport: options?.viewport ?? this.defaults.viewport }
          : {}),
        ...(options?.locale ?? this.defaults.locale
          ? { locale: options?.locale ?? this.defaults.locale }
          : {}),
      });
      return { context, page: await context.newPage() };
    };
    let created: { context: PwBrowserContext; page: PwPage };
    try {
      created = await newContextPage(storageState);
    } catch (err) {
      if (!storageState) {
        // context/page 建失败必须回收 browser，否则泄漏浏览器进程
        await browser.close().catch(() => {
          /* 已失败路径上再失败不掩盖首错 */
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
      // storageState 损坏/不兼容：隔离坏档（保留现场）并从零开始——显式降级不 brick（评审 F6）
      const quarantined = await quarantineProfileState(storageState);
      console.warn(
        `[browser] profile state unusable, ${quarantined ? 'quarantined' : 'quarantine FAILED'} and starting fresh: ${storageState}`,
      );
      if (!quarantined && profile) {
        // 隔离失败：close 时不得再写覆盖坏档（现场优先于归档，评审 N6）
        profile.persist = false;
        console.warn('[browser] refusing to overwrite the corrupt profile file on close (persist disabled)');
      }
      try {
        created = await newContextPage(undefined);
      } catch (err2) {
        await browser.close().catch(() => {
          /* 同上 */
        });
        throw err2 instanceof Error ? err2 : new Error(String(err2));
      }
    }
    const { context, page } = created;

    const session = new PlaywrightBrowserSession(
      browser,
      context,
      page,
      options?.timeoutMs ?? this.defaults.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS,
      options?.ownerKey ?? '',
      (id) => {
        this.sessions.delete(id);
      },
      {
        identity: profile ? { kind: 'profile', profileId: profile.id } : { kind: 'incognito' },
        closeMode: 'managed',
        ...(profile ? { profile } : {}),
      },
    );
    try {
      await this.installRequestPolicy(context, page, options?.policy, (url, reason) =>
        session.noteBlocked(url, reason),
      );
    } catch (err) {
      // 策略安装失败 = 会话不可安全使用：回收 browser（否则泄漏进程且无策略裸奔）
      await browser.close().catch(() => {
        /* 回收失败不掩盖首错 */
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.installPopupGuard(context, page, options?.policy, 'managed');
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * 单页契约弹窗收口。按模式分支（评审 F2/N2）：
   * - `managed`：context 为本会话独占——**所有**新页都关。防御性设计：不依赖 CDP 的
   *   opener 行为（实证：本栈页内创建的弹窗即使 `rel=noopener` 也带 openerId；
   *   opener-less 页面只可能来自 context.newPage() 等页外路径）；
   * - `attach`：同 context 里有用户自己的标签——只关**本页打开的**弹窗（opener 实例
   *   同一性判定，异步），用户自己的标签不碰。
   * 首请求存在与关闭的竞态窗口（KNOWN-ISSUES）。
   */
  private installPopupGuard(
    context: PwBrowserContext,
    ownerPage: PwPage,
    policy: BrowserRequestPolicy | undefined,
    closeMode: 'managed' | 'attach',
  ): void {
    (context as unknown as { on(event: string, cb: (p: unknown) => void): void }).on(
      'page',
      (p: unknown) => {
        void (async () => {
          const popup = p as PwPage;
          if (closeMode === 'attach') {
            // opener() 是异步的；同一 context 下实例同一性成立（实证）
            const opener = await popup.opener().catch(() => null);
            if (opener !== ownerPage) return; // 用户自己的新标签/无主弹窗：不碰
          }
          try {
            policy?.record?.({
              kind: 'blocked',
              url: popup.url(),
              reason: 'popup not allowed (single-page session contract)',
            });
          } catch {
            /* 审计回调抛错不得影响收口（与请求层同一原则） */
          }
          await popup.close().catch(() => {
            /* 已关/已崩时无可挽回 */
          });
        })();
      },
    );
  }

  /**
   * 请求级策略安装（每请求收口：URL 判定 + 非 GET 导航写闸 + 账本）。
   *
   * 实现走 **CDP Fetch 域**（网络栈级逐请求暂停）：`context.route` 在重定向跟随跳
   * 上不触发（实证：302 目标由网络栈内部跟走、route 看不到）——路由级拦截会漏掉
   * 正是策略最该管的跳转目标，故弃用（评审 B2）。
   */
  private async installRequestPolicy(
    context: PwBrowserContext,
    page: PwPage,
    policy: BrowserRequestPolicy | undefined,
    onBlock: (url: string, reason: string) => void,
  ): Promise<void> {
    if (!policy) return; // 裸端口直用（无策略注入）不做拦截
    const cdp = await context.newCDPSession(page);
    // 审计/回执回调的抛错不得影响请求终局（否则请求悬停到超时）——统一吞在 safe 调用里
    const safeRecord = (event: Parameters<NonNullable<BrowserRequestPolicy['record']>>[0]): void => {
      try {
        policy.record?.(event);
      } catch {
        /* 审计回调自身抛错：吞掉（终局动作优先，悬停比丢一条账更糟） */
      }
    };
    const safeBlock = (url: string, reason: string): void => {
      try {
        onBlock(url, reason);
      } catch {
        /* 拦截回执抛错：吞掉（同上） */
      }
    };
    cdp.on('Fetch.requestPaused', (e: CdpRequestPaused) => {
      void (async () => {
        const url = e.request.url;
        const method = e.request.method;
        let decision: 'continue' | 'deny' = 'continue';
        try {
          await policy.checkUrl(url);
          // 外部写闸门（P2 收紧）：**所有非 GET 请求**都过 confirmWrite——
          // 文档级（表单/上传）与页内 fetch/XHR 都是外部写；工具层按 method+origin 缓存审批
          if (WRITE_METHODS.has(method)) {
            safeRecord({ kind: 'write.attempt', url, method });
            const allowed = await policy.confirmWrite({
              method,
              url,
              documentLevel: e.resourceType === 'Document',
            });
            if (!allowed) {
              decision = 'deny';
              const reason = `denied: browser write ${method} not approved`;
              safeBlock(url, reason);
              safeRecord({ kind: 'write.blocked', url, method, reason });
            }
          }
        } catch (err) {
          decision = 'deny';
          const reason = err instanceof Error ? err.message : String(err);
          safeBlock(url, reason);
          safeRecord({ kind: 'blocked', url, method, reason });
        } finally {
          // 终局动作保证：任何中间异常（含回调抛错）都不让请求悬停
          try {
            if (decision === 'continue') {
              await cdp.send('Fetch.continueRequest', { requestId: e.requestId });
            } else {
              await cdp.send('Fetch.failRequest', {
                requestId: e.requestId,
                errorReason: 'BlockedByClient',
              });
            }
          } catch {
            /* CDP 会话已随浏览器关闭：请求自然终止，无可挽回 */
          }
        }
      })();
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  }

  /**
   * attach 用户真实浏览器（P2；connectOverCDP，复用其登录/指纹）。
   *
   * 安全语义（已实证）：策略经 CDP Fetch 同样逐请求收口；`browser.close()` = 断开
   * 连接、不杀用户浏览器；会话关闭只关我们开的页（closeMode='attach'）。
   */
  async attach(options?: BrowserAttachOptions): Promise<BrowserSession> {
    const pw = await resolvePlaywright();
    const endpoint = options?.endpoint ?? this.defaults.attachEndpoint ?? 'http://127.0.0.1:9222';
    let browser: PwBrowser;
    try {
      browser = await pw.chromium.connectOverCDP(endpoint, {
        timeout: options?.timeoutMs ?? this.defaults.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      throw new Error(
        `browser_attach_failed: cannot connect to ${endpoint} — start Chrome with --remote-debugging-port and retry (${detail})`,
        { cause: err },
      );
    }
    const context = browser.contexts()[0] ?? (await browser.newContext());
    let page: PwPage;
    try {
      page = await context.newPage();
    } catch (err) {
      await browser.close().catch(() => {
        /* 断开失败不掩盖首错 */
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
    const session = new PlaywrightBrowserSession(
      browser,
      context,
      page,
      options?.timeoutMs ?? this.defaults.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS,
      options?.ownerKey ?? '',
      (id) => {
        this.sessions.delete(id);
      },
      { identity: { kind: 'attach' }, engine: 'cdp-attach', closeMode: 'attach' },
    );
    try {
      await this.installRequestPolicy(context, page, options?.policy, (url, reason) =>
        session.noteBlocked(url, reason),
      );
    } catch (err) {
      // 策略安装失败 = 会话不可安全使用：关掉我们开的页并断开（用户浏览器不受影响）
      await page.close().catch(() => {
        /* 已失败路径上再失败不掩盖首错 */
      });
      await browser.close().catch(() => {
        /* 同上 */
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.installPopupGuard(context, page, options?.policy, 'attach');
    this.sessions.set(session.id, session);
    return session;
  }

  async list(): Promise<BrowserSessionInfo[]> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      engine: s.engine,
      identity: s.identity,
      url: s.url,
    }));
  }
}
