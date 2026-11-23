// @vitest-environment jsdom
/**
 * 输入框草稿缓存：会话隔离、空串删键、空态迁移、存储不可用降级。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  moveComposerDraft,
  readComposerDraft,
  removeComposerDraft,
  writeComposerDraft,
} from './composer-draft';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('composer-draft', () => {
  it('按会话隔离读写，空态是独立作用域', () => {
    writeComposerDraft({ sessionId: 's1' }, 'draft A');
    writeComposerDraft({ sessionId: 's2' }, 'draft B');
    writeComposerDraft({ sessionId: null }, 'draft new');

    expect(readComposerDraft({ sessionId: 's1' })).toBe('draft A');
    expect(readComposerDraft({ sessionId: 's2' })).toBe('draft B');
    expect(readComposerDraft({ sessionId: null })).toBe('draft new');
    expect(readComposerDraft({ sessionId: 'missing' })).toBe('');
  });

  it('写入空串等价于删除，不留空键', () => {
    writeComposerDraft({ sessionId: 's1' }, 'text');
    writeComposerDraft({ sessionId: 's1' }, '');

    expect(readComposerDraft({ sessionId: 's1' })).toBe('');
    expect(localStorage.getItem('octopi.composerDraft.v1.session:s1')).toBeNull();
  });

  it('move 把空态草稿迁到新会话并删除源', () => {
    writeComposerDraft({ sessionId: null }, 'hello');

    expect(moveComposerDraft({ sessionId: null }, { sessionId: 's-new' })).toBe('hello');
    expect(readComposerDraft({ sessionId: 's-new' })).toBe('hello');
    expect(readComposerDraft({ sessionId: null })).toBe('');
  });

  it('move 源为空时不写目标（不制造空键）', () => {
    expect(moveComposerDraft({ sessionId: null }, { sessionId: 's-new' })).toBe('');
    expect(localStorage.getItem('octopi.composerDraft.v1.session:s-new')).toBeNull();
  });

  it('remove 只删目标会话', () => {
    writeComposerDraft({ sessionId: 's1' }, 'a');
    writeComposerDraft({ sessionId: 's2' }, 'b');

    removeComposerDraft({ sessionId: 's1' });

    expect(readComposerDraft({ sessionId: 's1' })).toBe('');
    expect(readComposerDraft({ sessionId: 's2' })).toBe('b');
  });

  it('localStorage 写入失败时降级：不抛错，读取返回空串', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => writeComposerDraft({ sessionId: 's1' }, 'text')).not.toThrow();
    expect(readComposerDraft({ sessionId: 's1' })).toBe('');
  });
});
