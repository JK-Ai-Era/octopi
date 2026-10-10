/**
 * createClientTool — 把 ClientToolDescriptor 装成 RegisteredTool
 *
 * 与 createAskUserTool 同模式：handler 经 invoker 闭包注入，
 * Host（Gateway）负责路由到客户端并等待 ClientToolCallOutcome。
 *
 * 返回值约定（LLM 可见）：
 * - ok+value → { kind:'value', data }
 * - ok+asset → { kind:'asset', assetId, mime, sizeBytes, ... }
 * - error    → { error: reason, hint? }  （显式失败，禁止空成功）
 */

import type { RegisteredTool, ToolExecutionContext, ToolParameter } from '@octopi-agent/core/types/tools.js';
import type {
  ClientToolCallOutcome,
  ClientToolDescriptor,
  ClientToolResult,
} from './types.js';

export interface ClientToolInvokeRequest {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  agentId: string;
  /** 生成的 callId，Host 可用于挂 pending */
  callId: string;
  ttlAt: number;
  /** 与 Loop toolCallId 对齐（可选；Host 可回填） */
  toolCallId?: string;
  runId?: string;
  /** Run 中止信号；Host 应据此取消 pending */
  abortSignal?: AbortSignal;
}

/** Client tool 在 LLM tool 面上的可见性（会话级） */
export type ClientToolVisibility = (sessionId: string, toolName: string) => boolean;

/**
 * Host 侧执行：路由到 client、等待 UI/设备、返回结局。
 */
export type ClientToolInvoker = (
  request: ClientToolInvokeRequest,
  context: ToolExecutionContext,
) => Promise<ClientToolCallOutcome>;

/** 默认工具等待上限（与 definition.timeoutMs 对齐） */
export const DEFAULT_CLIENT_TOOL_TIMEOUT_MS = 300_000;

