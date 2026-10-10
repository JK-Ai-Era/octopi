/**
 * ClientStreamTransport — Host 侧 source/sink 采样通道
 *
 * LLM 不可见：不注册 stream_read/write/close。域工具封装生命周期，
 * 样本经事件回调给 UI/插件；大字节仍走 asset。
 */

import type { RegisteredTool, ToolExecutionContext } from '@octopi-agent/core/types/tools.js';
import type {
  ClientToolCallId,
  ClientToolDescriptor,
  ClientToolName,
} from './types.js';
import { requireDevicePurpose, validateClientToolArgs } from './invoke.js';

export type ClientStreamDirection = 'source' | 'sink';

export interface ClientStreamChannel {
  streamId: string;
  /** source: client→host 采集；sink: host→client 播放/呈现 */
  direction: ClientStreamDirection;
  /** 样本提示：'audio/16k' | 'geo/1hz' | … */
  sampleHint?: string;
  owner: {
    sessionId: string;
    clientInstanceId: string;
    toolCallId?: ClientToolCallId;
    toolName?: ClientToolName;
  };
  status: 'open' | 'closed';
  openedAt: number;
  closedAt?: number;
  maxDurationMs?: number;
}

export interface ClientStreamSampleInput {
  data: unknown;
}

export type ClientStreamEventType =
  | 'client_stream.opened'
  | 'client_stream.sample'
  | 'client_stream.closed';

export interface ClientStreamEvent {
  type: ClientStreamEventType;
  sessionId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface ClientStreamTransportDeps {
  emitEvent: (event: ClientStreamEvent) => void;
  /** UI 样本最小间隔（ms）；同窗多条合并为批 */
  throttleMs?: number;
  /** 每批最大样本数 */
  maxBatch?: number;
  /** 默认通道 TTL */
  defaultMaxDurationMs?: number;
  makeStreamId?: () => string;
  now?: () => number;
}

export interface OpenStreamInput {
  direction: ClientStreamDirection;
  sessionId: string;
  clientInstanceId: string;
  toolCallId?: ClientToolCallId;
  toolName?: ClientToolName;
  sampleHint?: string;
  maxDurationMs?: number;
}

interface InternalChannel {
  channel: ClientStreamChannel;
  pending: Array<{ data: unknown; at: number }>;
  ttlTimer?: ReturnType<typeof setTimeout>;
  sampleTimer?: ReturnType<typeof setTimeout>;
}

function defaultStreamId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 会话流通道注册表 + 节流广播。
 * 通道操作仅 Host/插件调用，不进入 LLM tool 面。
 */
export class ClientStreamTransport {
  private readonly deps: ClientStreamTransportDeps;
  private readonly channels = new Map<string, InternalChannel>();
  private readonly throttleMs: number;
  private readonly maxBatch: number;
  private readonly defaultMaxDurationMs: number;
  private readonly makeStreamId: () => string;
  private readonly now: () => number;

  constructor(deps: ClientStreamTransportDeps) {
    this.deps = deps;
    this.throttleMs = deps.throttleMs ?? 200;
    this.maxBatch = deps.maxBatch ?? 32;
    this.defaultMaxDurationMs = deps.defaultMaxDurationMs ?? 300_000;
    this.makeStreamId = deps.makeStreamId ?? defaultStreamId;
    this.now = deps.now ?? Date.now;
  }

  open(input: OpenStreamInput): ClientStreamChannel {
    const at = this.now();
    const maxDurationMs = input.maxDurationMs ?? this.defaultMaxDurationMs;
    const channel: ClientStreamChannel = {
      streamId: this.makeStreamId(),
      direction: input.direction,
      sampleHint: input.sampleHint,
      owner: {
        sessionId: input.sessionId,
        clientInstanceId: input.clientInstanceId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      },
      status: 'open',
      openedAt: at,
      maxDurationMs,
    };
    const internal: InternalChannel = { channel, pending: [] };
    this.channels.set(channel.streamId, internal);
    if (maxDurationMs > 0) {
      internal.ttlTimer = setTimeout(() => {
        this.close(channel.streamId, 'ttl');
      }, maxDurationMs);
    }
    this.deps.emitEvent({
      type: 'client_stream.opened',
      sessionId: input.sessionId,
      timestamp: at,
      data: { channel: { ...channel } },
    });
    return { ...channel, owner: { ...channel.owner } };
  }

