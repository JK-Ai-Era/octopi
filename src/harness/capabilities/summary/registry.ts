/**
 * kind / tool 缺省路由与 ToolSummaryBinding 预置
 *
 * @module harness/capabilities/summary/registry
 */

import type { ContentKind, ToolSummaryBinding } from './types.js';

/** 文件扩展名 → ContentKind（声明式路由，非正文抽取） */
const EXT_KIND: Record<string, ContentKind> = {
  '.md': 'file_text',
  '.markdown': 'file_text',
  '.txt': 'file_text',
  '.log': 'log',
  '.html': 'web_page',
  '.htm': 'web_page',
  '.json': 'api_json',
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.py': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.kt': 'code',
  '.c': 'code',
  '.h': 'code',
  '.cpp': 'code',
  '.css': 'code',
  '.yml': 'file_text',
  '.yaml': 'file_text',
  '.toml': 'file_text',
  '.xml': 'file_text',
  '.csv': 'file_text',
};

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.css', '.sql', '.sh',
]);

/**
 * 从 MIME 推断 ContentKind
 *
 * @param contentType - HTTP Content-Type
 * @returns kind（未知为 auto）
 */
export function kindFromContentType(contentType?: string): ContentKind {
  if (!contentType) return 'auto';
  const ct = contentType.toLowerCase();
  if (ct.includes('html')) return 'web_page';
  if (ct.includes('json')) return 'api_json';
  if (ct.includes('text/plain')) return 'file_text';
  if (ct.includes('xml')) return 'file_text';
  return 'auto';
}

/**
 * 从文件扩展名推断 ContentKind
 *
 * @param extension - 含点扩展名，如 `.ts`
 * @returns kind（未知为 auto）
 */
export function kindFromExtension(extension?: string): ContentKind {
  if (!extension) return 'auto';
  const ext = extension.toLowerCase();
  if (CODE_EXTS.has(ext)) return 'code';
  return EXT_KIND[ext] ?? 'auto';
}

/**
 * kind → 默认 policy id
 *
 * @param kind - 内容形态
 * @returns policy id
 */
export function defaultPolicyIdForKind(kind: ContentKind): string {
  switch (kind) {
    case 'web_page':
      return 'web_page_extract';
    case 'api_json':
      return 'api_json_extract';
    case 'file_text':
      return 'file_text_extract';
    case 'code':
      return 'code_overview';
    case 'document':
      return 'document_extract';
    case 'log':
      return 'log_digest';
    case 'conversation':
      return 'conversation_default';
    default:
      return 'opaque_generic';
  }
}

/**
 * 工具缺省 kind（在 source 元数据不可用时）
 *
 * @param tool - 工具名
 * @returns kind
 */
export function defaultKindForTool(tool: string): ContentKind {
  if (tool === 'http_request') return 'auto';
  if (tool === 'file_read') return 'auto';
  return 'opaque';
}

const INFORMATIONAL_DEFAULT: ContentKind[] = ['web_page', 'api_json', 'document', 'file_text', 'log', 'conversation'];

/**
 * 内置 ToolSummaryBinding 缺省表
 *
 * @returns tool 名 → binding
 */
export function createDefaultToolBindings(): Record<string, ToolSummaryBinding> {
  return {
    http_request: {
      tool: 'http_request',
      mode: 'auto',
      maxReturnChars: 8000,
      kindFromSource: true,
      informationalKinds: INFORMATIONAL_DEFAULT,
      onFail: 'truncate_l1',
    },
    file_read: {
      tool: 'file_read',
      mode: 'kind_sensitive',
      maxReturnChars: 12000,
      kindFromSource: true,
      // code 默认不 L2，保护「需要可编辑原文」的场景
      informationalKinds: ['document', 'log', 'file_text', 'web_page'],
      onFail: 'truncate_l1',
    },
  };
}

/**
 * 合并工具 binding（内置 + 配置覆盖）
 *
 * @param tool - 工具名
 * @param defaults - 内置表
 * @param overrides - 配置覆盖
 * @param globalMaxReturnChars - 全局 L1 缺省
 * @returns 最终 binding
 */
export function resolveToolBinding(
  tool: string,
  defaults: Record<string, ToolSummaryBinding>,
  overrides: Record<string, Partial<ToolSummaryBinding>> | undefined,
  globalMaxReturnChars: number,
): ToolSummaryBinding {
  const base = defaults[tool] ?? {
    tool,
    mode: 'auto' as const,
    maxReturnChars: globalMaxReturnChars,
    kindFromSource: true,
    informationalKinds: INFORMATIONAL_DEFAULT,
    onFail: 'truncate_l1' as const,
  };
  const ov = overrides?.[tool];
  return {
    ...base,
    ...ov,
    tool,
    maxReturnChars: ov?.maxReturnChars ?? base.maxReturnChars ?? globalMaxReturnChars,
  };
}
