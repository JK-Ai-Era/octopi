/**
 * 会话 turn 定位轨的纯逻辑（渲染与跳转由 ChatWorkspace / TurnRail 执行）。
 *
 * 数据来源有两路：① user-messages 投影（全部历史 turn，含未加载区间）经
 * `ConversationAdapter.buildHistoryItems` 适配后的用户条目；② 当前已加载的
 * 会话条目（含 live 新 turn）。合并时以已加载条目为准——被截断/编辑重发改写过
 * 的历史区间不得由陈旧索引复活。
 */

import type {
  ConversationItem,
  UserConversationItem,
} from '@octopi-agent/gateway/web/conversation/types';

export interface TurnMarker {
  /** React key：优先 sourceIndex（跨分页稳定），live 条目退化为 itemId */
  key: string;
  /** session.messages 绝对下标；live 未落盘条目缺失 */
  sourceIndex?: number;
  /** 已加载时的会话条目 id（DOM 锚点 data-turn-anchor） */
  itemId: string;
  createdAt: number;
  /** 用户输入全文（tooltip 展示） */
  text: string;
  /** 目标 turn 首是否已在已加载窗口内（false = 点击需先向前分页加载） */
  loaded: boolean;
}

function userItemsOf(items: readonly ConversationItem[]): UserConversationItem[] {
  return items.filter((it): it is UserConversationItem => it.role === 'user');
}

/**
 * marker key 派生（DOM 锚点 data-turn-anchor 与此同源）：
 * 优先 sourceIndex（跨分页稳定），live 未落盘条目退化为 itemId。
 */
export function markerKeyOf(u: Pick<UserConversationItem, 'id' | 'sourceIndex'>): string {
  return typeof u.sourceIndex === 'number' ? `idx-${u.sourceIndex}` : `id-${u.id}`;
}

/** user-messages 投影（适配后的会话条目）→ 未加载区间的历史 turn marker */
export function historyTurnMarkers(historyItems: readonly ConversationItem[]): TurnMarker[] {
  const markers: TurnMarker[] = [];
  for (const u of userItemsOf(historyItems)) {
    // 投影来自服务端，index 恒有；缺失则无法跳转定位，不产 marker
    if (typeof u.sourceIndex !== 'number') continue;
    markers.push({
      key: markerKeyOf(u),
      sourceIndex: u.sourceIndex,
      itemId: u.id,
      createdAt: u.createdAt,
      text: u.content,
      loaded: false,
    });
  }
  return markers;
}

/**
 * 合并「历史 turn 索引」与「已加载用户条目」为定位轨 marker（时间正序）。
 *
 * 覆盖规则：
 * - 已加载用户条目按 sourceIndex 覆盖同下标历史 turn（文本以当前条目为准）；
 * - 历史 turn 只保留下标严格小于「已加载最早用户条目下标」的部分——已加载
 *   区间内未匹配到条目的历史 turn 视为已被截断/改写，不得复活；
 * - 无 sourceIndex 的 live 用户条目附加为 marker，按 createdAt 参与排序。
 *
 * @param historyTurns 历史 turn marker（historyTurnMarkers 产出）
 * @param conversationItems 当前已加载的会话条目
 * @returns 合并后的定位轨 marker（时间正序，同刻按下标升序）
 *
 * 不变量：已加载窗口是 session.messages 的连续后缀（分页只向前 prepend）。
 * 若将来出现非连续窗口（如跳转只直载中间页），「≥ oldestLoaded ⇒ 丢弃」
 * 会误删窗口外的合法 turn，须改为按已加载区间逐段判定。
 */
export function buildTurnMarkers(
  historyTurns: readonly TurnMarker[],
  conversationItems: readonly ConversationItem[],
): TurnMarker[] {
  const byKey = new Map<string, TurnMarker>();
  const loadedUsers = userItemsOf(conversationItems);
  let oldestLoaded = Number.POSITIVE_INFINITY;
  for (const u of loadedUsers) {
    if (typeof u.sourceIndex === 'number' && u.sourceIndex < oldestLoaded) {
      oldestLoaded = u.sourceIndex;
    }
    const key = markerKeyOf(u);
    byKey.set(key, {
      key,
      sourceIndex: u.sourceIndex,
      itemId: u.id,
      createdAt: u.createdAt,
      text: u.content,
      loaded: true,
    });
  }
  for (const t of historyTurns) {
    if (typeof t.sourceIndex !== 'number') continue;
    if (t.sourceIndex >= oldestLoaded) continue;
    if (byKey.has(t.key)) continue;
    byKey.set(t.key, t);
  }
  const markers = [...byKey.values()];
  markers.sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      (a.sourceIndex ?? Number.MAX_SAFE_INTEGER) - (b.sourceIndex ?? Number.MAX_SAFE_INTEGER),
  );
  return markers;
}
