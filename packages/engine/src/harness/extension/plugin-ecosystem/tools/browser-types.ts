/**
 * browser-types — 浏览器操作契约（arch/browser-capability.md §3.2）
 *
 * 契约住在 Harness（与 `web-search-types.ts` 同模式）：工具面消费这些类型，
 * `integration/browser/*` 实现之（依赖方向：Integration → Harness，边界测试强制）。
 *
 * 效应语义（arch/browser-capability.md §3.6）：
 * - 浏览器 = 网络出口（外泄通道）+ 不可逆外部写；工具面须走确认闸门/审计。
 * - {@link BrowserSession.inspectAction} 在执行前暴露敏感效应分类（密码字段 /
 *   表单提交），由工具层决定是否过 {@link import('@octopi-agent/core/types.js').HitlDecision}。
 * - ref 生命周期绑定快照代数：导航/上下文失效后旧 ref 一律 `stale_ref` 报错，
 *   不静默重试（避免对错误元素操作）。
 */

/** 浏览器会话 ID（跨工具↔集成边界的品牌 ID） */
/** 默认工具/动作超时（毫秒；`browser.timeoutMs` 可覆盖）——工具定义与驱动共用一个源 */
export const BROWSER_DEFAULT_TIMEOUT_MS = 30_000;

export type BrowserSessionId = string & { readonly __brand: 'BrowserSessionId' };

/** 快照元素引用（绑定快照代数，导航后失效） */
export type ElementRef = string & { readonly __brand: 'ElementRef' };

/** 后端引擎标识（arch/browser-capability.md §3.3 后端矩阵） */
export type BrowserEngineId =
  | 'playwright'
  | 'rebrowser'
  | 'camoufox'
  | 'cdp-attach'
  | 'cloud';

/** 拟人化节流参数（P3；区间 [min,max] 毫秒随机；0 = 关闭该维度） */
export interface HumanizeOptions {
  /** 逐键打字延迟区间（默认 [20, 80]） */
  typingDelayMs?: [number, number];
  /** 动作间抖动区间（默认 [100, 600]） */
  actionJitterMs?: [number, number];
  /** 动作重试上限（默认 2；有界重试，禁止重试风暴） */
  maxRetries?: number;
}

/** stealth 配置（P3；arch/browser-capability.md §3.5/§3.6） */
export interface BrowserStealthConfig {
  /** engine=stealth 的后端链（`->` 分隔，缺省 `rebrowser->camoufox`） */
  fallback?: string;
  /** 行为拟人化节流（stealth 引擎缺省启用） */
  humanize?: HumanizeOptions;
}

/** 会话身份三型 */
export interface BrowserIdentity {
  kind: 'incognito' | 'profile' | 'attach';
  profileId?: string;
}

/** 启动选项（P1：无痕单页；持久 profile = P2） */
export interface BrowserLaunchOptions {
  /** 默认 true（无头）；HITL 场景可有头 */
  headless?: boolean;
  /**
   * 浏览器来源：`chromium` = 管理版 Chromium（`octopi browser install`）；
   * `chrome` = 系统安装的 Google Chrome（零下载）。
   */
  channel?: 'chromium' | 'chrome';
  viewport?: { width: number; height: number };
  locale?: string;
  timeoutMs?: number;
  /** 会话归属 key（service 层设置；显式引用校验用，防跨会话操作） */
  ownerKey?: string;
  /** 请求级策略（URL 判定/写确认/账本）；缺省 = 无策略（仅裸端口直用时允许） */
  policy?: BrowserRequestPolicy;
  /** P3：拟人化节流参数（会话消费逐键打字延迟；工具层消费抖动/重试） */
  humanize?: HumanizeOptions;
  /** 持久 profile ID（P2：identity.kind='profile'；storageState 归档/恢复） */
  profileId?: string;
  /** profile 存储目录（`OCTOPI_HOME/browser-profiles`；assemble 注入） */
  profileDir?: string;
  /** 关闭时归档 storageState（缺省 false；与 profileId/profileDir 同用） */
  persistProfile?: boolean;
}

/**
 * 请求级策略（arch/browser-capability.md §3.6）。
 * 在**网络请求层**收口（CDP Fetch 域逐请求暂停；`context.route` 不触发于重定向跳，
 * 已弃用）：覆盖重定向、子资源、
 * 页内点击导航——策略判定是单一实现，DOM 层敏感标记只是提前预判。
 */
