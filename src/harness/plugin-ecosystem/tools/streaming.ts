/**
 * 流式工具执行 — 进度事件类型
 *
 * 扩展 ExecutionContext，添加进度回调支持。
 */

/** 工具进度事件类型 */
export type ToolProgressEventType = 'start' | 'progress' | 'output' | 'complete';

/** 工具进度事件 */
export interface ToolProgressEvent {
  /** 事件类型 */
  type: ToolProgressEventType;
  /** 工具名称 */
  toolName: string;
  /** 调用 ID */
  callId: string;
  /** 时间戳 */
  timestamp: number;
  /** 进度信息 */
  progress?: {
    /** 当前进度 */
    current: number;
    /** 总数 */
    total: number;
    /** 进度消息 */
    message?: string;
  };
  /** 输出流 */
  output?: {
    /** 流类型 */
    stream: 'stdout' | 'stderr';
    /** 输出数据 */
    data: string;
  };
}

/**
 * 创建进度回调工厂函数
 *
 * 用于工具实现中报告进度。
 */
export function createProgressReporter(
  toolName: string,
  callId: string,
  onProgress?: (event: ToolProgressEvent) => void
) {
  return {
    /** 报告开始 */
    start: () => {
      onProgress?.({
        type: 'start',
        toolName,
        callId,
        timestamp: Date.now(),
      });
    },

    /** 报告进度 */
    progress: (current: number, total: number, message?: string) => {
      onProgress?.({
        type: 'progress',
        toolName,
        callId,
        timestamp: Date.now(),
        progress: { current, total, message },
      });
    },

    /** 报告输出 */
    output: (stream: 'stdout' | 'stderr', data: string) => {
      onProgress?.({
        type: 'output',
        toolName,
        callId,
        timestamp: Date.now(),
        output: { stream, data },
      });
    },

    /** 报告完成 */
    complete: () => {
      onProgress?.({
        type: 'complete',
        toolName,
        callId,
        timestamp: Date.now(),
      });
    },
  };
}
