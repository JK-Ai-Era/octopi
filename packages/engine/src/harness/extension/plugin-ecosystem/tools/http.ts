/**
 * http_request 工具 — HTTP 请求
 *
 * 让 Agent 能够主动发起 HTTP 请求，调用 REST API、获取网页内容。
 *
 * 出站：经 knowledge/network-guard SSRF 门（默认拒私网/环回/metadata；
 * connect 时 lookup 再校验）。内网目标需 `network.allowPrivateNetwork` 显式开。
 * 重定向每跳复验。shell `curl` 不经此路径（见 docs/KNOWN-ISSUES）。
 *
 * 超长响应：经 capabilities SummaryPort 做 L2 软净化 + L1 硬顶（见 arch/summary-compact.md §3.6）。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import {
  applyToolOutputGate,
  resolveSupportBinding,
  type ToolSummarySupport,
} from '../../../context/capabilities/summary/index.js';
import type { CredentialStore } from '../../../governance/credentials/store.js';
import {
  guardedRequest,
  type NetworkGuardOptions,
} from '../../../knowledge/network-guard.js';

export interface HttpRequestToolOptions {
  /** Summary L1/L2 支持；未提供时仅使用内置 L1 binding */
  summary?: ToolSummarySupport;
  /** 凭证库（credential 参数按名注入 header，模型不见明文） */
  credentials?: CredentialStore | null;
  /** SSRF 门选项（allowPrivateNetwork / timeout / maxRedirects…） */
  network?: NetworkGuardOptions;
  /** 强制 credential_bindings（空绑定即拒）；缺省随 store / Run 上下文 */
  requireBindings?: boolean;
}

const HTTP_CONSUMER = { kind: 'tool', id: 'http_request' } as const;

/**
 * 创建 http_request 工具
 *
 * @param options - 可选 SummaryPort / CredentialStore / network 门禁
 * @returns RegisteredTool
 */
export function createHttpRequestTool(options?: HttpRequestToolOptions): RegisteredTool {
  return {
    definition: {
      name: 'http_request',
      capabilities: ['egress'],
      description:
        'Make an HTTP request to a URL. Supports GET, POST, PUT, PATCH, DELETE. Returns status, headers, and body (large bodies may be summarized). Useful for API calls, web scraping, and webhook testing. Private/loopback/metadata addresses are blocked unless explicitly allowed.',
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
        credential: {
          type: 'string',
          description:
            'Named credential from the credential store (auth headers injected server-side; secret never returned). Subject to credential_bindings when bindings exist.',
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
    handler: async (args, context) => {
      const url = args.url as string;
      const method = ((args.method as string) ?? 'GET').toUpperCase();
      const headers = (args.headers as Record<string, string>) ?? {};
      const credentialName = args.credential as string | undefined;

      // jail network deny（workspace/untrusted）时强制不放行私网
      const allowPrivateNetwork =
        context?.networkPolicy === 'deny'
          ? false
          : (options?.network?.allowPrivateNetwork ?? false);

      if (credentialName) {
        const store = options?.credentials;
        if (!store) {
          throw new Error('credential parameter requires a configured CredentialStore');
        }
        // 只紧不松：config/tool/context/untrusted 任一为 true 即强制
        const requireBindings =
          context?.requireCredentialBindings === true ||
          options?.requireBindings === true;
        const resolved = await store.resolve(credentialName, HTTP_CONSUMER, {
          requireBindings: requireBindings ? true : undefined,
        });
        if (!resolved) {
          throw new Error(`credential not found or secret unavailable: ${credentialName}`);
        }
        // 凭证作底，显式 headers 可覆盖（头名统一小写，避免大小写双写）
        for (const [k, v] of Object.entries(resolved.headers)) {
          const lk = k.toLowerCase();
          const has = Object.keys(headers).some((h) => h.toLowerCase() === lk);
          if (!has) headers[k] = v;
        }
      }

      const body = args.body as string | undefined;
      const timeout = Math.min((args.timeout as number) ?? 30_000, 120_000);
      const maxResponseSize = (args.max_response_size as number) ?? 1_048_576;
      const summarizeArg = args.summarize as 'auto' | 'force' | 'off' | undefined;

      try {
        const response = await guardedRequest(
          url,
          {
            ...options?.network,
            allowPrivateNetwork,
            method,
            body,
            timeoutMs: timeout,
            maxResponseBytes: maxResponseSize,
            headers: {
              ...headers,
            },
          },
          { headers },
        );

        const responseBody = response.body;
        const truncated = response.bodyTruncated === true;

        const contentType = response.headers['content-type'] ?? response.headers['Content-Type'];
        const support = options?.summary;
        // 统一从 support（含配置 toolBindings）解析，避免 tools 再写死默认 binding
        const binding = resolveSupportBinding('http_request', support, 8000);

        const applied = await applyToolOutputGate({
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
          headers: response.headers,
          body: applied.body,
          bodyTruncated: truncated || applied.bodyTruncated,
          bodySizeBytes: applied.rawSizeBytes,
          bodyLength: applied.rawLength,
          summary: applied.summary,
          summaryUsage: applied.usage,
          url: response.url,
        };
      } catch (error) {
        if (error instanceof Error && /timeout/i.test(error.message)) {
          throw new Error(`Request to "${url}" timed out after ${timeout}ms`);
        }
        throw new Error(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
