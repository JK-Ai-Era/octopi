/**
 * 错误分类与人话文案单源（批 3-2：批 2 登记项「错误映射四份单源化」；本批扩展为域×档）。
 *
 * 收敛前四份各自维护：engine `classifyProbeError`（分类）、webui `probeCopy`、
 * CLI `probeLabels`、webui `error-classify`（文案）——码集漂移（server vs context）
 * 与口径漂移正是两处真相病。本模块是唯一实现：
 *
 * - **分类**：`classifyErrorKind` —— probe 与运行期共用一套关键词规则
 * - **码集**：`auth | network | timeout | rate_limit | model | context | server`
 * - **来源域**：`provider`（模型服务）| `tool`（工具执行）| `app`（界面/会话操作）——
 *   工具错误与 app 错误不是模型服务错误，不共用 provider 分类器（语义即契约）
 * - **处置档**：`self-heal`（可自愈，不进错误卡）| `user-action`（卡+出路）| `support`（卡+诊断 ID）
 * - **文案**：probe 语境（向导，有「上一步」）与 run 语境（对话流，有「去设置」）
 *   各一张表，zh/en 双语——UI 只做渲染与 CTA 装配，不再自持文案
 *
 * @module
 */

import { isContextLengthErrorText } from '@octopi-agent/core/loop/error-classifier.js';

/** 错误分类码（probe 语境不含 'context'——上下文超限不发生在探针） */
export type ErrorKind = 'auth' | 'network' | 'timeout' | 'rate_limit' | 'model' | 'context' | 'server';

/** probe 语境分类码 */
export type ProbeErrorKind = Exclude<ErrorKind, 'context'>;

/** 错误来源域（决定走哪张分类/文案表） */
export type ErrorDomain = 'provider' | 'tool' | 'app';

/** 工具错误分类码 */
export type ToolErrorKind = 'blocked' | 'failed' | 'internal';

/** app 错误分类码（会话/界面操作失败） */
export type AppErrorKind = 'failed';

/** 处置档：self-heal 不进错误卡；user-action 卡+出路；support 卡+诊断 ID */
export type ErrorLevel = 'self-heal' | 'user-action' | 'support';

/** 人话文案（title + detail；UI 自行附加 CTA/level） */
export interface ErrorCopy {
  title: string;
  detail: string;
}

/** 域分类结果（level 与 copy 由域×码决定） */
export interface ClassifiedError {
  domain: ErrorDomain;
  kind: ErrorKind | ToolErrorKind | AppErrorKind;
  level: ErrorLevel;
  copy: ErrorCopy;
}

/**
 * 错误文本 → 分类码（probe 与运行期共用；关键词规则唯一实现）。
 *
 * @param raw - 原始错误文本
 * @returns 分类码（无法归类时 'server'）
 */
export function classifyErrorKind(raw: string): ErrorKind {
  const t = raw.toLowerCase();
  if (
    t.includes('401') ||
    t.includes('403') ||
    t.includes('unauthorized') ||
    t.includes('forbidden') ||
    t.includes('api key') ||
    t.includes('apikey') ||
    t.includes('api-key') || // m4：api-key / api_key 变体（x-api-key 等；旧正则 api.?key 覆盖）
    t.includes('api_key') ||
    t.includes('invalid key') ||
    t.includes('authentication')
  ) {
    return 'auth';
  }
  if (
    /\b429\b/.test(raw) ||
    t.includes('rate limit') ||
    t.includes('ratelimit') ||
    t.includes('too many requests') ||
    t.includes('quota') ||
    t.includes('overloaded')
  ) {
    return 'rate_limit';
  }
  if (
    t.includes('timeout') ||
    t.includes('timed out') ||
    t.includes('timedout') ||
    t.includes('etimedout') ||
    t.includes('deadline exceeded')
  ) {
    return 'timeout';
  }
  if (
    t.includes('econnrefused') ||
    t.includes('enotfound') ||
    t.includes('econnreset') ||
    t.includes('fetch failed') ||
    t.includes('network') ||
    t.includes('getaddrinfo')
  ) {
    return 'network';
  }
  if (
    t.includes('model') &&
    (t.includes('not found') ||
      t.includes('does not exist') ||
      t.includes('unknown') ||
      t.includes('no such') ||
      t.includes('invalid'))
  ) {
    return 'model';
  }
  // context 判定复用 core 的跨 provider 长度错误文本单源（M4：Anthropic
  // "prompt is too long: … > … maximum"、Gemini "input token count … exceeds…"）
  if (
    (t.includes('context') && (t.includes('length') || t.includes('exceed') || t.includes('too long') || t.includes('maximum'))) ||
    isContextLengthErrorText(raw)
  ) {
    return 'context';
  }
  return 'server';
}

/**
 * 守卫 violation 文本判定（单源：classifyToolErrorKind 的 blocked 与
 * securityBlockedCopy 共用）。真实工具阻断文本是 violation description
 * （`工具 "shell" download pipe to interpreter (remote code execution)`），
 * 只有 afterToolCall 输出扫描才带 `Blocked by SecurityGuard:` 前缀。
 */
