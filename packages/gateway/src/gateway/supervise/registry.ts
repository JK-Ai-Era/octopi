/**
 * supervise/registry — InstanceRegistry + RouteConfig（arch/service-topology-p0c.md §4.1）。
 *
 * 分工：InstanceRegistry 记**事实**（实际跑着什么，可重建）；RouteConfig 记**期望**
 * （fleet 应该长什么样）。RouteConfig 不落盘（Q3=A 拍板 2026-11-11）：启动时从
 * octopi.json 播种，promote/rollback/scale 是运行时 ops；gateway 重启回落 config 默认。
 *
 * @module gateway/supervise/registry
 */

/** 实例生命周期状态（P0c 不引入 candidate/active；§5.1） */
export type InstanceState = 'starting' | 'ready' | 'draining' | 'failed';

/** 实例登记记录（§5.1 数据面） */
export interface InstanceRecord {
  instanceId: string;
  version: string;
  /** 该版本构建产物根（其 run-serve-child.js 入口所在）；同版本自举时为自身 dist */
  buildRef: string;
  port: number;
  pid: number;
  state: InstanceState;
  startedAt: number;
  lastProbe?: number;
  load: { inFlightRuns: number; queued: number };
}

/** 路由期望状态（§5.1）：versionPointer / weights / replicasPerVersion */
export interface RouteConfig {
  versionPointer: string;
  weights: Map<string, number>;
  replicasPerVersion: number;
}

export namespace RouteConfig {
  /**
   * config 播种（Q3=A）：只接受部署可变的期望值；versionPointer 起点 = 当前自身版本。
   * @param options - 播种值（缺省取默认）
   * @returns 播种后的运行态 RouteConfig
   */
  export function seed(options: { versionPointer: string; replicasPerVersion?: number }): RouteConfig {
    return {
      versionPointer: options.versionPointer,
      weights: new Map([[options.versionPointer, 100]]),
      replicasPerVersion: options.replicasPerVersion ?? 1,
    };
  }
}

/**
 * InstanceRegistry — 实例事实登记（注册表可重建，非持久）。
 * 状态机：starting → ready → draining（终态前）；任何态可 → failed。
 */
export class InstanceRegistry {
  private readonly records = new Map<string, InstanceRecord>();

  /**
   * 登记/替换实例记录（重复 instanceId = 调用方 bug，fail-loud）。
   * @param record - 实例记录
   * @returns void
   */
  add(record: InstanceRecord): void {
    if (this.records.has(record.instanceId)) {
      throw new Error(`supervise: instance "${record.instanceId}" already registered`);
    }
    this.records.set(record.instanceId, record);
  }

  /**
   * 注销实例记录。
   * @param instanceId - 实例标识
   * @returns 是否存在并移除
   */
  remove(instanceId: string): boolean {
    return this.records.delete(instanceId);
  }

  /**
   * @param instanceId - 实例标识
   * @returns 实例记录（无则 undefined）
   */
  get(instanceId: string): InstanceRecord | undefined {
    return this.records.get(instanceId);
  }

  /**
   * @returns 全部实例记录快照
   */
  list(): InstanceRecord[] {
    return [...this.records.values()];
  }

  /**
   * @param state - 状态过滤
   * @returns 该状态的实例记录
   */
  listByState(state: InstanceState): InstanceRecord[] {
    return this.list().filter((r) => r.state === state);
  }

  /**
   * 迁移实例状态（非法迁移 fail-loud：failed 是终态，不可复活——回滚=起新实例）。
   * @param instanceId - 实例标识
   * @param state - 目标状态
   * @returns void
   */
  setState(instanceId: string, state: InstanceState): void {
    const record = this.records.get(instanceId);
    if (!record) {
      throw new Error(`supervise: instance "${instanceId}" not registered`);
    }
    if (record.state === 'failed' && state !== 'failed') {
      throw new Error(`supervise: instance "${instanceId}" is failed (terminal); spawn a new one`);
    }
    record.state = state;
    if (state === 'ready') record.lastProbe = Date.now();
  }

  /**
   * 回写负载计数（gateway 调度侧记账；probe 校正）。
   * @param instanceId - 实例标识
   * @param load - 负载快照
   * @returns void
   */
  setLoad(instanceId: string, load: { inFlightRuns: number; queued: number }): void {
    const record = this.records.get(instanceId);
    if (!record) {
      throw new Error(`supervise: instance "${instanceId}" not registered`);
    }
    record.load = load;
  }
}
