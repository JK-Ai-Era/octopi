/**
 * toolResultBody — 工具结果正文序列化（带缓存）
 *
 * 消息内容写入后不可变（全库无对已存在消息 content/toolResults/toolCalls 的
 * 原地修改；压缩器一律新建对象），同一 `tr` 对象可安全复用序列化结果。
 * 这消除每轮 context 装配里对同一批 toolResults 反复 `JSON.stringify` 的开销。
 * 注意：摘要投影（capabilities/compact 的会话文本化）也复用本缓存——原地改写
 * toolResult 不只影响 token 计数，还会让摘要吃到陈旧正文；上述不可变性是硬前提。
 */
const cache = new WeakMap<object, string>();

/**
 * v0.123.x 遗留信封字段名（**已废除**，仅作防泄漏闸的剥离目标）。
 *
 * 信封路线（result.contentBlocks 携 data 形态 base64）已于 v0.124.1 整体删除：
 * 现行结果只携 `imageRef` 引用（arch/file-read-image-view.md §2.1），base64 只活在
 * wire 水合后的视图里。旧会话数据可能仍含此字段——所有文本化/展示/索引/事件出口
 * 一律剥离它（`stripLegacyRichContent`），防遗留 base64 泄入 tool 文本。**无生产者、
 * 无 wire 转换路**：这不是兼容层，是死数据消毒。
 */
const LEGACY_CONTENT_BLOCKS = 'contentBlocks';

/** 图像引用（附件路线）：结果只放引用；data 形态仅存在于水合后的视图 */
export interface ToolImageRef {
  /** 派生媒体区 id（内容寻址文件名） */
  attachmentId?: string;
  /** 引用地址（持久形态 = 本地绝对路径；水合后视图可携 data） */
  url?: string;
  /** data 形态载荷（仅水合后视图；持久层永不落） */
  data?: string;
  mimeType?: string;
  alt?: string;
}

/**
 * 图像引用读口（附件路线唯一引形：`result.imageRef`）。
 *
 * @param result - 工具原始返回对象
 * @returns 引用对象；无引用返回 null
 */
export function readImageRef(result: unknown): ToolImageRef | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const ref = (result as Record<string, unknown>).imageRef;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  return ref as ToolImageRef;
}

/**
 * 序列化工具结果正文：error → `{"error":...}`；string result 原文；否则 JSON。
 *
 * 消毒（base64 永不入 tool 文本）：①v0.123.x 遗留信封字段；②水合态 `imageRef.data`
 * （hydrate 在视图克隆里注入的 base64 只允许走 richBlocks 图像通道，不进文本）。
 *
 * @param tr - 工具结果（error / result 至少其一）
 * @returns 正文字符串
 */
export function toolResultBody(tr: { error?: string; result?: unknown }): string {
  const key = tr as object;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const body =
    tr.error !== undefined
      ? JSON.stringify({ error: tr.error })
      : typeof tr.result === 'string'
        ? tr.result
        : JSON.stringify(sanitizeResultForText(tr.result) ?? null);
  cache.set(key, body);
  return body;
}

/** 文本化消毒：遗留信封 + 水合态 imageRef.data 一律不入 tool 文本 */
function sanitizeResultForText(result: unknown): unknown {
  const stripped = stripLegacyRichContent(result);
  if (!stripped || typeof stripped !== 'object' || Array.isArray(stripped)) return stripped;
  const record = stripped as Record<string, unknown>;
  const ref = record.imageRef;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return stripped;
  if (!('data' in (ref as Record<string, unknown>))) return stripped;
  const { data: _payload, ...refRest } = ref as Record<string, unknown>;
  return { ...record, imageRef: refRest };
}

/**
 * 遗留信封字段剥离（防泄漏闸，非兼容层）。
 *
 * v0.123.x 会话数据的 result.contentBlocks 可能携 base64——tool 文本、展示投影、
 * 搜索索引、事件出口一律不得携带它。现行结果无此字段（原样返回同一引用）。
 *
 * @param result - 工具原始返回对象
 * @returns 剥离遗留字段后的结果副本（无遗留字段原样返回）
 */
export function stripLegacyRichContent(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!(LEGACY_CONTENT_BLOCKS in record)) return result;
  const { [LEGACY_CONTENT_BLOCKS]: _dropped, ...rest } = record;
  return rest;
}
