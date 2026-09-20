/**
 * RunScope → Observer 快照构建
 */

import type { Message } from '../../core/types.js';
import type { RunScope } from '../run-scope.js';
import type { ResolvedObserverConfig } from './types.js';
import {
  attachFullContent,
  cloneMessages,
  shouldCaptureMessageFullText,
  summarizeMessages,
  type RunMessagesPhase,
  type RunMessagesSnapshot,
  type RunScopeView,
} from './types.js';

const SYSTEM_PROMPT_PREVIEW_CHARS = 240;

/**
 * 构建 RunScope UI 视图
 *
 * @param input - scope 与可选 run 元数据
 * @returns RunScopeView
 */
export function buildRunScopeView(input: {
  scope: RunScope;
  runId?: string;
  resolvedModel?: { modelName?: string; providerId?: string; contextWindow?: number };
  capturedAt?: number;
  /** 是否输出 systemPrompt 预览（payload.layerPreview/layerContent）；默认 false */
  includeSystemPromptPreview?: boolean;
  /** 是否输出 systemPrompt 全文（level=full / payload.layerContent）；默认 false */
  includeSystemPromptFull?: boolean;
}): RunScopeView {
  const { scope } = input;
  const systemPrompt = scope.systemPrompt;
  const wantPreview = input.includeSystemPromptPreview === true;
  const wantFull = input.includeSystemPromptFull === true;
  return {
    sessionId: scope.sessionId,
    agentId: scope.agentId,
    runId: input.runId ?? scope.runId,
    agentRevision: scope.agentRevision,
    systemPromptChars: systemPrompt ? systemPrompt.length : 0,
    systemPromptPreview:
      wantPreview && systemPrompt ? systemPrompt.slice(0, SYSTEM_PROMPT_PREVIEW_CHARS) : '',
    systemPromptFull: wantFull && systemPrompt ? systemPrompt : undefined,
    toolRuntime: scope.toolRuntime
      ? {
          sessionId: scope.toolRuntime.sessionId,
          agentId: scope.toolRuntime.agentId,
          messagesCount: scope.toolRuntime.messages?.length ?? 0,
          cwd: scope.toolRuntime.cwd,
          isolation: scope.toolRuntime.isolation,
        }
      : undefined,
    resolvedModel: input.resolvedModel,
    capturedAt: input.capturedAt ?? Date.now(),
  };
}

/**
 * 构建 Run messages 快照（摘要始终；全文视配置）
 *
 * @param params - 会话/run/消息
 * @param cfg - observer 配置
 * @returns RunMessagesSnapshot + 可选完整视图
 */
export function buildRunMessagesSnapshot(params: {
  sessionId: string;
  agentId?: string;
  runId?: string;
  messages: Message[];
  phase: RunMessagesPhase;
  runCapturedAt?: number;
  notes?: string;
}, cfg: ResolvedObserverConfig): { snapshot: RunMessagesSnapshot; cloned?: Message[]; views?: ReturnType<typeof attachFullContent> } {
  const { summary, views } = summarizeMessages(params.messages);
  const wantFull = shouldCaptureMessageFullText(cfg);
  const cloned = wantFull ? cloneMessages(params.messages) : undefined;
  const fullViews = wantFull ? attachFullContent(views, params.messages) : undefined;

  const snapshot: RunMessagesSnapshot = {
    sessionId: params.sessionId,
    agentId: params.agentId,
    runId: params.runId,
    runCapturedAt: params.runCapturedAt ?? Date.now(),
    view: 'workspace',
    phase: params.phase,
    summary,
    messages: fullViews,
    notes:
      params.notes ??
      (wantFull
        ? 'workspace 全文（含对话 UI 会隐藏的 system/摘要条目）'
        : 'summary 模式：未采集 message 全文；可将 observer.level=full'),
  };

  return { snapshot, cloned, views: fullViews };
}
