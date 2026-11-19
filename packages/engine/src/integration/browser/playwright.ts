/**
 * playwright 后端 — BrowserPort 的 Playwright 实现（arch/browser-capability.md §3.3）
 *
 * 可选依赖纪律：`playwright-core` 经 optionalDependencies 提供，运行时动态 import
 * （零编译期耦合，结构化类型自描述）；缺失/浏览器二进制缺失时 fail-loud
 * （`not_implemented` + 安装指引），不装哑 stub。
 *
 * 请求级策略（arch/browser-capability.md §3.6）：经 `context.route`（全请求 pattern）
 * 对**每个网络请求**（含重定向/子资源/页内导航）执行注入的 BrowserRequestPolicy——
 * URL 判定与外部写闸门在网络层收口，DOM 层敏感标记只是提前预判。
 */

import { randomUUID } from 'node:crypto';

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
  ElementRef,
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
}
interface PwBrowserContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
  newCDPSession(page: PwPage): Promise<PwCDPSession>;
}
interface PwBrowser {
  newContext(options?: unknown): Promise<PwBrowserContext>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(options?: unknown): Promise<PwBrowser>;
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



let pwModulePromise: Promise<PwModule> | undefined;
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
  readonly engine: BrowserEngineId = 'playwright';
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
  ) {
    this.id = `bs_${randomUUID()}` as BrowserSessionId;
    this.identity = { kind: 'incognito' };
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
    let sensitive: false | { kind: 'passwordField' | 'formSubmit'; description: string } = false;
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
    }
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
    try {
      await this.context.close();
    } catch (err) {
      firstError = err;
    }
    try {
      await this.browser.close();
    } catch (err) {
      firstError ??= err;
    }
    this.onClosed?.(this.id);
    if (firstError) throw firstError;
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
    } = {},
  ) {}

  async launch(options?: BrowserLaunchOptions): Promise<BrowserSession> {
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

    let context: PwBrowserContext;
    let page: PwPage;
    try {
      context = await browser.newContext({
        ...(options?.viewport ?? this.defaults.viewport
          ? { viewport: options?.viewport ?? this.defaults.viewport }
          : {}),
        ...(options?.locale ?? this.defaults.locale
          ? { locale: options?.locale ?? this.defaults.locale }
          : {}),
      });
      page = await context.newPage();
    } catch (err) {
      // context/page 建失败必须回收 browser，否则泄漏浏览器进程
      await browser.close().catch(() => {
        /* 已失败路径上再失败不掩盖首错 */
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
    // P1 单页契约：新窗口（target=_blank / window.open）不被本会话 CDP 策略覆盖
    // （CDP Fetch 按 page target 挂）——收口为立即关闭 + 记账；首请求有竞态窗口（KNOWN-ISSUES）
    (context as unknown as { on(event: string, cb: (p: unknown) => void): void }).on(
      'page',
      (p: unknown) => {
        const popup = p as PwPage;
        try {
          options?.policy?.record?.({
            kind: 'blocked',
            url: popup.url(),
            reason: 'popup not allowed (P1 single-page contract)',
          });
        } catch {
          /* 审计回调抛错不得影响收口（与请求层同一原则） */
        }
        void popup.close().catch(() => {
          /* 已关/已崩时无可挽回 */
        });
      },
    );
    this.sessions.set(session.id, session);
    return session;
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
          // 外部写闸门：非 GET 的**文档导航** = 表单提交/上传语义（P1 边界，见契约注释）
          if (WRITE_METHODS.has(method)) {
            safeRecord({ kind: 'write.attempt', url, method });
            if (e.resourceType === 'Document') {
              const allowed = await policy.confirmWrite({ method, url });
              if (!allowed) {
                decision = 'deny';
                const reason = `denied: browser write ${method} not approved`;
                safeBlock(url, reason);
                safeRecord({ kind: 'write.blocked', url, method, reason });
              }
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

  async attach(_options?: BrowserAttachOptions): Promise<BrowserSession> {
    throw new Error('not_implemented: browser attach (cdp-attach) lands in P2 — arch/browser-capability.md §4');
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
