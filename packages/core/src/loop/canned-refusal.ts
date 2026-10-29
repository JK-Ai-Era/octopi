/**
 * 内容过滤罐头拒答 — 签名识别与错误类型
 *
 * 失效模式（2026-10-29 实测，xiaomi-coding/mimo-v2.6-pro）：模型提供方的内容安全层
 * 把请求判为高风险时，HTTP 仍 200 内联返回——reasoning 照常流出，**正文被替换成
 * 固定英文罐头**、finishReason=stop、usage 正常。成功面完全无感：拒答语会被当成
 * 助手回答落进历史/摘要/UI。
 *
 * 本模块把「正文恰为罐头拒答」识别为 `content_filter` 模型错误（ContentFilterError），
 * 交由既有 onError/重试链路处理：阈值型误杀原样重试常过；重试耗尽则如实收口。
 * 签名为精确匹配（空白/收尾标点归一化）：合法回答不可能恰好是这句系统口吻的罐头。
 */

/** 已知内容过滤罐头拒答签名（新增网关话术在此登记） */
const CANNED_REFUSAL_SIGNATURES: readonly string[] = [
  'The request was rejected because it was considered high risk',
];

/**
 * 归一化：trim + 折叠内部空白 + 去收尾标点 + 小写。
 *
 * @param text - 原文
 * @returns 归一化文本
 */
function normalizeRefusalText(text: string): string {
  return text
    .trim()
    .replace(/[.!?…]+$/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const NORMALIZED_SIGNATURES: readonly string[] = CANNED_REFUSAL_SIGNATURES.map(normalizeRefusalText);

/**
 * 判定整段正文是否为内容过滤罐头拒答。
 *
 * @param text - 响应正文
 * @returns 正文恰为某个拒答签名时 true
 */
export function isCannedRefusalText(text: string): boolean {
  const normalized = normalizeRefusalText(text);
  return normalized.length > 0 && NORMALIZED_SIGNATURES.includes(normalized);
}

/**
 * 判定已流出的累计正文是否仍可能是罐头拒答的开头（流式扣发判定）。
 *
 * @param text - 已流出的累计正文
 * @returns 仍是某个签名的前缀（或恰等于签名）时 true，调用方应继续扣发
 */
export function isCannedRefusalPrefix(text: string): boolean {
  const normalized = normalizeRefusalText(text);
  if (!normalized) return false;
  return NORMALIZED_SIGNATURES.some((signature) => signature.startsWith(normalized));
}

/**
 * 判定错误是否为内容过滤拒答（ContentFilterError，或包装后 name 仍在的派生错误）。
 *
 * @param err - 任意错误值
 * @returns 是内容过滤拒答时 true
 */
export function isContentFilterError(err: unknown): boolean {
  return (
    err instanceof ContentFilterError ||
    (err instanceof Error && err.name === 'ContentFilterError')
  );
}

/**
 * 内容过滤拒答错误（模型提供方安全层拦截）。
 *
 * `name` 稳定为 'ContentFilterError'：错误经包装/跨包传递后 classifyError 依 name 归类。
 * message 保留拒答原文（收口提示与留痕要如实说明发生了什么），但**不得当作回答**。
 */
export class ContentFilterError extends Error {
  /** 被拦截的罐头拒答原文（留痕用；不是助手输出） */
  readonly refusalText: string;

  constructor(refusalText: string) {
    super(`内容安全拦截（content_filter）：${refusalText}`);
    this.name = 'ContentFilterError';
    this.refusalText = refusalText;
  }
}