  /**
   * 写入样本（source：client 上报；sink：host 下发前镜像给 UI）。
   * 超过 maxBatch 的可丢样本在本窗丢弃。
   */
  writeSamples(streamId: string, samples: ClientStreamSampleInput[]): boolean {
    const entry = this.channels.get(streamId);
    if (!entry || entry.channel.status !== 'open') return false;
    const at = this.now();
    let dropped = 0;
    for (const s of samples) {
      if (entry.pending.length >= this.maxBatch) {
        dropped += 1;
        continue;
      }
      entry.pending.push({ data: s.data, at });
    }
    if (dropped > 0) {
      this.deps.emitEvent({
        type: 'client_stream.sample',
        sessionId: entry.channel.owner.sessionId,
        timestamp: at,
        data: { streamId, samples: [], dropped },
      });
    }
    this.scheduleFlush(entry);
    return true;
  }

  private scheduleFlush(entry: InternalChannel): void {
    if (entry.sampleTimer !== undefined) return;
    entry.sampleTimer = setTimeout(() => {
      entry.sampleTimer = undefined;
      this.flush(entry);
    }, this.throttleMs);
  }

  private flush(entry: InternalChannel): void {
    if (entry.pending.length === 0) return;
    const batch = entry.pending.splice(0, this.maxBatch);
    this.deps.emitEvent({
      type: 'client_stream.sample',
      sessionId: entry.channel.owner.sessionId,
      timestamp: this.now(),
      data: {
        streamId: entry.channel.streamId,
        samples: batch.map((s) => ({ data: s.data, at: s.at })),
        dropped: 0,
      },
    });
    if (entry.pending.length > 0) this.scheduleFlush(entry);
  }

  close(streamId: string, reason = 'closed'): ClientStreamChannel | null {
    const entry = this.channels.get(streamId);
    if (!entry) return null;
    if (entry.channel.status === 'closed') {
      return { ...entry.channel, owner: { ...entry.channel.owner } };
    }
    this.flush(entry);
    entry.channel.status = 'closed';
    entry.channel.closedAt = this.now();
    if (entry.ttlTimer !== undefined) {
      clearTimeout(entry.ttlTimer);
      entry.ttlTimer = undefined;
    }
    if (entry.sampleTimer !== undefined) {
      clearTimeout(entry.sampleTimer);
      entry.sampleTimer = undefined;
    }
    this.channels.delete(streamId);
    this.deps.emitEvent({
      type: 'client_stream.closed',
      sessionId: entry.channel.owner.sessionId,
      timestamp: entry.channel.closedAt,
      data: { channel: { ...entry.channel }, reason },
    });
    return { ...entry.channel, owner: { ...entry.channel.owner } };
  }

  /** Run abort / session 结束 / client 下线时联动关闭 */
  closeWhere(match: (channel: ClientStreamChannel) => boolean, reason = 'closed'): number {
    let n = 0;
    for (const entry of [...this.channels.values()]) {
      if (match({ ...entry.channel, owner: { ...entry.channel.owner } })) {
        this.close(entry.channel.streamId, reason);
        n += 1;
      }
    }
    return n;
  }

  get(streamId: string): ClientStreamChannel | undefined {
    const entry = this.channels.get(streamId);
    return entry ? { ...entry.channel, owner: { ...entry.channel.owner } } : undefined;
  }

  list(sessionId?: string): ClientStreamChannel[] {
    return [...this.channels.values()]
      .filter((e) => !sessionId || e.channel.owner.sessionId === sessionId)
      .map((e) => ({ ...e.channel, owner: { ...e.channel.owner } }));
  }

