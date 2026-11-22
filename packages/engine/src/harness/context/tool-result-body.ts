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
 * 工具富内容信封字段名（arch/file-read-image-view.md §2.1）。
 *
 * 工具结果对象可携带 `contentBlocks: ContentBlock[]` 作为**消息级富内容**：
 * - 文本序列化（本文件）一律剥离，防 base64 进 tool 文本（token 炸弹 + 计数漂移）；
 * - wire 面由 `convertMessage` 消费（tool 分支提取 → 挂 ImageBlock，§2.4 分派）；
 * - 老化（ageResult）整体改写 result 时信封随之消失，不留 base64（§2.5）。
 */
export const TOOL_RESULT_CONTENT_BLOCKS = 'contentBlocks';

/**
 * 从工具结果提取富内容块（信封读口；convertMessage / 消费方唯一入口）。
 *
 * @param result - 工具原始返回对象
 * @returns 内容块数组；无信封返回空数组
 */
export function extractContentBlocks(result: unknown): Array<{ type: string; [key: string]: unknown }> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const blocks = (result as Record<string, unknown>)[TOOL_RESULT_CONTENT_BLOCKS];
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(
    (b): b is { type: string; [key: string]: unknown } =>
      Boolean(b) && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string',
  );
}

/**
 * 序列化工具结果正文：error → `{"error":...}`；string result 原文；否则 JSON。
 *
 * 富内容信封（contentBlocks）在此**整体剥离**——正文只留指针/元信息；
 * base64 载荷永远不进 tool 文本。
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
        : JSON.stringify(stripContentBlocks(tr.result) ?? null);
  cache.set(key, body);
  return body;
}

/** 剥离信封字段后的结果副本（无信封原样返回，避免无谓分配）
 *
 * 公开导出：展示投影（gateway conversation adapter）是信封的合法消费者——
 * base64 不是展示数据，投影面剥离与 toolResultBody 同一实现（one source of truth）。
 */
export function stripContentBlocks(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!(TOOL_RESULT_CONTENT_BLOCKS in record)) return result;
  const { [TOOL_RESULT_CONTENT_BLOCKS]: _dropped, ...rest } = record;
  return rest;
}

/**
 * 信封块替换副本（水合/变换用）。总是返回携带新块的副本——调用方负责判变化
 * （无信封/未变化时 hydrate 等调用方自行短路，避免无谓分配）。
 *
 * @param result - 工具原始返回对象
 * @param blocks - 新的内容块数组
 * @returns 替换信封后的结果副本
 */
export function withContentBlocks(
  result: unknown,
  blocks: Array<{ type: string; [key: string]: unknown }>,
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  return { ...(result as Record<string, unknown>), [TOOL_RESULT_CONTENT_BLOCKS]: blocks };
}
