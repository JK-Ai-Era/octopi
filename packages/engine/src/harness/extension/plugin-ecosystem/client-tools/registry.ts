/**
 * ClientToolRegistry — 会话内客户端能力注册表
 *
 * - 多个 client 可注册同名 tool；默认路由「最近活跃端」
 * - 敏感 device：候选必须唯一（或后续由 Host 显式钉 instance），否则拒绝
 * - 某名字最后一家下线时，由调用方 unregister 对应 RegisteredTool
 */

import type {
  ClientToolDescriptor,
  ClientToolName,
  ClientToolProvider,
} from './types.js';

export type ClientToolRouteDecision =
  | { ok: true; clientInstanceId: string; descriptor: ClientToolDescriptor }
  | { ok: false; reason: 'unsupported' | 'ambiguous' | 'client_unavailable'; hint?: string };

export class ClientToolRegistry {
  /** sessionId → clientInstanceId → provider */
  private bySession = new Map<string, Map<string, ClientToolProvider>>();
  /** 在线性：超过该时长未心跳的 provider 视为离线（不进 tool 面、不可路由） */
  private readonly liveTtlMs: number;
  /** 可注入时钟（测试用）；默认 Date.now */
  private readonly clock: () => number;

  constructor(options?: { liveTtlMs?: number; clock?: () => number }) {
    this.liveTtlMs = options?.liveTtlMs ?? 90_000;
    this.clock = options?.clock ?? Date.now;
  }

  private at(now?: number): number {
    return now ?? this.clock();
  }

  private isLive(p: ClientToolProvider, now: number): boolean {
    return now - p.lastActiveAt <= this.liveTtlMs;
  }

  /**
   * 剔除超时未心跳的 provider（在线性打底）
   *
   * @returns 各 session 上消失的 tool 名（可能重复）
   */
  expireStaleProviders(now?: number): Array<{ sessionId: string; removedNames: ClientToolName[] }> {
    const ts = this.at(now);
    const out: Array<{ sessionId: string; removedNames: ClientToolName[] }> = [];
    for (const [sessionId, sessionMap] of [...this.bySession.entries()]) {
      const before = this.collectNames(sessionMap);
      for (const [clientId, p] of [...sessionMap.entries()]) {
        if (!this.isLive(p, ts)) sessionMap.delete(clientId);
      }
      // 不删除空 sessionMap：注册过程中 expire 可能清空后 set，删 Map 会丢掉本次写入
      const after = this.collectNames(sessionMap);
      const removedNames = before.filter((n) => !after.includes(n));
      if (removedNames.length > 0) out.push({ sessionId, removedNames });
    }
    return out;
  }

  private collectNames(sessionMap: Map<string, ClientToolProvider>): ClientToolName[] {
    const names = new Set<string>();
    for (const p of sessionMap.values()) {
      for (const d of p.descriptors) names.add(d.name);
    }
    return Array.from(names);
  }

  /**
   * 注册/更新某客户端在某会话上的能力（能力快照）
   *
   * @returns 本次新出现的 tool 名（调用方据此 register 进 ToolBus）
   */
  registerClientProviders(input: {
    sessionId: string;
    clientInstanceId: string;
    platform?: string;
    principalId?: string;
    descriptors: ClientToolDescriptor[];
    now?: number;
  }): { addedNames: ClientToolName[]; allNames: ClientToolName[] } {
    const now = this.at(input.now);
    this.expireStaleProviders(now);
    const sessionMap = this.bySession.get(input.sessionId) ?? new Map();
    this.bySession.set(input.sessionId, sessionMap);

    const before = this.sessionToolNames(input.sessionId, now);
    sessionMap.set(input.clientInstanceId, {
      clientInstanceId: input.clientInstanceId,
      sessionId: input.sessionId,
      platform: input.platform,
      principalId: input.principalId,
      lastActiveAt: now,
      descriptors: input.descriptors,
    });
    const after = this.sessionToolNames(input.sessionId, now);
    const addedNames = after.filter((n) => !before.includes(n));
    return { addedNames, allNames: after };
  }