/** 生成 callId（Host 也可覆盖） */
export function makeClientToolCallId(): string {
  return `ctc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** 按 ToolParameter 校验调用参数（LLM 直呼 handler 时 ToolBus 不代验） */
export function validateClientToolArgs(
  parameters: Record<string, ToolParameter>,
  args: Record<string, unknown>,
): string | null {
  for (const [key, param] of Object.entries(parameters)) {
    const value = args[key];
    if (value === undefined || value === null) {
      if (param.required) return `missing required argument "${key}"`;
      continue;
    }
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const expected = param.type === 'object' && actual === 'object' ? 'object' : param.type;
    if (param.type === 'object' ? actual !== 'object' || Array.isArray(value) : actual !== expected) {
      return `argument "${key}" must be ${param.type}, got ${actual}`;
    }
    if (param.enum && !param.enum.includes(value as string | number)) {
      return `argument "${key}" must be one of: ${param.enum.join(', ')}`;
    }
    if (param.type === 'string' && typeof value === 'string') {
      if (param.minLength != null && value.length < param.minLength) {
        return `argument "${key}" minLength=${param.minLength}`;
      }
      if (param.maxLength != null && value.length > param.maxLength) {
        return `argument "${key}" maxLength=${param.maxLength}`;
      }
    }
  }
  return null;
}

/** 敏感 device 必须带 purpose（§6 红线：禁止无理由采集） */
export function requireDevicePurpose(
  descriptor: ClientToolDescriptor,
  args: Record<string, unknown>,
): string | null {
  if (descriptor.interaction !== 'device') return null;
  const sensitivity = descriptor.device?.sensitivity ?? 'personal';
  if (sensitivity === 'public') return null;
  const purpose = args.purpose;
  if (typeof purpose !== 'string' || purpose.trim().length === 0) {
    return 'purpose is required for device tools with personal/sensitive data';
  }
  return null;
}

/** 注册前描述符校验（REST/插件入口防污染 tool 面） */
export function validateClientToolDescriptor(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'descriptor must be an object';
  const d = raw as Record<string, unknown>;
  if (typeof d.name !== 'string' || d.name.trim().length === 0) return 'name must be a non-empty string';
  if (typeof d.description !== 'string' || d.description.trim().length === 0) {
    return `descriptor "${String(d.name)}": description must be a non-empty string`;
  }
  if (!d.parameters || typeof d.parameters !== 'object' || Array.isArray(d.parameters)) {
    return `descriptor "${d.name}": parameters must be an object`;
  }
  if (d.interaction != null && !['silent', 'ui', 'device'].includes(String(d.interaction))) {
    return `descriptor "${d.name}": interaction must be silent|ui|device`;
  }
  return null;
}

/** resolve 入参校验：禁止 ok 空 result / 未知 reason（§14.2 无空成功） */
export function validateClientToolOutcome(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'outcome must be an object';
  const o = raw as Record<string, unknown>;
  if (o.status === 'ok') {
    const result = o.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== 'object') return 'outcome.ok requires result';
    if (result.kind === 'value') {
      if (!('data' in result)) return 'outcome.ok.value requires data';
      return null;
    }
    if (result.kind === 'asset') {
      if (typeof result.assetId !== 'string' || !result.assetId) return 'asset requires assetId';
      if (typeof result.mime !== 'string' || !result.mime) return 'asset requires mime';
      if (typeof result.sizeBytes !== 'number') return 'asset requires sizeBytes';
      return null;
    }
    return 'result.kind must be value|asset';
  }
  if (o.status === 'error') {
    const allowed = [
      'invalid_arguments',
      'client_unavailable',
      'consent_denied',
      'permission_denied',
      'expired',
      'cancelled',
      'unsupported',
      'internal',
    ];
    if (typeof o.reason !== 'string' || !allowed.includes(o.reason)) {
      return `outcome.error.reason must be one of: ${allowed.join(', ')}`;
    }
    return null;
  }
  return 'outcome.status must be ok|error';
}

function outcomeToLlmResult(outcome: ClientToolCallOutcome): unknown {
  if (outcome.status === 'ok') {
    return toLlmSuccess(outcome.result);
  }
  return { error: outcome.reason, hint: outcome.hint };
}

function toLlmSuccess(result: ClientToolResult): unknown {
  if (result.kind === 'value') {
    return { kind: 'value', data: result.data };
  }
  return {
    kind: 'asset',
    assetId: result.assetId,
    mime: result.mime,
    sizeBytes: result.sizeBytes,
    name: result.name,
    preview: result.preview,
  };
}

/**
 * 创建可注册进 ToolBus 的 Client Tool
 *
 * @param descriptor - 客户端注册的能力契约
 * @param invoker - Host 执行体（路由 + 等待）
 * @param options.timeoutMs - 等待上限；超时返回 expired
 */
export function createClientTool(
  descriptor: ClientToolDescriptor,
  invoker: ClientToolInvoker,
  options?: { timeoutMs?: number; makeCallId?: () => string },
): RegisteredTool {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLIENT_TOOL_TIMEOUT_MS;
  const makeCallId = options?.makeCallId ?? makeClientToolCallId;

  return {
    definition: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
      timeoutMs,
      version: descriptor.version,
      requiresConfirmation:
        descriptor.interaction === 'device' &&
        (descriptor.device?.consent ?? 'prompt') !== 'none',
    },
    handler: async (args, context) => {
      if (context?.abortSignal?.aborted) {
        return { error: 'cancelled', hint: 'aborted before client tool invoke' };
      }

      const argError = validateClientToolArgs(descriptor.parameters ?? {}, args);
      if (argError) {
        return { error: 'invalid_arguments', hint: argError };
      }
      const purposeError = requireDevicePurpose(descriptor, args);
      if (purposeError) {
        return { error: 'invalid_arguments', hint: purposeError };
      }

      const callId = makeCallId();
      const ttlAt = Date.now() + timeoutMs;

      const abortSignal = context?.abortSignal;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const outcome = await new Promise<ClientToolCallOutcome>((resolve, reject) => {
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          resolve({
            status: 'error',
            reason: 'cancelled',
            hint: 'run aborted while waiting for client tool',
          });
        };

        if (abortSignal) {
          abortSignal.addEventListener('abort', onAbort, { once: true });
          if (abortSignal.aborted) {
            onAbort();
            return;
          }
        }

        timer = setTimeout(() => {
          cleanup();
          resolve({
            status: 'error',
            reason: 'expired',
            hint: `client tool timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);

        invoker(
          {
            name: descriptor.name,
            args,
            sessionId: context?.sessionId ?? 'unknown',
            agentId: context?.agentId ?? 'unknown',
            callId,
            ttlAt,
            abortSignal,
          },
          context,
        ).then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (err) => {
            cleanup();
            resolve({
              status: 'error',
              reason: 'internal',
              hint: err instanceof Error ? err.message : String(err),
            });
          },
        );
      });

      return outcomeToLlmResult(outcome);
    },
  };
}
