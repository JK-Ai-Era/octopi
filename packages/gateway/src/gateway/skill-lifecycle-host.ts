/**
 * SkillLifecycle 宿主 — skill-state 数据面的懒建与 per-agent 生命周期缓存
 * （arch/skill-creation-design.md §6；E8 one source of truth）
 *
 * gateway 与 run-serve-child 共用本宿主：两处各自手写装配会在 dbPath /
 * 缓存语义上漂移，收敛为一份实现。sqlite WAL 多进程安全，两进程共享
 * 同一个 skill-state/skills.db 即可（各自持连接）。
 */

import { getOctopiHome } from '@octopi-agent/engine/paths.js';
import { SkillStateDatabase } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/registry.js';
import { SkillLifecycle } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/skills/lifecycle.js';

export interface SkillLifecycleHost {
  /**
   * 取 agent 的技能生命周期服务。
   *
   * @param agentId - agent id
   * @returns 生命周期服务；skill-state 打开失败时 undefined（无闸门降级，调用方告警）
   */
  get(agentId: string): Promise<SkillLifecycle | undefined>;
}

/**
 * 创建 SkillLifecycle 宿主（进程级；共享 db 懒建单例）。
 *
 * @param options.warn - 降级告警出口（缺省 console.warn）
 * @returns 宿主
 */
export function createSkillLifecycleHost(options?: {
  warn?: (message: string) => void;
}): SkillLifecycleHost {
  const warn = options?.warn ?? ((m: string) => console.warn(m));
  let dbPromise: Promise<SkillStateDatabase> | undefined;
  const cache = new Map<string, SkillLifecycle>();

  return {
    async get(agentId: string): Promise<SkillLifecycle | undefined> {
      const cached = cache.get(agentId);
      if (cached) return cached;
      try {
        const octopiHome = getOctopiHome();
        dbPromise ??= SkillStateDatabase.create({
          dbPath: SkillStateDatabase.resolveDbPath(octopiHome),
        });
        const lifecycle = new SkillLifecycle({ db: await dbPromise, octopiHome, agentId });
        cache.set(agentId, lifecycle);
        return lifecycle;
      } catch (err) {
        // skill-state 不可用 = 无闸门/无提交面（降级显式告警，不静默）
        warn(
          `skill lifecycle unavailable for agent "${agentId}": ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    },
  };
}