  /** 同 session 内某域工具仍打开的通道（复用，避免每次 invoke 新开） */
  findOpenByTool(
    sessionId: string,
    toolName: string,
    clientInstanceId?: string,
  ): ClientStreamChannel | undefined {
    for (const entry of this.channels.values()) {
      const c = entry.channel;
      if (c.status !== 'open') continue;
      if (c.owner.sessionId !== sessionId) continue;
      if (c.owner.toolName !== toolName) continue;
      if (clientInstanceId && c.owner.clientInstanceId !== clientInstanceId) continue;
      return { ...c, owner: { ...c.owner } };
    }
    return undefined;
  }
}

function samplesFromArgs(args: Record<string, unknown>): Array<{ data: unknown }> {
  const raw = args.samples;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((data) => ({ data }));
}

function requiresDeviceConsent(descriptor: ClientToolDescriptor): boolean {
  return (
    descriptor.interaction === 'device' &&
    (descriptor.device?.consent ?? 'prompt') !== 'none'
  );
}

/** 通道属主校验：禁止跨 session 读写/关闭（§15.1） */
function assertSameSession(
  channel: ClientStreamChannel | undefined,
  sessionId: string | undefined,
): string | null {
  if (!sessionId) return 'sessionId is required';
  if (!channel) return 'stream not found';
  if (channel.status !== 'open') return `stream "${channel.streamId}" is not open`;
  if (channel.owner.sessionId !== sessionId) {
    return `stream "${channel.streamId}" belongs to another session`;
  }
  return null;
}

export interface StreamDomainToolDeps {
  transport: ClientStreamTransport;
  /** 一次调用创建一条通道（可带业务参数与目标端） */
  openChannel: (input: {
    args: Record<string, unknown>;
    context: ToolExecutionContext;
  }) => Omit<OpenStreamInput, 'direction' | 'toolName'>;
  /** 结果 value 句柄字段名：watchId / playId … */
  handleKey?: string;
  /** 通道打开后立即写入（如 sink 域工具的首批样本） */
  onOpen?: (
    channel: ClientStreamChannel,
    args: Record<string, unknown>,
    transport: ClientStreamTransport,
  ) => void;
  /**
   * 复用策略（sink 续写 / source 去重）：
   * - `none`：每次新开（默认 source）
   * - `append`：命中 playId 或同名 open 通道则续写样本，不新开
   * - `sticky`：同名 open 通道则直接返回句柄，不新开
   */
  reuse?: 'none' | 'append' | 'sticky';
}

/**
 * source 域工具样板（location_watch 类）：返回 value 域句柄，样本走 Host 通道。
 * 不是通用 stream_read；生命周期由配对 stop 工具或 TTL 收口。
 * 默认 sticky：同 session 已有 open 通道则复用，避免重复开流。
 */
export function createSourceStreamTool(
  descriptor: ClientToolDescriptor,
  deps: StreamDomainToolDeps,
): RegisteredTool {
  return buildStreamTool(descriptor, { reuse: 'sticky', ...deps }, 'source');
}

/**
 * sink 域工具样板（play 类）：打开 host→client 下行通道，返回 value 域句柄。
 * 默认 append：同 session / playId 续写样本，持续下发不新开通道。
 */
export function createSinkStreamTool(
  descriptor: ClientToolDescriptor,
  deps: StreamDomainToolDeps,
): RegisteredTool {
  return buildStreamTool(descriptor, { reuse: 'append', ...deps }, 'sink');
}

function buildStreamTool(
  descriptor: ClientToolDescriptor,
  deps: StreamDomainToolDeps,
  direction: ClientStreamDirection,
): RegisteredTool {
  const handleKey = deps.handleKey ?? (direction === 'source' ? 'watchId' : 'playId');
  const reuse = deps.reuse ?? 'none';
  return {
    definition: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
      version: descriptor.version,
      requiresConfirmation: requiresDeviceConsent(descriptor),
    },
    handler: async (args, context) => {
      const argError = validateClientToolArgs(descriptor.parameters ?? {}, args);
      if (argError) return { error: 'invalid_arguments', hint: argError };
      const purposeError = requireDevicePurpose(descriptor, args);
      if (purposeError) return { error: 'invalid_arguments', hint: purposeError };
      const sessionId = context?.sessionId;

      // 1) 显式句柄：续写 / 确认已有通道（校验属主）
      const explicit = args[handleKey] ?? args.playId ?? args.watchId;
      if (reuse !== 'none' && typeof explicit === 'string' && explicit) {
        const existing = deps.transport.get(explicit);
        if (existing && existing.status === 'open') {
          const denied = assertSameSession(existing, sessionId);
          if (denied) return { error: 'permission_denied', hint: denied };
          const extra = samplesFromArgs(args);
          if (extra.length > 0) deps.transport.writeSamples(existing.streamId, extra);
          return {
            kind: 'value',
            data: {
              [handleKey]: existing.streamId,
              status: existing.status,
              direction: existing.direction,
              reused: true,
              sampleHint: existing.sampleHint,
              maxDurationMs: existing.maxDurationMs,
            },
          };
        }
      }

      // 2) 同名 open 通道：sticky 返回 / append 续写
      if (reuse !== 'none') {
        const found = sessionId
          ? deps.transport.findOpenByTool(sessionId, descriptor.name)
          : undefined;
        if (found) {
          const denied = assertSameSession(found, sessionId);
          if (denied) return { error: 'permission_denied', hint: denied };
          const extra = samplesFromArgs(args);
          if (reuse === 'append' && extra.length > 0) {
            deps.transport.writeSamples(found.streamId, extra);
          }
          return {
            kind: 'value',
            data: {
              [handleKey]: found.streamId,
              status: found.status,
              direction: found.direction,
              reused: true,
              sampleHint: found.sampleHint,
              maxDurationMs: found.maxDurationMs,
            },
          };
        }
      }

      // 3) 新开通道
      let opened: Omit<OpenStreamInput, 'direction' | 'toolName'>;
      try {
        opened = deps.openChannel({ args, context });
      } catch (err) {
        return {
          error: 'internal',
          hint: err instanceof Error ? err.message : String(err),
        };
      }
      const channel = deps.transport.open({
        ...opened,
        direction,
        toolName: descriptor.name,
      });
      try {
        if (samplesFromArgs(args).length > 0) {
          deps.transport.writeSamples(
            channel.streamId,
            samplesFromArgs(args),
          );
        }
        deps.onOpen?.(channel, args, deps.transport);
      } catch {
        // 附加样本失败不回滚已打开通道；工具结果仍返回句柄
      }
      return {
        kind: 'value',
        data: {
          [handleKey]: channel.streamId,
          status: channel.status,
          direction: channel.direction,
          reused: false,
          sampleHint: channel.sampleHint,
          maxDurationMs: channel.maxDurationMs,
        },
      };
    },
  };
}

