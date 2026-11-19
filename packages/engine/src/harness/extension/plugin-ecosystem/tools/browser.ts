/**
 * browser_* 工具面 — 浏览器操作五件套（arch/browser-capability.md §3.4）
 *
 * 效应纪律（§3.6）：
 * - 浏览器 = 网络出口（外泄通道）+ 不可逆外部写。URL 判定与外部写闸门在**请求层**
 *   收口（BrowserRequestPolicy 注入会话；重定向/子资源/页内导航全覆盖），DOM 层
 *   敏感标记（passwordField/formSubmit）只是提前预判——两层都过才执行。
 * - 确认闸门复用 HitlDecision（confirmEffect 缺失时敏感动作 fail-closed 拒绝）。
 * - 导航/写尝试/拦截经 recordOpsEvent 进统一效应账本。
 * - 截图落盘经 fileEffects（L3 undo 记账），返回**路径**——工具结果在 LLM 边界是
 *   纯文本序列化（core normalizeMessagesForLlm），图像数据不进上下文。
 */

import type { RegisteredTool, ToolParameter } from '@octopi-agent/core/types.js';
import type { ConfirmOutcome, HitlDecision, ToolExecutionContext } from '@octopi-agent/core/types.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';

import type {
  BrowserLaunchOptions,
  BrowserRequestPolicy,
  BrowserService,
  BrowserSession,
  BrowserSessionId,
  ElementRef,
  PageAction,
  PageSnapshot,
} from './browser-types.js';
import { assertUrlAllowed, type NetworkGuardOptions } from '../../../knowledge/network-guard.js';
import { containmentOptions, resolveToolPath } from './platform.js';

export interface BrowserToolOptions {
  /** 敏感动作确认闸门（缺省全开 = 拍板） */
  confirm?: { formSubmit?: boolean; passwordField?: boolean };
  urlPolicy?: {
    /** 域名 allow（`*.suffix` 通配，匹配域及其子域）；缺省 = 不限制 */
    allow?: string[];
    /** 域名 deny（优先于 allow） */
    deny?: string[];
  };
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  snapshotMaxChars?: number;
}

// ── URL 策略（请求层单点；playwright 路由拦截与工具预检共用） ──

/** 域名归一：去尾点 + IDN→punycode（URL.hostname 已是 punycode，模式侧需对齐） */
function normalizeHost(host: string): string {
  return host.replace(/\.$/, '').toLowerCase();
}

function normalizePattern(pattern: string): { wildcard: boolean; suffix: string } {
  const trimmed = pattern.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = trimmed.startsWith('*.');
  const bare = wildcard ? trimmed.slice(2) : trimmed;
  // IDN 模式（中文/Unicode 域名）转 punycode，与 URL.hostname 对齐
  const ascii = domainToASCII(bare) || bare;
  return { wildcard, suffix: ascii };
}

export function domainMatches(pattern: string, host: string): boolean {
  const { wildcard, suffix } = normalizePattern(pattern);
  const h = normalizeHost(host);
  if (!suffix) return false;
  if (!wildcard) return h === suffix;
  // `*.example.com` 匹配 example.com 及其子域（含裸域）
  return h === suffix || (h.length > suffix.length && h.endsWith(`.${suffix}`));
}

