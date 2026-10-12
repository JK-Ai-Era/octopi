/**
 * send_file fileRef 纯函数（无 React），供 WebUI 卡片重建与单测共用。
 */

export interface FileRef {
  fileId: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

/**
 * 从历史 tool_result 恢复 send_file 的 fileRef。
 *
 * 成功 outcome 形如 `{ kind:'value', data:{ fileId, name, mime, sizeBytes } }`
 * （ClientToolCallCard.resolve 的 LLM value）。metadata 被覆盖时仍可从
 * session.messages 兜底重建对话卡片。
 */
export function fileRefFromToolResult(toolName: string, result: unknown): FileRef | null {
  if (toolName !== 'send_file') return null;
  const data = extractFileRefData(result);
  if (!data?.fileId) return null;
  return {
    fileId: data.fileId,
    name: data.name || data.fileId,
    mime: data.mime || 'application/octet-stream',
    sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : 0,
  };
}

function extractFileRefData(result: unknown): {
  fileId?: string;
  name?: string;
  mime?: string;
  sizeBytes?: number;
} | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;
  // { kind:'value', data:{...} } 或直接 { fileId, ... }
  const nested = obj.data;
  const candidates = [obj, nested];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (typeof r.fileId === 'string' && r.fileId) {
      return {
        fileId: r.fileId,
        name: typeof r.name === 'string' ? r.name : undefined,
        mime: typeof r.mime === 'string' ? r.mime : undefined,
        sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : undefined,
      };
    }
  }
  return null;
}
