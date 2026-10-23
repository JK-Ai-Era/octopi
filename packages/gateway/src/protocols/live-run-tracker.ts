/**
 * LiveRunTracker — 在途 Run 现场快照（盲窗 overlay 数据源）
 *
 * 聚合 WS 扇出口的 run 事件，回答「此刻这个会话的 Run 正在做什么」：
 * 流式中的正文/思考、正在执行的工具。供 messages API 附带 `live` 快照，
 * 让浏览器刷新后能恢复「最后一条未定形消息」的运行态（已定形消息由
 * 转录增量落盘保证在盘）。
 *
 * 生命周期与 Run 事件绑定：终态事件（engine.end / aborted / engine.error /
 * model.call.error）即清除。纯逻辑、无 IO，可单测。
 */

/** 正在执行的工具（tool.exec.start → tool.exec.end 之间） */
export interface LiveRunTool {
  toolCallId: string;
  name: string;
  args?: unknown;
  /** 行动简述（args.purpose） */
  purpose?: string;
  startedAt: number;
}

/** 在途 Run 现场快照（messages API 的 `live` 字段形状） */
export interface LiveRunOverlay {
  /** 'tools' = 有工具在跑；'streaming' = 正在吐 token；'waiting' = Run 活跃但暂无输出 */
  status: 'streaming' | 'tools' | 'waiting';
  /** 当前未定形 assistant 消息的流式正文（定形即入转录，overlay 清零） */
  streamingContent: string;
  streamingReasoning: string;
  runningTools: LiveRunTool[];
}

interface LiveRunEntry {
  status: LiveRunOverlay['status'];
  streamingContent: string;
  streamingReasoning: string;
  runningTools: Map<string, LiveRunTool>;
}

function toOverlay(entry: LiveRunEntry): LiveRunOverlay {
  return {
    status: entry.status,
    streamingContent: entry.streamingContent,
    streamingReasoning: entry.streamingReasoning,
    runningTools: [...entry.runningTools.values()],
  };
}

export class LiveRunTracker {
  private readonly runs = new Map<string, LiveRunEntry>();

  /**
   * 消费一个 run 事件，更新会话现场。
   *
   * @param sessionId - 会话 id（event.sessionId 缺失时由调用方回退 sessionKey）
   * @param event - WS 扇出口事件（type + data + timestamp）
   */
  observe(sessionId: string, event: { type: string; data?: Record<string, unknown>; timestamp?: number }): void {
    if (!sessionId) return;
    const existed = this.runs.has(sessionId);
    const entry = this.runs.get(sessionId) ?? {
      status: 'waiting' as const,
      streamingContent: '',
      streamingReasoning: '',
      runningTools: new Map<string, LiveRunTool>(),
    };

    switch (event.type) {
      case 'engine.start':
        // 新 run 边界：整现场复位（上一 Run 的终态事件若丢失，不得把旧工具/旧正文
        // 遗留给新 Run——会话内 Run 之间互不继承）
        entry.streamingContent = '';
        entry.streamingReasoning = '';
        entry.runningTools.clear();
        entry.status = 'waiting';
        break;

      case 'llm_stream_delta': {
        const delta = String(event.data?.delta ?? '');
        if (delta) entry.streamingContent += delta;
        entry.status = 'streaming';
        break;
      }

      case 'llm_thinking_delta': {
        const delta = String(event.data?.delta ?? '');
        if (delta) entry.streamingReasoning += delta;
        entry.status = 'streaming';
        break;
      }

      case 'model.call.start':
        // 新一轮 LLM：上一条 assistant 已定形入转录，overlay 不得再展示旧正文
        entry.streamingContent = '';
        entry.streamingReasoning = '';
        entry.status = 'waiting';
        break;

      case 'tool.exec.start': {
        const toolCallId = String(event.data?.toolCallId ?? '');
        if (toolCallId) {
          const argsObj = event.data?.args as Record<string, unknown> | undefined;
          entry.runningTools.set(toolCallId, {
            toolCallId,
            name: String(event.data?.toolName ?? 'unknown'),
            args: event.data?.args,
            purpose: argsObj && typeof argsObj.purpose === 'string' ? argsObj.purpose : undefined,
            startedAt: event.timestamp ?? Date.now(),
          });
        }
        // assistant 消息（含 tool_calls）已定形入转录：清流式缓冲防重复渲染
        entry.streamingContent = '';
        entry.streamingReasoning = '';
        entry.status = 'tools';
        break;
      }

      case 'tool.exec.end': {
        const toolCallId = String(event.data?.toolCallId ?? '');
        if (toolCallId) entry.runningTools.delete(toolCallId);
        entry.status = entry.runningTools.size > 0 ? 'tools' : 'waiting';
        break;
      }

      case 'turn.end': {
        const phase = event.data?.phase;
        entry.status =
          phase === 'pre_tools' || entry.runningTools.size > 0 ? 'tools' : 'waiting';
        // 与 ConversationAdapter.turn.end 同语义：assistant 消息已定形入转录，
        // 流式缓冲必须清空——否则 overlay 会把已定形正文再合成一条 streaming 气泡
        // （重复渲染），followUp 续轮还会把两轮正文粘连。
        entry.streamingContent = '';
        entry.streamingReasoning = '';
        break;
      }

      case 'engine.end':
      case 'aborted':
      case 'engine.error':
      case 'interrupted':
        // Run 终态：现场作废（后续可见性由落盘转录接管）。
        // model.call.error 不在此列：provider 级错误可被 fallback/retry 恢复，
        // Run 仍在途，清现场会让 overlay 永久消失。
        this.runs.delete(sessionId);
        return;

      default:
        // 无关事件不动现场；也不得为非活跃会话建条目（防系统级广播等垃圾累积）
        if (!existed) return;
        break;
    }

    this.runs.set(sessionId, entry);
  }

  /** 取在途 Run 现场；Run 不活跃（或从未开始）返回 undefined */
  get(sessionId: string): LiveRunOverlay | undefined {
    const entry = this.runs.get(sessionId);
    return entry ? toOverlay(entry) : undefined;
  }

  /** 清除会话现场（会话删除 / 会话切换收尾用） */
  clear(sessionId: string): void {
    this.runs.delete(sessionId);
  }
}
