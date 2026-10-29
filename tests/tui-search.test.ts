/**
 * TUI /find 历史搜索——纯检索逻辑。
 *
 * 钉住：大小写不敏感子串匹配、命中行片段（长行截取窗口）、
 * 每消息首个命中、maxHits 上限、空查询不命中。
 */

import { describe, it, expect } from 'vitest';
import { searchMessages, type SearchableMessage } from '../src/integration/tui/search.js';

const messages: SearchableMessage[] = [
  { index: 1, role: 'user', content: '帮我修 Gateway 认证失败的问题' },
  {
    index: 2,
    role: 'assistant',
    content: '根因是 apiKey 没传给 GatewayChatClient。' ,
  },
  {
    index: 3,
    role: 'assistant',
    content: '补充：unauthorized 还有一种可能是 token 过期；\nunauthorized 也可能是路由错了。',
  },
  { index: 4, role: 'user', content: [{ type: 'text', text: '把 unauthorized 的测试补上' }] },
];

describe('searchMessages', () => {
  it('大小写不敏感子串命中，产出片段与角色/序号', () => {
    const hits = searchMessages(messages, 'unauthorized');
    expect(hits.map((h) => h.index)).toEqual([3, 4]);
    expect(hits[0].role).toBe('assistant');
    expect(hits[0].snippet).toContain('token 过期');
    expect(hits[1].role).toBe('user');
    expect(hits[1].snippet).toContain('测试补上');
  });

  it('多行消息只记首个命中行', () => {
    const hits = searchMessages(messages, 'unauthorized', { maxHits: 10 });
    expect(hits.filter((h) => h.index === 3)).toHaveLength(1);
    expect(hits[0].snippet).not.toContain('路由');
  });

  it('长行命中截取窗口并带省略号', () => {
    const long = 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200);
    const hits = searchMessages([{ index: 9, role: 'user', content: long }], 'needle');
    expect(hits[0].snippet.startsWith('…')).toBe(true);
    expect(hits[0].snippet.endsWith('…')).toBe(true);
    expect(hits[0].snippet.length).toBeLessThan(120);
  });

  it('maxHits 上限截断；空查询返回空', () => {
    const many: SearchableMessage[] = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      role: 'user',
      content: 'hit',
    }));
    expect(searchMessages(many, 'hit', { maxHits: 3 })).toHaveLength(3);
    expect(searchMessages(messages, '  ')).toEqual([]);
    expect(searchMessages(messages, '不存在的词')).toEqual([]);
  });

  it('多模态内容按文本块检索（媒体块降级为占位文本）', () => {
    const hits = searchMessages(
      [{ index: 5, role: 'user', content: [{ type: 'image' }, { type: 'text', text: '看这张图 dataflow' }] }],
      'dataflow',
    );
    expect(hits).toHaveLength(1);
    // 媒体块只留占位标注；占位文本可搜，但不会有本体内容
    expect(searchMessages([{ index: 6, role: 'user', content: [{ type: 'image' }] }], 'zzz')).toEqual([]);
    expect(searchMessages([{ index: 7, role: 'user', content: [{ type: 'image' }] }], 'image')).toHaveLength(1);
  });
});
