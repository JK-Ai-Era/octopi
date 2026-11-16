/**
 * 错误分类与人话文案单源（批 3-2：批 2 登记项「错误映射四份单源化」）。
 *
 * 收敛前四份各自维护：engine `classifyProbeError`（分类）、webui `probeCopy`、
 * CLI `probeLabels`、webui `error-classify`（文案）——码集漂移（server vs context）
 * 与口径漂移正是两处真相病。本模块是唯一实现：
 *
 * - **分类**：`classifyErrorKind` —— probe 与运行期共用一套关键词规则
 * - **码集**：`auth | network | model | context | server`
 * - **文案**：probe 语境（向导，有「上一步」）与 run 语境（对话流，有「去设置」）
 *   各一张表，zh/en 双语——UI 只做渲染与 CTA 装配，不再自持文案
 *
 * @module
 */

/** 错误分类码（probe 语境不含 'context'——上下文超限不发生在探针） */
export type ErrorKind = 'auth' | 'network' | 'model' | 'context' | 'server';

/** probe 语境分类码 */
export type ProbeErrorKind = Exclude<ErrorKind, 'context'>;

/** 人话文案（title + detail；UI 自行附加 CTA/level） */
export interface ErrorCopy {
  title: string;
  detail: string;
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
    t.includes('econnrefused') ||
    t.includes('etimedout') ||
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
  if (t.includes('context') && (t.includes('length') || t.includes('exceed') || t.includes('too long') || t.includes('maximum'))) {
    return 'context';
  }
  return 'server';
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
