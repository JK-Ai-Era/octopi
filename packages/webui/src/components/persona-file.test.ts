import { describe, it, expect } from 'vitest';
import { normalizePersonaFileName } from './persona-file';

describe('normalizePersonaFileName', () => {
  it('不带后缀：统一补 .md', () => {
    expect(normalizePersonaFileName('notes')).toBe('notes.md');
    expect(normalizePersonaFileName('  my-notes  ')).toBe('my-notes.md');
  });

  it('已带后缀：不重复补（含大写 .MD）', () => {
    expect(normalizePersonaFileName('notes.md')).toBe('notes.md');
    expect(normalizePersonaFileName('notes.MD')).toBe('notes.md');
  });

  it('非法输入返回 null：空 / 只有后缀 / 路径成分 / 穿越形态', () => {
    expect(normalizePersonaFileName('')).toBeNull();
    expect(normalizePersonaFileName('   ')).toBeNull();
    expect(normalizePersonaFileName('.md')).toBeNull();
    expect(normalizePersonaFileName('../evil')).toBeNull();
    expect(normalizePersonaFileName('a/b')).toBeNull();
    expect(normalizePersonaFileName('a\\b')).toBeNull();
    // 尾点名补后缀后成 `..` 形态（服务端同拒）
    expect(normalizePersonaFileName('foo.')).toBeNull();
    expect(normalizePersonaFileName('...')).toBeNull();
  });
});