/** 剥掉 userinfo/query/hash 再进错误与账本（凭据与 query 令牌不入错误/日志） */
function redactUrl(raw: string): string {
  return raw.replace(/\/\/[^@/]*@/g, '//***@').replace(/[?#].*$/, '');
}

export async function assertBrowserUrlAllowed(
  rawUrl: string,
  options: {
    urlPolicy?: BrowserToolOptions['urlPolicy'];
    allowPrivateNetwork?: boolean;
  },
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`url_not_allowed: invalid url: ${redactUrl(rawUrl)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`url_not_allowed: protocol not allowed: ${url.protocol.replace(':', '')}`);
  }
  const host = normalizeHost(url.hostname);
  for (const deny of options.urlPolicy?.deny ?? []) {
    if (domainMatches(deny, host)) {
      throw new Error(`url_not_allowed: domain denied by policy: ${host}`);
    }
  }
  const allow = options.urlPolicy?.allow ?? [];
  if (allow.length > 0 && !allow.some((p) => domainMatches(p, host))) {
    throw new Error(`url_not_allowed: domain not in allow list: ${host}`);
  }
  // 私网/环回门禁（SSRF 面）；网络层出口限制另见 KNOWN-ISSUES
  const guard: NetworkGuardOptions = {
    allowPrivateNetwork: options.allowPrivateNetwork ?? false,
  };
  await assertUrlAllowed(url.href, guard);
}

// ── 敏感动作闸门（DOM 层预判；请求层闸门是兜底） ──

type ConfirmGate = (intent: {
  kind: 'file.write' | 'shell' | 'memory.write' | 'other' | 'runner' | 'vcs';
  description: string;
  domain?: string;
  timeoutMs?: number;
}) => Promise<ConfirmOutcome | HitlDecision | undefined>;

/**
 * 决策归一化（fail-closed）：`HitlDecision` 字面量或 `ConfirmOutcome` 对象
 * （生产确认通道返回对象，见 gateway run-assembly 接线）；`undefined`/未知
 * 形态一律 deny——放行必须是明确的 approve 系决策。
 */
function normalizeDecision(raw: ConfirmOutcome | HitlDecision | undefined): 'approve' | 'deny' {
  const decision = typeof raw === 'string' ? raw : raw?.decision;
  return decision === 'approve' || decision === 'approve_session' || decision === 'approve_always'
    ? 'approve'
    : 'deny';
}

async function gateSensitiveAction(
  ctx: ToolExecutionContext,
  confirm: BrowserToolOptions['confirm'],
  intent: { kind: 'passwordField' | 'formSubmit'; description: string },
  domain: string,
): Promise<void> {
  const enabled = intent.kind === 'passwordField'
    ? (confirm?.passwordField ?? true)
    : (confirm?.formSubmit ?? true);
  if (!enabled) return;
  const gate = ctx.confirmEffect as unknown as ConfirmGate | undefined;
  if (!gate) {
    // 缺确认通道时敏感效应拒绝执行（fail-closed，不静默放行）
    throw new Error(`denied: ${intent.kind} requires confirmation but no confirmEffect channel`);
  }
  const decision = await gate({
    kind: 'other',
    description: `browser ${intent.kind === 'formSubmit' ? 'form submit' : 'password fill'}: ${intent.description}`,
    domain,
    timeoutMs: 120_000,
  });
  if (normalizeDecision(decision) === 'deny') {
    audit(ctx, 'browser.act.denied', { reason: intent.kind, description: intent.description });
    throw new Error(`denied: browser ${intent.kind} not approved`);
  }
}

function audit(ctx: ToolExecutionContext, event: string, data: Record<string, unknown>): void {
  ctx.recordOpsEvent?.({ event, data });
}

function hostOf(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    // about:blank 等无 host URL：确认意图的 domain 留空（如实缺省，不编造）
    return '';
  }
}

// ── 会话解析（归属校验 + 按需创建） ──

async function resolveSession(
  service: BrowserService,
  explicit: unknown,
  ctx: ToolExecutionContext,
  launch: BrowserLaunchOptions,
  createIfMissing: boolean,
): Promise<BrowserSession> {
  if (typeof explicit === 'string' && explicit.trim()) {
    const found = await service.byId(explicit.trim() as BrowserSessionId);
    if (!found) {
      throw new Error(`browser_session_not_found: ${explicit}`);
    }
    // 归属校验：显式引用也必须属于本会话（防跨会话操作别人的浏览器）
    if (found.ownerKey && found.ownerKey !== ctx.sessionId) {
      throw new Error(`denied: browser session ${explicit} belongs to another session`);
    }
    return found;
  }
  if (createIfMissing) {
    return service.acquire(ctx.sessionId, launch);
  }
  const existing = await service.get(ctx.sessionId);
  if (!existing) {
    throw new Error(
      'browser_session_not_found: no active browser session — call browser_navigate first',
    );
  }
  return existing;
}

function buildRequestPolicy(
  ctx: ToolExecutionContext,
  opts: BrowserToolOptions,
): BrowserRequestPolicy {
  return {
    checkUrl: async (url: string) => {
      await assertBrowserUrlAllowed(url, opts);
    },
    confirmWrite: async ({ method, url }) => {
      // 请求层外部写闸门：非 GET 导航（表单提交/上传语义）复用敏感闸门
      const gate = ctx.confirmEffect as unknown as ConfirmGate | undefined;
      if (!gate) return false;
      if ((opts.confirm?.formSubmit ?? true) === false) return true;
      const decision = await gate({
        kind: 'other',
        description: `browser write ${method} ${redactUrl(url)}`,
        domain: hostOf(url),
        timeoutMs: 120_000,
      });
      return normalizeDecision(decision) !== 'deny';
    },
    record: (event) => {
      audit(ctx, `browser.${event.kind}`, {
        url: redactUrl(event.url),
        ...(event.method ? { method: event.method } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      });
    },
  };
}

// ── 工具面 ──

export function createBrowserTools(
  service: BrowserService,
  options: BrowserToolOptions = {},
): RegisteredTool[] {
  const policyFor = (ctx: ToolExecutionContext): BrowserRequestPolicy => buildRequestPolicy(ctx, options);
  const launchFor = (ctx: ToolExecutionContext): BrowserLaunchOptions => ({
    ownerKey: ctx.sessionId,
    policy: policyFor(ctx),
  });
  const snapshotArgs: Record<string, ToolParameter> = {
    session: {
      type: 'string',
      description:
        'Browser session id from a previous browser_* result (default: this conversation session)',
    },
    interactiveOnly: {
      type: 'boolean',
      description: 'Only list interactive elements (cheaper)',
    },
  };

  const navigateTool: RegisteredTool = {
    definition: {
      name: 'browser_navigate',
      description:
        'Open a URL in the agent browser and return the page snapshot (interactive elements with refs + condensed text). Launches the browser on first use. Refs are valid until the next snapshot/navigation. URL policy (domains/private-net) and write-confirmation gates apply.',
      parameters: {
        url: { type: 'string', description: 'http(s) URL to open' },
        session: snapshotArgs.session,
      },
      capabilities: ['egress'],
      timeoutMs: options.timeoutMs ?? 30_000,
    },
    source: { kind: 'builtin', origin: 'browser', trustLevel: 'builtin' },
    executionMode: 'sequential',
    handler: async (args, ctx) => {
      const rawUrl = String(args.url ?? '');
      // 预检（fail-fast + 高质量错误）；请求层拦截是权威兜底（重定向/子资源全覆盖）
      await assertBrowserUrlAllowed(rawUrl, options);
      const session = await resolveSession(service, args.session, ctx, launchFor(ctx), true);
      // 用归一化 href 导航（与判定目标一致，避免同 URL 双形态）
      const target = new URL(rawUrl).href;
      try {
        const result = await session.goto(target, {
          waitUntil: 'load',
          timeoutMs: options.timeoutMs,
        });
        audit(ctx, 'browser.navigate', { url: redactUrl(result.url), sessionId: session.id });
        const snapshot = await session.snapshot({
          maxChars: options.snapshotMaxChars,
        });
        return { sessionId: session.id, engine: session.engine, ...result, snapshot };
      } catch (err) {
        audit(ctx, 'browser.navigate.failed', {
          url: redactUrl(rawUrl),
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };

  const snapshotTool: RegisteredTool = {
    definition: {
      name: 'browser_snapshot',
      description:
        'Get a fresh snapshot of the current page (interactive elements with refs + condensed text in document order). Call this after navigating or when refs went stale. Does not launch a browser — an active session is required.',
      parameters: snapshotArgs,
      capabilities: ['egress'],
      timeoutMs: options.timeoutMs ?? 30_000,
    },
    source: { kind: 'builtin', origin: 'browser', trustLevel: 'builtin' },
    executionMode: 'sequential',
    handler: async (args, ctx) => {
      const session = await resolveSession(service, args.session, ctx, launchFor(ctx), false);
      return session.snapshot({
        interactiveOnly: Boolean(args.interactiveOnly),
        maxChars: options.snapshotMaxChars,
      });
    },
  };

  const actTool: RegisteredTool = {
    definition: {
      name: 'browser_act',
      description:
        'Act on the current page: action=click|fill|select|check|uncheck|hover|press|scroll|wait. Use refs from the latest snapshot (stale refs error). Sensitive effects (password fills, form submits) go through a human confirmation gate; submissions are also gated at the request layer.',
      parameters: {
        action: {
          type: 'string',
          description: 'click | fill | select | check | uncheck | hover | press | scroll | wait',
        },
        ref: { type: 'string', description: 'element ref from the latest snapshot' },
        value: { type: 'string', description: 'value for fill / select' },
        key: { type: 'string', description: 'key name for press (e.g. Enter, Tab)' },
        deltaY: { type: 'number', description: 'scroll distance for scroll (default 600)' },
        ms: { type: 'number', description: 'wait duration in ms for wait (max 10000)' },
        session: snapshotArgs.session,
      },
      capabilities: ['egress'],
      timeoutMs: options.timeoutMs ?? 30_000,
    },
    source: { kind: 'builtin', origin: 'browser', trustLevel: 'builtin' },
    executionMode: 'sequential',
    handler: async (args, ctx) => {
      const session = await resolveSession(service, args.session, ctx, launchFor(ctx), false);
      const action = buildPageAction(args);
      const intent = await session.inspectAction(action);
      const domain = hostOf(session.url);
      if (intent.sensitive !== false) {
        await gateSensitiveAction(ctx, options.confirm, intent.sensitive, domain);
        audit(ctx, 'browser.act.sensitive', {
          kind: intent.sensitive.kind,
          target: intent.target,
          domain,
          sessionId: session.id,
        });
      }
      return session.act(action);
    },
  };

  const screenshotTool: RegisteredTool = {
    definition: {
      name: 'browser_screenshot',
      description:
        'Save a screenshot of the current page (or one element) to a PNG/JPEG file and return its path. The image is NOT inlined (tool results are text-only) — use send_file to show it to the user.',
      parameters: {
        fullPage: { type: 'boolean', description: 'capture the full scrollable page' },
        ref: { type: 'string', description: 'element ref from the latest snapshot (element shot)' },
        type: { type: 'string', description: 'png (default) | jpeg' },
        session: snapshotArgs.session,
      },
      capabilities: ['egress'],
      timeoutMs: options.timeoutMs ?? 30_000,
    },
    source: { kind: 'builtin', origin: 'browser', trustLevel: 'builtin' },
    executionMode: 'sequential',
    handler: async (args, ctx) => {
      const session = await resolveSession(service, args.session, ctx, launchFor(ctx), false);
      const shot = await session.screenshot({
        fullPage: Boolean(args.fullPage),
        type: args.type === 'jpeg' ? 'jpeg' : 'png',
        ...(typeof args.ref === 'string' && args.ref.trim()
          ? { ref: args.ref.trim() as ElementRef }
          : {}),
      });
      // 路径与其它文件工具同一包含原语（resolveToolPath + containmentOptions）
      const cwd = ctx.cwd ?? process.cwd();
      const ext = shot.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const filename = `browser-${session.id}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
      const path = resolveToolPath(
        join('browser-screenshots', filename),
        cwd,
        containmentOptions(ctx),
      );
      // 与 file_write 同惯例：先建父目录再落盘
      const { mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(path), { recursive: true });
      await ctx.fileEffects.writeFile(path, shot.data);
      audit(ctx, 'browser.screenshot', { path, sessionId: session.id });
      return {
        path,
        mimeType: shot.mimeType,
        bytes: shot.data.byteLength,
        note: 'image saved to path; not inlined — use send_file to show the user',
      };
    },
  };

  const closeTool: RegisteredTool = {
    definition: {
      name: 'browser_close',
      description: 'Close the browser session (this conversation session or an explicit session id). Idempotent.',
      parameters: {
        session: snapshotArgs.session,
      },
      capabilities: ['egress'],
      timeoutMs: options.timeoutMs ?? 30_000,
    },
    source: { kind: 'builtin', origin: 'browser', trustLevel: 'builtin' },
    executionMode: 'sequential',
    handler: async (args, ctx) => {
      const explicit =
        typeof args.session === 'string' && args.session.trim() ? args.session.trim() : '';
      if (explicit) {
        // 归属校验：显式关闭同样不得跨会话（N5）
        const found = await service.byId(explicit as BrowserSessionId);
        if (found && found.ownerKey && found.ownerKey !== ctx.sessionId) {
          throw new Error(`denied: browser session ${explicit} belongs to another session`);
        }
      }
      const keyOrId = explicit || ctx.sessionId;
      const closed = await service.close(keyOrId);
      audit(ctx, 'browser.close', { keyOrId, closed });
      return { ok: true, closed };
    },
  };

  return [navigateTool, snapshotTool, actTool, screenshotTool, closeTool];
}

