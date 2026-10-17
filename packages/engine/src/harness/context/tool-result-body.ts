/**
 * toolResultBody — 工具结果正文序列化（带缓存）
 *
 * 消息内容写入后不可变（全库无对已存在消息 content/toolResults/toolCalls 的
 * 原地修改；压缩器一律新建对象），同一 `tr` 对象可安全复用序列化结果。
 * 这消除每轮 context 装配里对同一批 toolResults 反复 `JSON.stringify` 的开销。
 */
const cache = new WeakMap<object, string>();

/**
 * 序列化工具结果正文：error → `{"error":...}`；string result 原文；否则 JSON。
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
        : JSON.stringify(tr.result ?? null);
  cache.set(key, body);
  return body;
}
