/**
 * applyLiveRunOverlay — 在途 Run 盲窗 overlay → 会话视图合成
 *
 * 背景：已定形消息由转录增量落盘保证在盘（history 权威）；盲窗只剩
 * 「未定形的流式 assistant 正文」与「running 工具」。messages API 附带的
 * `live` 快照在 hydration 时合成运行态条目，刷新后无缝续接 WS 流式事件
 * （adapterState 恢复到 ConversationAdapter）。
 *
 * 冲突规则：同 toolCallId / 同 id 已在 items 时以 items 为准（history 是
 * 权威；live 只补缺），不产生重复渲染。
 */

import type { LiveRunOverlay } from '../../protocols/live-run-tracker.js';
import type { AdapterSnapshot } from './adapter.js';
import type {
  AssistantConversationItem,
  ConversationItem,
  ToolConversationItem,
} from './types.js';

export interface LiveOverlayResult {
  items: ConversationItem[];
  /** toolCallId → conversationItemId（合成条目） */
  toolIndex: Record<string, string>;
  /** 供 ConversationAdapter.restoreState：后续流式事件无缝接续 */
  adapterState: AdapterSnapshot;
}

/**
 * 把 live 快照合成进会话条目。
 *
 * @param sessionId - 会话 id（合成条目的归属）
 * @param items - 已构建的会话条目（history；本函数不修改原数组）
 * @param live - messages API 附带的在途 Run 现场快照
 * @returns 合成后的条目与 adapter 恢复状态
 */
export function applyLiveRunOverlay(
  sessionId: string,
  items: ConversationItem[],
  live: LiveRunOverlay,
): LiveOverlayResult {
  const toolIndex: Record<string, string> = {};
  // 二次应用幂等：先剔除上次合成的残留（同 id 重建，防重复气泡）；无残留保持原数组引用
  const hasSynthetic = items.some(
    (it) => it.id === 'live-assistant' || it.id.startsWith('live-tool-'),
  );
  const base = hasSynthetic
    ? items.filter((it) => it.id !== 'live-assistant' && !it.id.startsWith('live-tool-'))
    : items;
  const appended: ConversationItem[] = [];

  for (const tool of live.runningTools) {
    const exists = base.some(
      (it) => it.role === 'tool' && (it as ToolConversationItem).toolCallId === tool.toolCallId,
    );
    if (exists) continue;
    const toolItem: ToolConversationItem = {
      id: `live-tool-${tool.toolCallId}`,
      role: 'tool',
      createdAt: tool.startedAt,
      sessionId,
      source: 'runtime',
      toolName: tool.name,
      toolCallId: tool.toolCallId,
      purpose: tool.purpose,
      status: 'running',
      args: tool.args,
      expandable: true,
    };
    toolIndex[tool.toolCallId] = toolItem.id;
    appended.push(toolItem);
  }

  const hasStreaming = live.streamingContent.length > 0 || live.streamingReasoning.length > 0;
  let currentAssistantId: string | undefined;
  // 事件路径已插入的 streaming 条目优先（订阅后 WS 事件与快照校准可能交错）：
  // 不重复合成，但要接续其 id，否则后续 delta 会再开一条气泡
  const existingStreaming = base.find(
    (it) => it.role === 'assistant' && (it as AssistantConversationItem).status === 'streaming',
  );
  if (hasStreaming && !existingStreaming) {
    const assistantItem: AssistantConversationItem = {
      id: 'live-assistant',
      role: 'assistant',
      createdAt: Date.now(),
      sessionId,
      source: 'runtime',
      status: 'streaming',
      content: live.streamingContent,
      reasoning: live.streamingReasoning || undefined,
      toolCalls: Object.keys(toolIndex),
    };
    currentAssistantId = assistantItem.id;
    appended.push(assistantItem);
  } else if (hasStreaming && existingStreaming) {
    currentAssistantId = existingStreaming.id;
  }

  return {
    items: appended.length > 0 ? [...base, ...appended] : base,
    toolIndex,
    adapterState: {
      currentAssistantId,
      toolIndex,
      streamingContent: live.streamingContent,
      streamingReasoning: live.streamingReasoning,
      lastTurnEndContent: undefined,
    },
  };
}
