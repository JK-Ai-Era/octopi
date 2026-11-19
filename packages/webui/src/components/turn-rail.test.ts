import { describe, it, expect } from 'vitest';
import type {
  ConversationItem,
  UserConversationItem,
} from '@octopi-agent/gateway/web/conversation/types';
import { buildTurnMarkers, historyTurnMarkers, type TurnMarker } from './turn-rail';

function userItem(over: Partial<UserConversationItem> & { id: string }): UserConversationItem {
  return {
    role: 'user',
    createdAt: 0,
    sessionId: 'sess',
    source: 'history',
    content: '',
    ...over,
  };
}

function historyMarker(over: Partial<TurnMarker> & { sourceIndex: number }): TurnMarker {
  return {
    key: `idx-${over.sourceIndex}`,
    itemId: `usr-${over.sourceIndex}`,
    createdAt: 0,
    text: '',
    loaded: false,
    ...over,
  };
}

describe('historyTurnMarkers（user-messages 投影 → 未加载 turn）', () => {
  it('保留带 sourceIndex 的用户条目，缺失下标的不产 marker', () => {
    const items: ConversationItem[] = [
      userItem({ id: 'a', sourceIndex: 3, content: '你好', createdAt: 10 }),
      userItem({ id: 'b', content: 'live 没有下标' }),
    ];
    const markers = historyTurnMarkers(items);
    expect(markers).toEqual([
      {
        key: 'idx-3',
        sourceIndex: 3,
        itemId: 'a',
        createdAt: 10,
        text: '你好',
        loaded: false,
      },
    ]);
  });
});

describe('buildTurnMarkers（合并历史索引与已加载条目）', () => {
  it('已加载条目覆盖同下标历史 turn（文本以当前条目为准）', () => {
    const merged = buildTurnMarkers(
      [historyMarker({ sourceIndex: 5, text: '旧文本', createdAt: 50 })],
      [userItem({ id: 'live-5', sourceIndex: 5, content: '新文本', createdAt: 55 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      key: 'idx-5',
      sourceIndex: 5,
      itemId: 'live-5',
      text: '新文本',
      loaded: true,
    });
  });

  it('已加载区间内未匹配的历史 turn 不复活（截断/编辑重发防陈旧索引）', () => {
    // 已加载窗口最早用户条目在下标 50；历史索引里 55/60 已被截断改写
    const merged = buildTurnMarkers(
      [
        historyMarker({ sourceIndex: 40, createdAt: 40 }),
        historyMarker({ sourceIndex: 55, createdAt: 55 }),
        historyMarker({ sourceIndex: 60, createdAt: 60 }),
      ],
      [userItem({ id: 'cur-50', sourceIndex: 50, content: '现存', createdAt: 50 })],
    );
    expect(merged.map((m) => m.key)).toEqual(['idx-40', 'idx-50']);
    expect(merged[0].loaded).toBe(false);
    expect(merged[1].loaded).toBe(true);
  });

  it('无 sourceIndex 的 live 用户条目附加为 marker 并参与排序', () => {
    const merged = buildTurnMarkers(
      [historyMarker({ sourceIndex: 1, createdAt: 10 })],
      [
        userItem({ id: 'live-a', content: '插话', createdAt: 30 }),
        userItem({ id: 'old-1', sourceIndex: 1, content: '第一轮', createdAt: 10 }),
      ],
    );
    expect(merged.map((m) => m.key)).toEqual(['idx-1', 'id-live-a']);
    expect(merged[1]).toMatchObject({ itemId: 'live-a', loaded: true, text: '插话' });
  });

  it('时间正序排列，同刻按下标升序（无下标最后）', () => {
    const merged = buildTurnMarkers(
      [],
      [
        userItem({ id: 'c', content: '3', createdAt: 20 }),
        userItem({ id: 'd', content: 'live', createdAt: 20 }),
        userItem({ id: 'a', sourceIndex: 7, content: '1', createdAt: 10 }),
        userItem({ id: 'b', sourceIndex: 8, content: '2', createdAt: 20 }),
      ],
    );
    expect(merged.map((m) => m.key)).toEqual(['idx-7', 'idx-8', 'id-c', 'id-d']);
  });

  it('全部历史（未加载区间）而无已加载条目时全量保留', () => {
    const merged = buildTurnMarkers(
      [
        historyMarker({ sourceIndex: 0, createdAt: 1 }),
        historyMarker({ sourceIndex: 9, createdAt: 9 }),
      ],
      [],
    );
    expect(merged.map((m) => m.sourceIndex)).toEqual([0, 9]);
    expect(merged.every((m) => !m.loaded)).toBe(true);
  });
});