export interface StreamStopToolDeps {
  transport: ClientStreamTransport;
  /** 从 args 取句柄字段，默认 stop 用 watchId/playId */
  handleKey?: string;
}

/**
 * 域工具 stop 样板：按域句柄关通道。不是通用 stream_close。
 */
export function createStreamStopTool(
  descriptor: ClientToolDescriptor,
  deps: StreamStopToolDeps,
): RegisteredTool {
  const handleKey = deps.handleKey ?? 'watchId';
  return {
    definition: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
      version: descriptor.version,
    },
    handler: async (args, context) => {
      const argError = validateClientToolArgs(descriptor.parameters ?? {}, args);
      if (argError) return { error: 'invalid_arguments', hint: argError };
      const raw = args[handleKey] ?? args.playId ?? args.watchId;
      const streamId = typeof raw === 'string' ? raw : '';
      if (!streamId) {
        return { error: 'invalid_arguments', hint: `missing ${handleKey}` };
      }
      const existing = deps.transport.get(streamId);
      const denied = assertSameSession(existing, context?.sessionId);
      if (denied) {
        return {
          error: denied === 'stream not found' ? 'unsupported' : 'permission_denied',
          hint: denied,
        };
      }
      const closed = deps.transport.close(streamId, 'stop');
      if (!closed) {
        return {
          error: 'unsupported',
          hint: `no open stream "${streamId}"`,
        };
      }
      return {
        kind: 'value',
        data: {
          [handleKey]: closed.streamId,
          status: closed.status,
          closedAt: closed.closedAt,
        },
      };
    },
  };
}
