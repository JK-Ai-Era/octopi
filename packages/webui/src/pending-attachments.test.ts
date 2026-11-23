// @vitest-environment jsdom
/**
 * 待发附件按会话持久化：切会话互不串台、空列表删键、无会话不落盘、坏数据降级。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  readPendingAttachments,
  removePendingAttachments,
  writePendingAttachments,
} from './pending-attachments';

const item = { id: 'a1', name: 'report.pdf', sizeBytes: 12, status: 'ready' };

afterEach(() => localStorage.clear());

describe('pending-attachments', () => {
  it('按会话隔离：写入 A 不影响 B', () => {
    writePendingAttachments('s1', [item]);
    expect(readPendingAttachments('s1')).toEqual([item]);
    expect(readPendingAttachments('s2')).toEqual([]);
  });

  it('空列表等价于删除键', () => {
    writePendingAttachments('s1', [item]);
    writePendingAttachments('s1', []);
    expect(localStorage.getItem('octopi.pendingAttachments.v1.session:s1')).toBeNull();
    expect(readPendingAttachments('s1')).toEqual([]);
  });

  it('无活动会话（null）时不落盘', () => {
    writePendingAttachments(null, [item]);
    expect(localStorage.length).toBe(0);
  });

  it('删除会话记录', () => {
    writePendingAttachments('s1', [item]);
    removePendingAttachments('s1');
    expect(readPendingAttachments('s1')).toEqual([]);
  });

  it('坏数据降级为空数组，并修正缺省字段', () => {
    localStorage.setItem('octopi.pendingAttachments.v1.session:s1', '{broken');
    expect(readPendingAttachments('s1')).toEqual([]);
    localStorage.setItem(
      'octopi.pendingAttachments.v1.session:s1',
      JSON.stringify([{ id: 'x', name: 'n' }, { name: 'no-id' }, null]),
    );
    expect(readPendingAttachments('s1')).toEqual([
      { id: 'x', name: 'n', sizeBytes: 0, status: 'ready' },
    ]);
  });
});