export interface BrowserRequestPolicy {
  /** 每个网络请求的 URL 判定；抛错 = 拦截该请求 */
  checkUrl(url: string): Promise<void>;
  /**
   * 外部写确认闸门：**所有非 GET 请求**触发（P2 收紧：含 fetch/XHR；P1 只闸文档导航）。
   * `documentLevel` = 文档级提交（表单/上传语义）；false = 页内脚本写入。
   * false = 拦截。工具层按 `method+origin` 做会话级审批缓存，避免同源重复确认。
   */
  confirmWrite(intent: {
    method: string;
    url: string;
    documentLevel: boolean;
  }): Promise<boolean>;
  /** 账本回调（写尝试/拦截；fire-and-forget） */
  record?(event: BrowserPolicyEvent): void;
}

export interface BrowserPolicyEvent {
  kind: 'write.attempt' | 'write.blocked' | 'blocked';
  url: string;
  method?: string;
  reason?: string;
}

/** attach 用户真实浏览器（P2；经 connectOverCDP，复用其登录/指纹） */
export interface BrowserAttachOptions {
  /** CDP 端点（ws://… 或 http://127.0.0.1:9222；缺省后者） */
  endpoint?: string;
  timeoutMs?: number;
  /** 会话归属 key（同 launch） */
  ownerKey?: string;
  /** 请求级策略（同 launch；attach 会话同样逐请求收口） */
  policy?: BrowserRequestPolicy;
}

/** 会话摘要（list） */
export interface BrowserSessionInfo {
  id: BrowserSessionId;
  engine: BrowserEngineId;
  identity: BrowserIdentity;
  url?: string;
}

export interface GotoOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
}

export interface GotoResult {
  url: string;
  title: string;
  /**
   * HTTP 状态码。**同文档导航/`about:blank` 无 HTTP 响应时省略**——
   * 不编造 200（AGENTS.md no-fake-data）。
   */
  status?: number;
}

/** 挑战页情报（启发式识别；见 arch/browser-capability.md §3.7） */
export interface ChallengeInfo {
  kind: 'captcha' | 'interstitial';
  /** 命中的识别标记（如实透出，供人/模型判断） */
  marker: string;
}

/**
 * 确定性结构化抽取规格（P2）：字段名 → CSS 选择器 + 可选属性。
 * 不做语义理解（那是模型自己的活）；只做 DOM 查询，结果为真实数据或 null。
 */
export interface ExtractFieldSpec {
  selector: string;
  /** 取元素属性；缺省取文本（textContent 去空白）；属性缺失 = null */
  attribute?: string;
  /** 取全部匹配（数组）；缺省取第一个 */
  multiple?: boolean;
  /** multiple 数组上限（缺省 50，防整表进上下文；超限截断） */
  maxItems?: number;
}
export type ExtractSpec = Record<string, ExtractFieldSpec>;
/**
 * 抽取结果：字段 → 字符串 / `Array<string | null>`（multiple；属性缺失项为 null）/ null
 * （无匹配 = null，不编造）。
 */
export type ExtractResult = Record<string, string | Array<string | null> | null>;

/**
 * 抽取产出（P2 预算语义，评审 N5）：数据 + 截断标记 + multiple 命中总数
 * （`counts` 让调用方知道被 maxItems 截断前的真实条数——"50 条不是全部"）。
 */
export interface ExtractOutcome {
  data: ExtractResult;
  truncated: boolean;
  counts?: Record<string, number>;
}

export interface SnapshotOptions {
  /** 只列可交互元素（省 token） */
  interactiveOnly?: boolean;
  /** 序列化预算（字符）；超出截断并标 truncated */
  maxChars?: number;
}

/** 快照元素语义标签（敏感效应判定 + 语义提示） */
export type SnapshotTag = 'submit' | 'password' | 'file' | 'heading';

/** 快照条目：可交互元素（带 ref）或纯文本流 */
export type SnapshotItem =
  | {
      ref: ElementRef;
      role: string;
      name: string;
      value?: string;
      checked?: boolean;
      tags?: SnapshotTag[];
    }
  | { ref?: undefined; role: 'text' | 'heading'; name: string };

export interface PageSnapshot {
  url: string;
  title: string;
  /** 文档序条目（可交互元素 + 文本流） */
  items: SnapshotItem[];
  /** 因 maxChars 预算截断 */
  truncated?: boolean;
}

/** 页面动作（可辨识联合） */
export type PageAction =
  | { kind: 'click'; ref: ElementRef }
  | { kind: 'fill'; ref: ElementRef; value: string }
  | { kind: 'select'; ref: ElementRef; value: string }
  | { kind: 'check'; ref: ElementRef }
  | { kind: 'uncheck'; ref: ElementRef }
  | { kind: 'hover'; ref: ElementRef }
  | { kind: 'press'; key: string; ref?: ElementRef }
  | { kind: 'scroll'; deltaY: number }
  | { kind: 'wait'; ms: number }
  /** P2：向文件输入框上传本地文件（外部写；fileUpload 闸） */
  | { kind: 'upload'; ref: ElementRef; path: string };