export function securityViolationKind(
  text: string,
): 'rce' | 'disk_wipe' | 'injection' | 'protected_path' | 'secret' | null {
  const t = text.toLowerCase();
  if (t.includes('remote code execution')) return 'rce';
  if (t.includes('disk wipe') || t.includes('recursive delete') || t.includes('递归删除')) return 'disk_wipe';
  if (t.includes('prompt injection')) return 'injection';
  if (text.includes('保护路径') || t.includes('protected path')) return 'protected_path';
  if (t.includes('sensitive') || text.includes('密钥') || text.includes('凭证')) return 'secret';
  return null;
}

/**
 * 工具错误 → 分类码（启发式）。
 *
 * - `blocked`：守卫拦截（模型收到后换方案即可，可自愈）
 * - `internal`：BUG 级内部异常（堆栈帧落在 octopi 包内）→ 该找支持
 * - `failed`：其余执行失败（参数错误、路径不存在、exit≠0…）→ 模型可自救
 *
 * @param raw - 工具错误原文
 * @returns 分类码
 */
export function classifyToolErrorKind(raw: string): ToolErrorKind {
  const t = raw.toLowerCase();
  if (t.includes('blocked by securityguard') || securityViolationKind(raw)) return 'blocked';
  // internal 只认「堆栈 + octopi 包内路径」：用户脚本 stderr 里的 TypeError/堆栈
  // 是执行失败（模型可自救），不是工具内部异常
  const hasStack = /\n\s+at\s/.test(raw);
  const inPackage = /(packages\/|node_modules\/@octopi|@octopi-agent)/.test(raw);
  if (hasStack && inPackage) return 'internal';
  return 'failed';
}

const PROBE_COPY: Record<ProbeErrorKind, { zh: ErrorCopy; en: ErrorCopy }> = {
  auth: {
    zh: { title: '密钥没通过校验', detail: '请检查 API Key 是否正确（回到上一步修改）。' },
    en: { title: 'API key rejected', detail: 'Check the API key and go back to fix it.' },
  },
  network: {
    zh: { title: '连不上模型服务', detail: '请检查 baseUrl 与网络连接后重试。' },
    en: { title: 'Cannot reach the service', detail: 'Check the base URL and network, then retry.' },
  },
  timeout: {
    zh: { title: '连接超时', detail: '请检查网络后重试。' },
    en: { title: 'Connection timed out', detail: 'Check the network, then retry.' },
  },
  rate_limit: {
    zh: { title: '请求太频繁', detail: '请稍后重试。' },
    en: { title: 'Too many requests', detail: 'Retry later.' },
  },
  model: {
    zh: { title: '模型不存在', detail: '请回到上一步换一个模型。' },
    en: { title: 'Model not found', detail: 'Go back and pick a different model.' },
  },
  server: {
    zh: { title: '模型服务出错', detail: '服务端异常，请稍后重试；持续失败请查看服务日志。' },
    en: { title: 'Provider error', detail: 'The provider had an error. Retry later; check service logs if it persists.' },
  },
};

const RUNTIME_COPY: Record<ErrorKind, { zh: ErrorCopy; en: ErrorCopy }> = {
  auth: {
    zh: { title: '模型服务的密钥无效或已过期', detail: '请到「设置 → 模型」更新 API Key 后重试。' },
    en: { title: 'Invalid or expired API key', detail: 'Update the API key in Settings → Models, then retry.' },
  },
  network: {
    zh: { title: '连不上模型服务', detail: '请检查网络或模型服务地址（设置 → 模型），稍后重试。' },
    en: { title: 'Cannot reach the model service', detail: 'Check the network or service URL (Settings → Models), then retry.' },
  },
  timeout: {
    zh: { title: '模型服务响应超时', detail: '服务响应太慢或网络不佳，可稍后重试。' },
    en: { title: 'Model service timed out', detail: 'The service responded too slowly. Retry later.' },
  },
  rate_limit: {
    zh: { title: '请求太频繁', detail: '模型服务限流或配额用尽，可稍后再试。' },
    en: { title: 'Too many requests', detail: 'The service rate-limited the request or the quota is spent. Try again later.' },
  },
  model: {
    zh: { title: '所选模型不可用', detail: '模型名可能已下线或拼写有误，请到「设置 → 模型」换一个模型。' },
    en: { title: 'Model unavailable', detail: 'The model may be retired or misspelled. Pick another in Settings → Models.' },
  },
  context: {
    zh: { title: '消息太长，超出模型的记忆容量', detail: '可以压缩早期消息（对话顶部「压缩」）或新开会话再试。' },
    en: { title: 'Message too long', detail: 'Compact earlier messages (the Compact button on top) or start a new session.' },
  },
  server: {
    zh: { title: '模型服务出错了', detail: '这不是你的操作问题。复制下面的诊断 ID 反馈给支持人员即可。' },
    en: { title: 'Provider error', detail: 'This is not your fault. Copy the diagnostic ID below and send it to support.' },
  },
};

