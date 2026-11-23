/**
 * 「上次打开的会话」缓存 — 刷新页面或切换 agent 时回到上次的会话，而不是跳回最近交互的那个。
 *
 * 存储形状：`{ [agentId]: { sessionId, at } }` — 每个 agent 一个槽，`at` 单调递增。
 * 「最近一次打开的会话（不限 agent）」= `at` 最大的槽，因此刷新恢复与切 agent 恢复
 * 共用同一份真源，不需要两套记录互相同步。
 *
 * 多标签页最后写入者胜，语义上就是「最后一次点击的会话」。localStorage 不可用时
 * 静默降级为「按最近交互打开」。
 */

const KEY = 'octopi.lastSession.v2';

export interface LastSessionRecord {
  sessionId: string;
  /** 会话所属 agent：恢复时需连同 agent 选择一起还原，否则左栏过滤与当前会话对不上 */
  agentId: string;
}

interface AgentSlot {
  sessionId: string;
  /** 单调递增的打开序号（毫秒时间戳，同毫秒时取 max+1） */
  at: number;
}

type Store = Record<string, AgentSlot>;

/** 读出并清洗整张表：坏条目丢弃，不因单条损坏拖垮其它 agent 的记忆 */
function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const store: Store = {};
    for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const { sessionId, at } = value as Partial<AgentSlot>;
      if (typeof sessionId !== 'string' || sessionId === '') continue;
      store[agentId] = {
        sessionId,
        at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
      };
    }
    return store;
  } catch {
    // 存储被禁用 / JSON 损坏：当作无记录，自动打开回退到「最近交互」
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    if (Object.keys(store).length === 0) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // 存储不可用 / 配额满：放弃记忆，刷新或切 agent 时按最近交互打开，不影响当前会话
  }
}

/**
 * 读取「最近一次打开的会话」（不限 agent）。
 * @returns 记录；无记录、存储不可用或内容损坏时为 null
 */
export function readLastSession(): LastSessionRecord | null {
  let best: { agentId: string; slot: AgentSlot } | null = null;
  for (const [agentId, slot] of Object.entries(readStore())) {
    if (!best || slot.at > best.slot.at) best = { agentId, slot };
  }
  return best ? { sessionId: best.slot.sessionId, agentId: best.agentId } : null;
}

/**
 * 读取某个 agent 上次打开的会话。
 * @param agentId 目标 agent
 * @returns 记录；该 agent 没有记录时为 null
 */
export function readLastSessionForAgent(agentId: string): LastSessionRecord | null {
  if (!agentId) return null;
  const slot = readStore()[agentId];
  return slot ? { sessionId: slot.sessionId, agentId } : null;
}

/**
 * 记录一次会话打开：写入该会话所属 agent 的槽，并成为「最近一次打开的会话」。
 * @param record 会话与其所属 agent（agent 未知时传空串，仍可被刷新恢复但不会被 agent 切换命中）
 */
export function writeLastSession(record: LastSessionRecord): void {
  if (!record.sessionId) return;
  const store = readStore();
  let maxAt = 0;
  for (const slot of Object.values(store)) {
    if (slot.at > maxAt) maxAt = slot.at;
  }
  store[record.agentId] = {
    sessionId: record.sessionId,
    // 同毫秒内连续点开也要保持严格递增，否则「最近一次」会不确定
    at: Math.max(Date.now(), maxAt + 1),
  };
  writeStore(store);
}

/**
 * 会话被删除时清掉指向它的记录，避免之后尝试打开一个已不存在的会话。
 * 同一 sessionId 只可能落在一个 agent 槽里，但整表扫描可免去调用方判断归属。
 * @param sessionId 被删除的会话
 */
export function clearLastSessionIfMatches(sessionId: string): void {
  const store = readStore();
  let changed = false;
  for (const [agentId, slot] of Object.entries(store)) {
    if (slot.sessionId === sessionId) {
      delete store[agentId];
      changed = true;
    }
  }
  if (changed) writeStore(store);
}
