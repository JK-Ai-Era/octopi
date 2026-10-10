/**
 * ClientToolHost — Gateway 侧 Client Tool 运行时
 *
 * - 维护 ClientToolRegistry（会话 → 端 → 能力）
 * - 将动态 tool 装进 Gateway.tools / 已 build 的 Agent
 * - invoke：创建 ClientToolCall pending → 等 UI/设备 → outcome
 *
 * 归属：Gateway（Integration 门面）；契约来自 engine client-tools。
 */

import type {
  ClientToolCall,
  ClientToolCallId,
  ClientToolCallOutcome,
  ClientToolDescriptor,
  ClientToolName,
  ClientToolRegistry,
  ClientToolInvoker,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';
import {
  createClientTool,
  createSinkStreamTool,
  createSourceStreamTool,
  createStreamStopTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';
import type { ClientStreamTransport } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/client-tools/index.js';
import type { RegisteredTool } from '@octopi-agent/core/types/tools.js';

export interface ClientToolHostDeps {
  registry: ClientToolRegistry;
  /** 注册进 Gateway 全局 tool 面（新 build 的 agent 会带上） */
  registerGlobalTool: (tool: RegisteredTool) => void;
  /** 从全局 tool 面移除 */
  unregisterGlobalTool: (name: string) => void;
  /** 热更新已 build 的 Agent 工具列表 */
  syncAgentTools: (ops: Array<{ op: 'add'; tool: RegisteredTool } | { op: 'remove'; name: string }>) => void;
  /** 广播会话事件（client_tool.*） */
  emitSessionEvent: (sessionId: string, event: {
    type: string;
    sessionId: string;
    timestamp: number;
    data: Record<string, unknown>;
  }) => void;
  /** 终态 call 持久化到 SessionStore（可选） */
  persistCall?: (call: ClientToolCall) => void | Promise<void>;
  /** html_ui 大正文落 attachment（可选） */
  saveHtmlAsset?: (input: {
    sessionId: string;
    name: string;
    html: string;
  }) => Promise<{ assetId: string; mime: string; sizeBytes: number }>;
  /** callId 生成（可测） */
  makeCallId?: () => string;
  /** 默认 TTL */
  defaultTimeoutMs?: number;
  /** provider 在线 TTL（超过未心跳视为离线） */
  providerLiveTtlMs?: number;
  /** Host 流通道（§15.1）；client 下线/会话取消时联动 close */
  streamTransport?: ClientStreamTransport;
}

interface PendingCall {
  call: ClientToolCall;
  resolve: (outcome: ClientToolCallOutcome) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

export class ClientToolHost {
  private readonly deps: ClientToolHostDeps;
  /** 已装进 tool 面的名字 → RegisteredTool */
  private installed = new Map<ClientToolName, RegisteredTool>();
  private calls = new Map<ClientToolCallId, PendingCall>();
  /** 终态 call 短期保留（内存；权威在 persistCall） */
  private recentTerminal: ClientToolCall[] = [];
  private static readonly RECENT_TERMINAL_MAX = 100;

  constructor(deps: ClientToolHostDeps) {
    this.deps = deps;
  }

  /** 是否为本 Host 管理的 Client Tool（server tool 恒可见） */
  isClientTool(name: string): boolean {
    return this.installed.has(name);
  }

  /** 会话 tool 面过滤：Client Tool 仅在本 session 有 live provider 时可见 */
  createVisibilityFilter(): (sessionId: string, toolName: string) => boolean {
    return (sessionId, toolName) => {
      if (!this.installed.has(toolName)) return true;
      return this.deps.registry.hasLiveProvider(sessionId, toolName);
    };
  }

  /** 心跳续期；可顺带踢掉过期 provider */
  heartbeat(input: {
    sessionId: string;
    clientInstanceId: string;
    now?: number;
  }): { alive: boolean } {
    const now = input.now ?? Date.now();
    this.reapStale(now);
    const alive = this.deps.registry.touchClient(input.sessionId, input.clientInstanceId, now);
    return { alive };
  }

  /** 剔除超时 provider 并卸下全局 tool 面上已无 live 提供者的名字 */
  private reapStale(now = Date.now()): void {
    const stale = this.deps.registry.expireStaleProviders(now);
    if (stale.length === 0) return;
    const ops: Array<{ op: 'remove'; name: string }> = [];
    const globallyRemoved = new Set<string>();
    for (const entry of stale) {
      for (const name of entry.removedNames) {
        if (!this.deps.registry.hasAnyProvider(name) && this.uninstallTool(name)) {
          ops.push({ op: 'remove', name });
          globallyRemoved.add(name);
        }
      }
      if (entry.removedNames.length > 0) {
        this.deps.emitSessionEvent(entry.sessionId, {
          type: 'client_tools.changed',
          sessionId: entry.sessionId,
          timestamp: now,
          data: {
            reason: 'stale',
            toolNames: this.deps.registry.sessionToolNames(entry.sessionId, now),
            removedNames: entry.removedNames,
          },
        });
      }
    }
    if (ops.length > 0) this.deps.syncAgentTools(ops);
  }

  /**
   * 客户端上报能力。新 tool 名会进入 tool 面。
   */
  registerClientTools(input: {
    sessionId: string;
    clientInstanceId: string;
    platform?: string;
    principalId?: string;
    descriptors: ClientToolDescriptor[];
    now?: number;
  }): { toolNames: string[] } {
    const now = input.now ?? Date.now();
    this.reapStale(now);
    const { addedNames, allNames } = this.deps.registry.registerClientProviders({ ...input, now });

    const ops: Array<{ op: 'add'; tool: RegisteredTool } | { op: 'remove'; name: string }> = [];
    for (const name of addedNames) {
      const descriptor = this.deps.registry.getDescriptor(input.sessionId, name);
      if (!descriptor) continue;
      const tool = this.installTool(descriptor);
      ops.push({ op: 'add', tool });
    }
    if (ops.length > 0) this.deps.syncAgentTools(ops);

    // 仅能力面增减时广播（§15.5）
    if (addedNames.length > 0) {
      this.deps.emitSessionEvent(input.sessionId, {
        type: 'client_tools.changed',
        sessionId: input.sessionId,
        timestamp: Date.now(),
        data: {
          clientInstanceId: input.clientInstanceId,
          toolNames: allNames,
          addedNames,
          removedNames: [],
        },
      });
    }

    return { toolNames: allNames };
  }

  /**
   * 客户端下线。无 provider 的 tool 名从 tool 面移除。
   */
  unregisterClientTools(input: {
    sessionId: string;
    clientInstanceId: string;
  }): { removedNames: string[] } {
    this.reapStale();
    const { removedNames } = this.deps.registry.unregisterClientProviders(input);
    const ops: Array<{ op: 'remove'; name: string }> = [];
    const globallyRemoved: string[] = [];
    for (const name of removedNames) {
      // 仅当全局（所有 session）都没有 provider 时才从 tool 面卸下
      if (!this.deps.registry.hasAnyProvider(name) && this.uninstallTool(name)) {
        ops.push({ op: 'remove', name });
        globallyRemoved.push(name);
      }
    }
    if (ops.length > 0) this.deps.syncAgentTools(ops);

    if (removedNames.length > 0) {
      this.deps.emitSessionEvent(input.sessionId, {
        type: 'client_tools.changed',
        sessionId: input.sessionId,
        timestamp: Date.now(),
        data: {
          clientInstanceId: input.clientInstanceId,
          toolNames: this.deps.registry.sessionToolNames(input.sessionId),
          addedNames: [],
          removedNames,
        },
      });
    }

    // 取消或换端该端未完成 call（§15.3：仅非敏感且未钉端可换端）
    for (const [id, pending] of [...this.calls.entries()]) {
      if (
        pending.call.sessionId !== input.sessionId ||
        pending.call.targetClientInstanceId !== input.clientInstanceId ||
        pending.call.state !== 'pending'
      ) {
        continue;
      }
      const sensitivity = pending.call.sensitivity ?? 'public';
      const pinned = pending.call.pinnedClient === true;
      // 本次调用为 sensitive / 钉端 → 不换端（不看 alt 自报的 descriptor）
      const next = pinned || sensitivity === 'sensitive'
        ? ({ ok: false as const })
        : this.deps.registry.resolveTarget(pending.call.sessionId, pending.call.name);
      const altOk = next.ok && next.clientInstanceId !== input.clientInstanceId;
      if (altOk && next.ok) {
        // 仍拒绝换到另一台敏感设备（多端 descriptor 可不一致）
        const altSensitive = next.descriptor.device?.sensitivity === 'sensitive';
        if (!altSensitive) {
          pending.call.targetClientInstanceId = next.clientInstanceId;
          this.deps.emitSessionEvent(pending.call.sessionId, {
            type: 'client_tool.pending',
            sessionId: pending.call.sessionId,
            timestamp: Date.now(),
            data: { call: publicCall(pending.call), reason: 'failover' },
          });
          continue;
        }
      }
      this.finishCall(id, {
        status: 'error',
        reason: 'client_unavailable',
        hint:
          sensitivity === 'sensitive' || pinned
            ? 'sensitive or pinned client tool target left; not failing over'
            : 'client unregistered while tool was pending',
      });
    }

    this.deps.streamTransport?.closeWhere(
      (c) =>
        c.owner.sessionId === input.sessionId &&
        c.owner.clientInstanceId === input.clientInstanceId,
      'client_unavailable',
    );

    return { removedNames: globallyRemoved };
  }

  listSessionCalls(sessionId: string): ClientToolCall[] {
    return Array.from(this.calls.values())
      .map((p) => p.call)
      .filter((c) => c.sessionId === sessionId);
  }

  /** 已终态但仍在近期窗口内的 call（UI 对账 / 回放） */
  listRecentTerminalCalls(sessionId: string): ClientToolCall[] {
    return this.recentTerminal
      .filter((c) => c.sessionId === sessionId)
      .map((c) => c);
  }

  getCall(callId: ClientToolCallId): ClientToolCall | undefined {
    return this.calls.get(callId)?.call ?? this.recentTerminal.find((c) => c.id === callId);
  }

  listSessionTools(sessionId: string): Array<{ name: string; description: string; interaction?: string }> {
    const byName = new Map<string, { name: string; description: string; interaction?: string }>();
    for (const p of this.deps.registry.listProviders(sessionId)) {
      for (const d of p.descriptors) {
        if (!byName.has(d.name)) {
          byName.set(d.name, { name: d.name, description: d.description, interaction: d.interaction });
        }
      }
    }
    return Array.from(byName.values());
  }

  /**
   * UI/设备完成 call。仅 pending 可 resolve。
   */
  resolveCall(
    callId: ClientToolCallId,
    outcome: ClientToolCallOutcome,
    completedByPrincipalId?: string,
  ): ClientToolCall | null {
    const pending = this.calls.get(callId);
    if (!pending || pending.call.state !== 'pending') return null;
    if (completedByPrincipalId) {
      pending.call.completedByPrincipalId = completedByPrincipalId;
    }
    this.finishCall(callId, outcome);
    return pending.call;
  }

  /** 会话取消：pending call 一律 cancelled */
  cancelSessionCalls(sessionId: string, reason = 'session cancelled'): void {
    for (const [id, pending] of this.calls) {
      if (pending.call.sessionId !== sessionId || pending.call.state !== 'pending') continue;
      this.finishCall(id, { status: 'error', reason: 'cancelled', hint: reason });
    }
    this.deps.streamTransport?.closeWhere((c) => c.owner.sessionId === sessionId, 'cancelled');
  }

  /**
   * 供 createClientTool 使用的 invoker。
   */
  createInvoker(): ClientToolInvoker {
    return async (request, context) => {
      return this.invoke({
        name: request.name,
        args: request.args,
        sessionId: request.sessionId,
        agentId: request.agentId,
        callId: request.callId,
        ttlAt: request.ttlAt,
        runId: request.runId,
        abortSignal: request.abortSignal ?? context?.abortSignal,
      });
    };
  }

  private async invoke(input: {
    name: ClientToolName;
    args: Record<string, unknown>;
    sessionId: string;
    agentId: string;
    callId: ClientToolCallId;
    ttlAt: number;
    runId?: string;
    abortSignal?: AbortSignal;
  }): Promise<ClientToolCallOutcome> {
    this.reapStale();
    const route = this.deps.registry.resolveTarget(input.sessionId, input.name);
    if (!route.ok) {
      return {
        status: 'error',
        reason: route.reason === 'ambiguous' ? 'unsupported' : route.reason,
        hint: route.hint,
      };
    }

    const call: ClientToolCall = {
      id: input.callId,
      name: input.name,
      sessionId: input.sessionId,
      runId: input.runId,
      agentId: input.agentId,
      args: input.args,
      targetClientInstanceId: route.clientInstanceId,
      state: 'pending',
      processing: route.descriptor.processing ?? 'server',
      sensitivity: route.descriptor.device?.sensitivity ?? 'public',
      pinnedClient: Boolean(route.descriptor.clientFilter?.instanceId),
      createdAt: Date.now(),
      ttlAt: input.ttlAt,
    };

    // html_ui：大正文落 attachment，call 只带 assetId（I2）
    if (call.name === 'html_ui' && this.deps.saveHtmlAsset) {
      const html = input.args.html;
      if (typeof html === 'string' && html.length > 0) {
        try {
          const asset = await this.deps.saveHtmlAsset({
            sessionId: call.sessionId,
            name: `html_ui_${call.id}.html`,
            html,
          });
          call.assetId = asset.assetId;
        } catch {
          // 落盘失败不阻塞展示；call 仍带 args.html
        }
      }
    }

    const outcome = await new Promise<ClientToolCallOutcome>((resolve, reject) => {
      if (this.calls.has(call.id)) {
        reject(new Error(`client tool call id collision: ${call.id}`));
        return;
      }
      const timeoutMs = Math.max(0, call.ttlAt - Date.now());
      const timer = setTimeout(() => {
        this.finishCall(call.id, {
          status: 'error',
          reason: 'expired',
          hint: `client tool "${input.name}" timed out`,
        });
      }, timeoutMs);

      const onAbort = () => {
        this.finishCall(call.id, {
          status: 'error',
          reason: 'cancelled',
          hint: 'run aborted while client tool was pending',
        });
      };
      if (input.abortSignal) {
        if (input.abortSignal.aborted) {
          clearTimeout(timer);
          resolve({
            status: 'error',
            reason: 'cancelled',
            hint: 'run aborted before client tool pending',
          });
          return;
        }
        input.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      this.calls.set(call.id, {
        call,
        resolve,
        reject,
        timer,
        abortSignal: input.abortSignal,
        onAbort,
      });
      this.deps.emitSessionEvent(call.sessionId, {
        type: 'client_tool.pending',
        sessionId: call.sessionId,
        timestamp: call.createdAt,
        data: { call: publicCall(call) },
      });
    });

    return outcome;
  }

  private finishCall(callId: ClientToolCallId, outcome: ClientToolCallOutcome): void {
    const pending = this.calls.get(callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.abortSignal && pending.onAbort) {
      pending.abortSignal.removeEventListener('abort', pending.onAbort);
    }
    pending.call.state = outcome.status === 'ok' ? 'succeeded' : 'failed';
    pending.call.outcome = outcome;
    if (outcome.processing) pending.call.processing = outcome.processing;
    if (
      outcome.status === 'ok' &&
      pending.call.targetClientInstanceId
    ) {
      this.deps.registry.notePreferred(
        pending.call.sessionId,
        pending.call.name,
        pending.call.targetClientInstanceId,
      );
    }
    this.calls.delete(callId);
    this.pushRecentTerminal(pending.call);

    this.deps.emitSessionEvent(pending.call.sessionId, {
      type: 'client_tool.resolved',
      sessionId: pending.call.sessionId,
      timestamp: Date.now(),
      data: { call: publicCall(pending.call) },
    });

    void Promise.resolve(this.deps.persistCall?.(pending.call)).catch(() => {
      // 持久化失败不改变工具结局；权威在内存 call 与 tool_result
    });

    pending.resolve(outcome);
  }

  private pushRecentTerminal(call: ClientToolCall): void {
    this.recentTerminal = this.recentTerminal.filter((c) => c.id !== call.id);
    this.recentTerminal.push({ ...call });
    if (this.recentTerminal.length > ClientToolHost.RECENT_TERMINAL_MAX) {
      this.recentTerminal.splice(0, this.recentTerminal.length - ClientToolHost.RECENT_TERMINAL_MAX);
    }
  }

  private installTool(descriptor: ClientToolDescriptor): RegisteredTool {
    const existing = this.installed.get(descriptor.name);
    if (existing) return existing;
    const tool = this.buildTool(descriptor);
    this.installed.set(descriptor.name, tool);
    this.deps.registerGlobalTool(tool);
    return tool;
  }

  private buildTool(descriptor: ClientToolDescriptor): RegisteredTool {
    const stream = descriptor.stream;
    if (!stream) {
      // 不传 timeoutMs：Host.invoke 的 timer 是唯一 TTL
      return createClientTool(descriptor, this.createInvoker(), {
        makeCallId: this.deps.makeCallId,
      });
    }
    const transport = this.deps.streamTransport;
    if (!transport) {
      throw new Error(
        `client tool "${descriptor.name}" declares stream but streamTransport is not configured`,
      );
    }
    const handleKey = stream.handleKey ?? (stream.direction === 'source' ? 'watchId' : 'playId');
    const openChannel = ({
      args,
      context,
    }: {
      args: Record<string, unknown>;
      context: { sessionId?: string };
    }) => {
      const sessionId = context.sessionId ?? (typeof args.sessionId === 'string' ? args.sessionId : '');
      if (!sessionId) {
        throw new Error('sessionId is required to open a client stream');
      }
      const route = this.deps.registry.resolveTarget(sessionId, descriptor.name);
      if (!route.ok) {
        throw new Error(route.hint ?? `cannot route client tool "${descriptor.name}"`);
      }
      return {
        sessionId,
        clientInstanceId: route.clientInstanceId,
        toolCallId: typeof args.toolCallId === 'string' ? args.toolCallId : undefined,
        sampleHint: typeof args.sampleHint === 'string' ? args.sampleHint : undefined,
      };
    };
    if (stream.direction === 'stop') {
      return createStreamStopTool(descriptor, { transport, handleKey });
    }
    if (stream.direction === 'source') {
      return createSourceStreamTool(descriptor, { transport, openChannel, handleKey });
    }
    return createSinkStreamTool(descriptor, { transport, openChannel, handleKey });
  }

  private uninstallTool(name: ClientToolName): boolean {
    if (!this.installed.delete(name)) return false;
    this.deps.unregisterGlobalTool(name);
    return true;
  }
}

function publicCall(call: ClientToolCall): Record<string, unknown> {
  return {
    id: call.id,
    name: call.name,
    sessionId: call.sessionId,
    runId: call.runId,
    agentId: call.agentId,
    args: call.args,
    state: call.state,
    targetClientInstanceId: call.targetClientInstanceId,
    outcome: call.outcome,
    completedByPrincipalId: call.completedByPrincipalId,
    assetId: call.assetId,
    processing: call.processing,
    createdAt: call.createdAt,
    ttlAt: call.ttlAt,
  };
}