/** 动作意图预检（工具层确认闸门依据；基于快照元数据，不发浏览器往返） */
export interface ActionIntent {
  action: PageAction;
  /**
   * 敏感效应分类：`false` = 常规；对象 = 需过确认闸门的不可逆外部写。
   * `passwordField` = 向密码字段填写；`formSubmit` = 提交表单；`fileUpload` = 上传本地文件。
   */
  sensitive: false | { kind: 'passwordField' | 'formSubmit' | 'fileUpload'; description: string };
  /** 目标元素（审计/UI 展示） */
  target?: { role: string; name: string };
}

export interface ActResult {
  ok: true;
  url: string;
  title: string;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  /** 元素截图（省略 = 视口/整页） */
  ref?: ElementRef;
  type?: 'png' | 'jpeg';
}

/**
 * 截图结果。**数据不进 LLM 工具结果**（工具结果在 LLM 边界是纯文本序列化，
 * 见 core `normalizeMessagesForLlm`）：工具面落盘后返回路径。
 */
export interface ScreenshotResult {
  mimeType: string;
  data: Uint8Array;
}

/** 浏览器端口（integration/browser 实现） */
export interface BrowserPort {
  launch(options?: BrowserLaunchOptions): Promise<BrowserSession>;
  /** P2：attach 用户真实浏览器（CDP） */
  attach(options?: BrowserAttachOptions): Promise<BrowserSession>;
  list(): Promise<BrowserSessionInfo[]>;
}

/** stealth 链服务（P3）的挑战轮换原语；非链式服务不实现（工具层视同链穷尽） */
export interface StealthRotatable {
  /**
   * 挑战驱动的后端轮换：关掉该 key 当前会话并切到链上下一后端。
   *
   * @param sessionKey - 会话归属 key（acquire 时的 key）
   * @returns true=已轮换（调用方重新 acquire 重试一次）；false=链已穷尽（走 HITL）
   */
  rotateAfterChallenge(sessionKey: string): Promise<boolean>;
}
/** 单会话页面面（P1 单页；多标签 P2+） */
export interface BrowserSession {
  readonly id: BrowserSessionId;
  readonly engine: BrowserEngineId;
  readonly identity: BrowserIdentity;
  /** 会话归属 key（创建时的 sessionKey；显式引用须同 owner） */
  readonly ownerKey: string;
  /** 当前页面 URL（未导航时 about:blank） */
  readonly url: string;
  goto(url: string, options?: GotoOptions): Promise<GotoResult>;
  snapshot(options?: SnapshotOptions): Promise<PageSnapshot>;
  /**
   * 动作预检：暴露敏感效应分类（不执行动作）。
   * 元数据来源 = 快照时刻；ref 过期由后续 `act` 的 stale_ref 兜底。
   */
  inspectAction(action: PageAction): Promise<ActionIntent>;
  act(action: PageAction): Promise<ActResult>;
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
  /** 挑战页启发式识别（captcha/interstitial；无挑战返回 undefined） */
  detectChallenge(): Promise<ChallengeInfo | undefined>;
  /** 确定性结构化抽取（CSS 选择器 → 真实数据；无匹配字段为 null；带截断标记与命中数） */
  extract(spec: ExtractSpec): Promise<ExtractOutcome>;
  close(): Promise<void>;
}

/**
 * 会话服务（工具面唯一入口；integration/browser/service.ts 实现）。
 * 按会话 key（工具侧 = `context.sessionId`）取得/创建隐式会话；
 * 显式 `session` 参数经 {@link byId} 直取。
 */
export interface BrowserService {
  /** 取得/创建 key 的隐式会话（已存在则复用） */
  acquire(sessionKey: string, options?: BrowserLaunchOptions): Promise<BrowserSession>;
  /** 只查不建：key 的既有隐式会话（无则 undefined） */
  get(sessionKey: string): Promise<BrowserSession | undefined>;
  /** 按会话 ID 直取（显式 session 参数） */
  byId(id: BrowserSessionId): Promise<BrowserSession | undefined>;
  /** 关闭会话（隐式 key 或显式 ID 同参）；返回是否确实关闭过 */
  close(sessionKeyOrId: string): Promise<boolean>;
  /**
   * P3（可选）：挑战驱动的后端轮换（stealth 链）。true=已切下一后端（调用方重新
   * acquire 重试一次）；false=链已穷尽（走 HITL）。非链式服务不实现（视同 false）。
   */
  rotateAfterChallenge?(sessionKey: string): Promise<boolean>;
  list(): Promise<BrowserSessionInfo[]>;
  /** 进程/装配生命周期收尾：关掉全部会话并停止回收定时器 */
  dispose(): Promise<void>;
}