function buildPageAction(args: Record<string, unknown>): PageAction {
  const kind = String(args.action ?? '');
  const ref =
    typeof args.ref === 'string' && args.ref.trim() ? (args.ref.trim() as ElementRef) : undefined;
  switch (kind) {
    case 'click':
      requireRef(kind, ref);
      return { kind: 'click', ref };
    case 'fill': {
      requireRef(kind, ref);
      const value = args.value === undefined ? '' : String(args.value);
      return { kind: 'fill', ref, value };
    }
    case 'select': {
      requireRef(kind, ref);
      if (args.value === undefined) throw new Error('browser_act: select requires value');
      return { kind: 'select', ref, value: String(args.value) };
    }
    case 'check':
      requireRef(kind, ref);
      return { kind: 'check', ref };
    case 'uncheck':
      requireRef(kind, ref);
      return { kind: 'uncheck', ref };
    case 'hover':
      requireRef(kind, ref);
      return { kind: 'hover', ref };
    case 'press': {
      if (!args.key) throw new Error('browser_act: press requires key');
      return { kind: 'press', key: String(args.key), ...(ref ? { ref } : {}) };
    }
    case 'scroll':
      return {
        kind: 'scroll',
        deltaY: args.deltaY === undefined ? 600 : toFiniteNumber(args.deltaY, 'deltaY'),
      };
    case 'wait': {
      const ms = args.ms === undefined ? 0 : toFiniteNumber(args.ms, 'ms');
      return { kind: 'wait', ms };
    }
    default:
      throw new Error(`browser_act: unknown action: ${kind || '(missing)'}`);
  }
}

function requireRef(kind: string, ref: unknown): asserts ref is ElementRef {
  if (!ref) throw new Error(`browser_act: ${kind} requires ref`);
}

/** 数字参数校验：非有限数（NaN/Infinity）直接拒绝，不静默兜底 */
function toFiniteNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`browser_act: ${name} must be a finite number`);
  }
  return n;
}
