/**
 * EventSource — 外部事件源协议
 *
 * 职责：定义外部事件如何进入 Agent 系统。
 * 实现方：Webhook、FileWatcher、Timer、Signal、消息队列等。
 *
 * 设计要点：
 * - Core 层定义事件如何流动，不关心事件从哪来
 * - Harness 层实现具体的 EventSource
 * - EventSource 通过 EventBus 发射事件，与现有事件系统统一
 * - 支持生命周期管理（start/stop）
 */

// ── 事件源元数据 ──

/** 事件源描述 */
export interface EventSourceDescriptor {
  /** 事件源唯一 ID */
  id: string;
  /** 事件源类型（如 'webhook', 'file-watcher', 'timer'） */
  type: string;
  /** 人类可读的描述 */
  description?: string;
  /** 事件源配置（类型特定） */
  config?: Record<string, unknown>;
}

// ── 事件源接口 ──

/**
 * EventSource 接口
 *
 * 外部事件源实现此接口，将外部事件注入 Agent 系统。
 * Harness 层的 EventSourceManager 负责生命周期管理。
 */
export interface EventSource {
  /** 事件源描述 */
  readonly descriptor: EventSourceDescriptor;

  /**
   * 启动事件源
   *
   * 开始监听外部事件。启动后通过 emit 回调发射事件。
   * @param emit - 发射事件到 EventBus 的回调
   */
  start(emit: (event: ExternalEvent) => void): Promise<void>;

  /**
   * 停止事件源
   *
   * 停止监听，释放资源。
   */
  stop(): Promise<void>;

  /**
   * 事件源是否正在运行
   */
  isRunning(): boolean;
}

// ── 外部事件 ──

/** 外部事件 */
export interface ExternalEvent {
  /** 事件类型（用于 EventBus 路由） */
  type: string;
  /** 来源事件源 ID */
  sourceId: string;
  /** 事件载荷 */
  payload: unknown;
  /** 事件时间戳（来源端产生时间） */
  timestamp: number;
  /** 事件元数据 */
  metadata?: Record<string, unknown>;
}
