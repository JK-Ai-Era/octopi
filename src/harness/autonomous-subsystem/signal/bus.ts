/**
 * Autonomous Subsystem — SignalBus
 *
 * 信号投递总线。将子系统的 Signal 按通道投递到目标队列。
 * 替代旧的 InjectionQueue + handleNotify 的混合方案。
 *
 * @module autonomous-subsystem/signal/bus
 */

import type { Message } from '../../../core/types.js';
import type { EventBus, AgentEvent } from '../../../core/primitives/event-bus.js';
import type { Signal, SignalAction, SignalChannel, SignalSeverity, SubsystemOutput } from '../types.js';
import { SIGNAL_PRIORITY } from '../types.js';

// ── 投递目标 ──

/**
 * 信号投递条目
 */
export interface SignalEntry {
  /** 来源子系统 ID */
  subsystemId: string;
  /** 信号 */
  signal: Signal;
  /** 投递的通道 */
  channel: SignalChannel;
  /** 时间戳 */
  timestamp: number;
}

// ── Context 条目 ──

/**
 * 注入到主 Agent 上下文的消息
 */
export interface ContextInjection {
  /** 来源子系统 ID */
  subsystemId: string;
  /** 消息列表 */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** 是否标记为压缩结果 */
  compressed?: boolean;
}

// ── SignalBus 配置 ──

export interface SignalBusConfig {
  /** EventBus 实例 */
  events: EventBus;
}

/**
 * SignalBus — 信号投递总线
 *
 * 职责：
 * 1. 接收子系统的 Signal
 * 2. 按 channel 投递到对应的队列
 * 3. 处理信号冲突（按 SIGNAL_PRIORITY 排序）
 * 4. 提供消费接口供主循环使用
 */
export class SignalBus {
  private events: EventBus;
  /** context 通道队列（待注入主 Agent 上下文的消息） */
  private contextQueue: ContextInjection[] = [];
  /** steering 通道队列（待注入引导消息） */
  private steeringQueue: SignalEntry[] = [];
  /** escalate 通道队列（待处理的升级请求） */
  private escalateQueue: SignalEntry[] = [];

  constructor(config: SignalBusConfig) {
    this.events = config.events;
  }

  /**
   * 投递子系统的全部信号
   *
   * @param subsystemId - 来源子系统 ID
   * @param output - 子系统输出（包含 signals 列表）
   */
  deliver(subsystemId: string, output: SubsystemOutput, signalConfig?: { channel?: SignalChannel[] }): void {
    const now = Date.now();

    // 按优先级排序信号
    const sorted = [...output.signals].sort(
      (a, b) => (SIGNAL_PRIORITY[a.action] ?? 99) - (SIGNAL_PRIORITY[b.action] ?? 99),
    );

    for (const signal of sorted) {
      const channels = signalConfig?.channel && signalConfig.channel.length > 0
        ? signalConfig.channel
        : this.inferChannels(signal);

      for (const channel of channels) {
        const entry: SignalEntry = {
          subsystemId,
          signal,
          channel,
          timestamp: now,
        };

        switch (channel) {
          case 'context':
            this.deliverToContext(subsystemId, signal);
            break;
          case 'steering':
            this.steeringQueue.push(entry);
            break;
          case 'event':
            this.deliverToEvent(subsystemId, signal);
            break;
          case 'escalate':
            this.escalateQueue.push(entry);
            break;
        }
      }
    }
  }

  /**
   * 消费 context 通道的所有待处理注入
   *
   * 在主 Agent 的 ContextEngine assemble 前调用。
   *
   * @param messages - 主 Agent 的消息数组引用
   */
  applyPendingContext(messages: Message[]): void {
    // replace 类型优先于 inject（compressed 标记表示 replace）
    const sorted = [...this.contextQueue].sort((a, b) => {
      const aPriority = a.compressed ? 0 : 1;
      const bPriority = b.compressed ? 0 : 1;
      return aPriority - bPriority;
    });

    for (const injection of sorted) {
      for (const msg of injection.messages) {
        messages.push({
          ...msg,
          timestamp: Date.now(),
          metadata: injection.compressed ? { compressed: true } : { source: 'subsystem' },
        } as Message);
      }
    }

    this.contextQueue.length = 0;
  }

  /**
   * 消费 steering 通道的所有待处理信号
   */
  consumeSteering(): SignalEntry[] {
    const entries = [...this.steeringQueue];
    this.steeringQueue.length = 0;
    return entries;
  }

  /**
   * 消费 escalate 通道的所有待处理信号
   */
  consumeEscalate(): SignalEntry[] {
    const entries = [...this.escalateQueue];
    this.escalateQueue.length = 0;
    return entries;
  }

  /**
   * 获取各队列的待处理数量（用于监控和测试）
   */
  get pendingCounts(): { context: number; steering: number; escalate: number } {
    return {
      context: this.contextQueue.length,
      steering: this.steeringQueue.length,
      escalate: this.escalateQueue.length,
    };
  }

  /**
   * 清空所有队列
   */
  clear(): void {
    this.contextQueue.length = 0;
    this.steeringQueue.length = 0;
    this.escalateQueue.length = 0;
  }

  // ── 内部方法 ──

  /**
   * 根据 signal action 推断默认通道
   */
  private inferChannels(signal: Signal): SignalChannel[] {
    switch (signal.action) {
      case 'block':
      case 'degrade':
      case 'allow':
        // Guardian 场景：结果直接体现在 act 中，同时通过 event 通知
        return ['event'];
      case 'replace':
        // 上下文替换：注入 context + event 通知
        return ['context', 'event'];
      case 'suggest':
      case 'alert':
        // 建议/警告：注入 context + event 通知
        return ['context', 'event'];
      case 'escalate':
        // 升级：走 escalate 队列 + event 通知
        return ['escalate', 'event'];
      case 'no-op':
        // 无行动：只发 event
        return ['event'];
      default:
        return ['event'];
    }
  }

  /**
   * 投递到 context 通道
   */
  private deliverToContext(subsystemId: string, signal: Signal): void {
    if (signal.action === 'replace') {
      this.contextQueue.push({
        subsystemId,
        messages: [{ role: 'system', content: signal.reason }],
        compressed: true,
      });
    } else {
      // suggest / alert → 注入为系统消息
      this.contextQueue.push({
        subsystemId,
        messages: [{ role: 'system', content: `[${signal.action}] ${signal.reason}` }],
      });
    }
  }

  /**
   * 投递到 event 通道
   */
  private deliverToEvent(subsystemId: string, signal: Signal): void {
    this.events.emit({
      type: `subsystem.signal.${signal.action}`,
      timestamp: Date.now(),
      data: {
        subsystemId,
        action: signal.action,
        reason: signal.reason,
        confidence: signal.confidence,
        ...signal.data,
      },
    });
  }
}