const TOOL_COPY: Record<ToolErrorKind, { zh: ErrorCopy; en: ErrorCopy }> = {
  blocked: {
    zh: { title: '操作已被安全策略拦截', detail: 'agent 将换一种方案继续。' },
    en: { title: 'Blocked by security policy', detail: 'The agent will try a different approach.' },
  },
  failed: {
    zh: { title: '工具执行未成功', detail: 'agent 会根据错误信息调整方案继续。' },
    en: { title: 'Tool call failed', detail: 'The agent will adjust and continue.' },
  },
  internal: {
    zh: { title: '工具内部异常', detail: '这不是你的操作问题。复制下面的诊断 ID 反馈给支持人员即可。' },
    en: { title: 'Tool internal error', detail: 'This is not your fault. Copy the diagnostic ID below and send it to support.' },
  },
};

const APP_COPY: Record<AppErrorKind, { zh: ErrorCopy; en: ErrorCopy }> = {
  failed: {
    zh: { title: '操作失败', detail: '请稍后重试；持续失败请查看服务日志。' },
    en: { title: 'Operation failed', detail: 'Retry later; check service logs if it persists.' },
  },
};

/**
 * 域分类主入口：按来源域分流到对应分类器与文案表，并给出处置档。
 *
 * - `provider`：`classifyErrorKind` 七类码；`server` 兜底 → support，其余 user-action
 * - `tool`：`classifyToolErrorKind`；`internal` → support，其余 self-heal（模型可自救）
 * - `app`：操作失败 → user-action
 *
 * @param raw - 原始错误文本
 * @param domain - 来源域
 * @param lang - 语言
 * @returns 域分类结果（level + 人话文案）
 */
export function classifyError(raw: string, domain: ErrorDomain, lang: 'zh' | 'en' = 'zh'): ClassifiedError {
  if (domain === 'tool') {
    const kind = classifyToolErrorKind(raw);
    return {
      domain,
      kind,
      level: kind === 'internal' ? 'support' : 'self-heal',
      copy: TOOL_COPY[kind][lang],
    };
  }
  if (domain === 'app') {
    return { domain, kind: 'failed', level: 'user-action', copy: APP_COPY.failed[lang] };
  }
  const kind = classifyErrorKind(raw);
  return {
    domain,
    kind,
    level: kind === 'server' ? 'support' : 'user-action',
    copy: RUNTIME_COPY[kind][lang],
  };
}

/**
 * 守卫拦截消息人话化（security.blocked 的 reason 是审计语，不直接给用户）。
 *
 * @param reason - violation description 原文
 * @param lang - 语言
 * @returns 标题与详情（UI 可在详情后附注 reason 保留可诊断性）
 */
export function securityBlockedCopy(reason: string, lang: 'zh' | 'en' = 'zh'): ErrorCopy {
  const zh = (title: string): ErrorCopy => ({ title, detail: 'agent 将换一种方案继续。' });
  const en = (title: string): ErrorCopy => ({ title, detail: 'The agent will try a different approach.' });
  switch (securityViolationKind(reason)) {
    case 'rce':
      return lang === 'zh' ? zh('已拦截：可能下载并执行远程代码') : en('Blocked: possible download-and-execute');
    case 'disk_wipe':
      return lang === 'zh' ? zh('已拦截：可能清空磁盘') : en('Blocked: possible disk wipe');
    case 'protected_path':
      return lang === 'zh' ? zh('已拦截：可能破坏系统保护路径') : en('Blocked: possible damage to a protected path');
    case 'injection':
      return lang === 'zh' ? zh('已拦截：可能的提示注入') : en('Blocked: possible prompt injection');
    case 'secret':
      return lang === 'zh' ? zh('已拦截：可能泄露敏感信息') : en('Blocked: possible sensitive-data exposure');
    default:
      return lang === 'zh' ? zh('已拦截可疑操作') : en('Blocked: suspicious operation');
  }
}

/**
 * probe 语境文案（向导）。
 *
 * @param kind - 分类码（不含 'context'）
 * @param lang - 语言
 * @returns 标题与详情
 */
export function probeErrorCopy(kind: ProbeErrorKind, lang: 'zh' | 'en' = 'zh'): ErrorCopy {
  return PROBE_COPY[kind][lang];
}

/** probe 分类码全集（Record 全键派生——扩类时编译器强制补表，消费侧码表不静默缺键） */
const PROBE_KIND_CHECK: Record<ProbeErrorKind, true> = {
  auth: true,
  network: true,
  timeout: true,
  rate_limit: true,
  model: true,
  server: true,
};
export const PROBE_ERROR_KINDS: readonly ProbeErrorKind[] = Object.keys(PROBE_KIND_CHECK) as ProbeErrorKind[];

/** 诊断 ID（support 档展示与反馈对账用） */
export function makeDiagnosticId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 运行期语境文案（对话流错误卡）。
 *
 * @param kind - 分类码
 * @param lang - 语言
 * @returns 标题与详情
 */
export function runtimeErrorCopy(kind: ErrorKind, lang: 'zh' | 'en' = 'zh'): ErrorCopy {
  return RUNTIME_COPY[kind][lang];
}