  /**
   * 客户端下线/撤回能力
   *
   * @returns 会话中已无任何 provider 的 tool 名（调用方 unregister）
   */
  unregisterClientProviders(input: {
    sessionId: string;
    clientInstanceId: string;
  }): { removedNames: ClientToolName[] } {
    const sessionMap = this.bySession.get(input.sessionId);
    if (!sessionMap) return { removedNames: [] };
    const before = this.sessionToolNames(input.sessionId);
    sessionMap.delete(input.clientInstanceId);
    const after = this.sessionToolNames(input.sessionId);
    return { removedNames: before.filter((n) => !after.includes(n)) };
  }

  /** 心跳 / 任意客户端活动：续期在线 */
  touchClient(sessionId: string, clientInstanceId: string, now?: number): boolean {
    const p = this.bySession.get(sessionId)?.get(clientInstanceId);
    if (!p) return false;
    p.lastActiveAt = this.at(now);
    return true;
  }

  /** 会话内仍在线且声明的 tool 名 */
  sessionToolNames(sessionId: string, now?: number): ClientToolName[] {
    const ts = this.at(now);
    this.expireStaleProviders(ts);
    const names = new Set<string>();
    for (const p of this.bySession.get(sessionId)?.values() ?? []) {
      if (!this.isLive(p, ts)) continue;
      for (const d of p.descriptors) names.add(d.name);
    }
    return Array.from(names).sort();
  }

  /** 会话内在线 provider */
  listProviders(sessionId: string, now?: number): ClientToolProvider[] {
    const ts = this.at(now);
    this.expireStaleProviders(ts);
    return Array.from(this.bySession.get(sessionId)?.values() ?? []).filter((p) =>
      this.isLive(p, ts),
    );
  }

  /** 会话内是否有 live provider（tool 面过滤用） */
  hasLiveProvider(sessionId: string, name: ClientToolName, now?: number): boolean {
    const ts = this.at(now);
    this.expireStaleProviders(ts);
    for (const p of this.bySession.get(sessionId)?.values() ?? []) {
      if (!this.isLive(p, ts)) continue;
      if (p.descriptors.some((d) => d.name === name)) return true;
    }
    return false;
  }

  /** 全局是否仍有任一 live provider（决定能否 uninstall） */
  hasAnyProvider(name: ClientToolName, now?: number): boolean {
    const ts = this.at(now);
    this.expireStaleProviders(ts);
    for (const sessionMap of this.bySession.values()) {
      for (const p of sessionMap.values()) {
        if (!this.isLive(p, ts)) continue;
        if (p.descriptors.some((d) => d.name === name)) return true;
      }
    }
    return false;
  }

  getDescriptor(
    sessionId: string,
    name: ClientToolName,
    now?: number,
  ): ClientToolDescriptor | undefined {
    for (const p of this.listProviders(sessionId, now)) {
      const d = p.descriptors.find((x) => x.name === name);
      if (d) return d;
    }
    return undefined;
  }

  /**
   * 解析执行端。仅 live provider；默认最近活跃；敏感 device 要求候选唯一。
   */
  resolveTarget(sessionId: string, name: ClientToolName, now?: number): ClientToolRouteDecision {
    const ts = this.at(now);
    const candidates: Array<{ provider: ClientToolProvider; descriptor: ClientToolDescriptor }> = [];
    for (const p of this.listProviders(sessionId, ts)) {
      const d = p.descriptors.find((x) => x.name === name);
      if (d) candidates.push({ provider: p, descriptor: d });
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: 'unsupported',
        hint: `no live client in session provides tool "${name}"`,
      };
    }

    const sensitivity = candidates.some((c) => c.descriptor.device?.sensitivity === 'sensitive')
      ? 'sensitive'
      : candidates.some((c) => c.descriptor.device?.sensitivity === 'personal')
        ? 'personal'
        : 'public';

    if (sensitivity === 'sensitive' && candidates.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        hint:
          `tool "${name}" is sensitivity=sensitive and ${candidates.length} clients provide it; ` +
          'pin targetClientInstanceId or disconnect extras',
      };
    }

    candidates.sort((a, b) => b.provider.lastActiveAt - a.provider.lastActiveAt);
    const winner = candidates[0]!;
    return {
      ok: true,
      clientInstanceId: winner.provider.clientInstanceId,
      descriptor: winner.descriptor,
    };
  }
}
