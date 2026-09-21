/**
 * http_request 工具 — HTTP 请求
 *
 * 让 Agent 能够主动发起 HTTP 请求，调用 REST API、获取网页内容。
 * 使用 Node.js 20+ 内置 fetch，零额外依赖。
 *
 * 超长响应：经 capabilities SummaryPort 做 L2 软净化 + L1 硬顶（见 arch/summary-compact.md §3.6）。
 *
 * 安全注意事项：
 * - 生产环境应通过 ToolPolicy 限制可访问的域名
 * - 内网访问默认允许，可通过 security guard 拦截
 */

import type { RegisteredTool } from '../../../core/types.js';
import {
  applyToolSummary,
  resolveSupportBinding,
  type ToolSummarySupport,
} from '../../capabilities/summary/index.js';

export interface HttpRequestToolOptions {
  /** Summary L1/L2 支持；未提供时仅使用内置 L1 binding */
  summary?: ToolSummarySupport;
}

/**
 * 创建 http_request 工具
 *
 * @param options - 可选 SummaryPort / binding 配置注入
 * @returns RegisteredTool
 */
export function createHttpRequestTool(options?: HttpRequestToolOptions): RegisteredTool {
  return {
    definition: {
      name: 'http_request',
      description:
        'Make an HTTP request to a URL. Supports GET, POST, PUT, PATCH, DELETE. Returns status, headers, and body (large bodies may be summarized). Useful for API calls, web scraping, and webhook testing.',
      parameters: {
        url: {
          type: 'string',
          description: 'The URL to request',
          required: true,
          pattern: '^https?://',
        },
        method: {
          type: 'string',
          description: 'HTTP method (default: GET)',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        },
        headers: {
          type: 'object',
          description: 'Request headers as key-value pairs',
        },
        body: {
          type: 'string',
          description: 'Request body (for POST/PUT/PATCH). For JSON, set Content-Type to application/json.',
        },
        timeout: {
          type: 'number',
          description: 'Request timeout in milliseconds (default: 30000, max: 120000)',
          minimum: 1000,
          maximum: 120_000,
        },
        max_response_size: {
          type: 'number',
          description: 'Maximum response body size in bytes (default: 1048576, i.e. 1MB)',
          minimum: 1024,
          maximum: 10_485_760,
        },
        summarize: {
          type: 'string',
          description: 'Summary mode for large bodies: auto (default) | force | off. off still applies hard size cap.',
          enum: ['auto', 'force', 'off'],
        },
        summary_task: {
          type: 'string',
          description: 'Optional extraction goal when summarizing the response body',
        },
        summary_policy: {
          type: 'string',
          description: 'Optional SummaryPolicy id override',
        },
      },
      timeoutMs: 120_000,
    },
    handler: async (args, _context) => {
      const url = args.url as string;
      const method = (args.method as string) ?? 'GET';
      const headers = (args.headers as Record<string, string>) ?? {};
      const body = args.body as string | undefined;
      const timeout = Math.min((args.timeout as number) ?? 30_000, 120_000);
      const maxResponseSize = (args.max_response_size as number) ?? 1_048_576;
      const summarizeArg = args.summarize as 'auto' | 'force' | 'off' | undefined;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        const reader = response.body?.getReader();
        let responseBody = '';
        let truncated = false;

        if (reader) {
          const decoder = new TextDecoder();
          let totalBytes = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            responseBody += decoder.decode(value, { stream: true });

            if (totalBytes >= maxResponseSize) {
              truncated = true;
              reader.cancel();
              break;
            }
          }
        }

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const contentType = responseHeaders['content-type'] ?? responseHeaders['Content-Type'];
        const support = options?.summary;
        // 统一从 support（含配置 toolBindings）解析，避免 tools 再写死默认 binding
        const binding = resolveSupportBinding('http_request', support, 8000);

        const applied = await applyToolSummary({
          tool: 'http_request',
          rawBody: responseBody,
          support: { ...support, binding },
          locator: response.url || url,
          contentType,
          task: args.summary_task as string | undefined,
          policyId: args.summary_policy as string | undefined,
          summarizeArg,
          truncateHint:
            'Use http_request with summarize=force or a narrower URL/pagination to read more.',
        });

        return {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: applied.body,
          bodyTruncated: truncated || applied.bodyTruncated,
          bodySizeBytes: applied.rawSizeBytes,
          bodyLength: applied.rawLength,
          summary: applied.summary,
          summaryUsage: applied.usage,
          url: response.url,
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Request to "${url}" timed out after ${timeout}ms`);
        }
        throw new Error(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
