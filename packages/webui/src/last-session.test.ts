// @vitest-environment jsdom
/**
 * 「上次打开会话」按 agent 分槽：切 agent 各自回到自己的会话，刷新回到最近打开的那个。
 * 坏数据必须降级（不得抛出），删除会话要清掉任意槽里的指向。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  clearLastSessionIfMatches,
  readLastSession,
  readLastSessionForAgent,
  writeLastSession,
} from './last-session';

afterEach(() => localStorage.clear());

describe('last-session（按 agent 分槽）', () => {
  it('未记录时为空', () => {
    expect(readLastSession()).toBeNull();
    expect(readLastSessionForAgent('a')).toBeNull();
  });

  it('各 agent 独立记录，互不覆盖', () => {
    writeLastSession({ sessionId: 's-a1', agentId: 'a' });
    writeLastSession({ sessionId: 's-b1', agentId: 'b' });
    expect(readLastSessionForAgent('a')?.sessionId).toBe('s-a1');
    expect(readLastSessionForAgent('b')?.sessionId).toBe('s-b1');
    expect(readLastSession()?.sessionId).toBe('s-b1'); // 最近打开的
  });

  it('同一 agent 再次打开会替换自己的槽，并成为最近一次', () => {
    writeLastSession({ sessionId: 's-a1', agentId: 'a' });
    writeLastSession({ sessionId: 's-b1', agentId: 'b' });
    writeLastSession({ sessionId: 's-a2', agentId: 'a' });
    expect(readLastSessionForAgent('a')?.sessionId).toBe('s-a2');
    expect(readLastSessionForAgent('b')?.sessionId).toBe('s-b1');
    expect(readLastSession()).toEqual({ sessionId: 's-a2', agentId: 'a' });
  });

  it('同毫秒连续写入也保持严格递增：最近一次确定', () => {
    const spy = Date.now;
    Date.now = () => 1_000;
    try {
      writeLastSession({ sessionId: 's1', agentId: 'a' });
      writeLastSession({ sessionId: 's2', agentId: 'b' });
    } finally {
      Date.now = spy;
    }
    expect(readLastSession()?.sessionId).toBe('s2');
    expect(readLastSessionForAgent('a')?.sessionId).toBe('s1');
  });

  it('删除会话清掉任意槽里的指向，其它 agent 的记忆保留', () => {
    writeLastSession({ sessionId: 's-a1', agentId: 'a' });
    writeLastSession({ sessionId: 's-b1', agentId: 'b' });
    clearLastSessionIfMatches('s-a1');
    expect(readLastSessionForAgent('a')).toBeNull();
    expect(readLastSessionForAgent('b')?.sessionId).toBe('s-b1');
    clearLastSessionIfMatches('不存在');
    expect(readLastSession()?.sessionId).toBe('s-b1');
  });

  it('内容损坏 / 形状不对时降级，不抛出', () => {
    localStorage.setItem('octopi.lastSession.v2', '{not json');
    expect(readLastSession()).toBeNull();
    localStorage.setItem(
      'octopi.lastSession.v2',
      JSON.stringify({ a: { sessionId: 42 }, b: null, c: { sessionId: 'ok' } }),
    );
    expect(readLastSessionForAgent('a')).toBeNull();
    expect(readLastSessionForAgent('c')?.sessionId).toBe('ok');
    localStorage.setItem('octopi.lastSession.v2', JSON.stringify(['not-a-map']));
    expect(readLastSession()).toBeNull();
  });

  it('清空最后一个槽时把键一起删掉（不留空对象）', () => {
    writeLastSession({ sessionId: 's1', agentId: 'a' });
    clearLastSessionIfMatches('s1');
    expect(localStorage.getItem('octopi.lastSession.v2')).toBeNull();
  });
});
