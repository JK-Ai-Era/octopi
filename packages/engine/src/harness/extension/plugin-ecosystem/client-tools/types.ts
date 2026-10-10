/**
 * Client Tool 契约 — 客户端能力接入 agent tool 面
 *
 * 设计见 arch/client-tools.md。与 Server Tool 同构进 tool 面；
 * 结果只允许小结构化 value 或 asset 引用（禁止大字节内联）。
 * 解释（OCR/抽取）在 server，client 只规范化。
 */

import type { ToolParameter } from '@octopi-agent/core/types/tools.js';

/** 注册名（进 LLM tool 列表；snake_case） */
export type ClientToolName = string;

/** 调用归属单元 id（Gateway 生成） */
export type ClientToolCallId = string;

export type ClientToolInteraction = 'silent' | 'ui' | 'device';

export type ClientToolSensitivity = 'public' | 'personal' | 'sensitive';

export interface ClientToolDeviceMeta {
  class?: 'sensor' | 'actuator' | 'media_io';
  sensitivity?: ClientToolSensitivity;
  /** none | prompt | strict — sensitive 不得为 none */
  consent?: 'none' | 'prompt' | 'strict';
}

/**
 * 插件/客户端注册的工具描述符。
 * `parameters` 与 Core `ToolDefinition.parameters` 同形，便于直接装进 tool 面。
 */
export interface ClientToolDescriptor {
  name: ClientToolName;
  /** 工具描述：用途/输入/结果。禁止 UI 控件与布局词汇 */
  description: string;
  parameters: Record<string, ToolParameter>;
  interaction?: ClientToolInteraction;
  device?: ClientToolDeviceMeta;
  /** 声明可能的结果种类（P0 支持 value / asset） */
  resultKinds?: Array<'value' | 'asset'>;
  version?: string;
}

export type ClientToolResult =
  | { kind: 'value'; data: unknown }
  | {
      kind: 'asset';
      assetId: string;
      mime: string;
      sizeBytes: number;
      name?: string;
      preview?: string;
    };

export type ClientToolErrorReason =
  | 'invalid_arguments'
  | 'client_unavailable'
  | 'consent_denied'
  | 'permission_denied'
  | 'expired'
  | 'cancelled'
  | 'unsupported'
  | 'internal';

export type ClientToolCallOutcome =
  | { status: 'ok'; result: ClientToolResult }
  | { status: 'error'; reason: ClientToolErrorReason; hint?: string };

export interface ClientToolCall {
  id: ClientToolCallId;
  name: ClientToolName;
  sessionId: string;
  runId?: string;
  agentId: string;
  args: Record<string, unknown>;
  /** 路由解析后的目标端；未解析时 undefined */
  targetClientInstanceId?: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  outcome?: ClientToolCallOutcome;
  completedByPrincipalId?: string;
  /** html_ui 等大正文落 attachment 后的引用 */
  assetId?: string;
  createdAt: number;
  ttlAt: number;
}

/** 已注册到某客户端实例的能力 */
export interface ClientToolProvider {
  clientInstanceId: string;
  sessionId: string;
  platform?: string;
  principalId?: string;
  /** 最近活跃时间戳，用于默认路由（最近活跃端） */
  lastActiveAt: number;
  descriptors: ClientToolDescriptor[];
}
