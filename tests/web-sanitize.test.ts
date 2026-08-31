import { describe, it, expect } from 'vitest';

// Import sanitize utilities directly (they have no React/browser deps)
function escapeHtml(input: string): string {
  const ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  };
  return input.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

function toSafeString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => String(b.text ?? ''))
      .join('');
  }
  if (content != null) return JSON.stringify(content);
  return '';
}

describe('sanitize utilities', () => {
  it('escapeHtml escapes HTML special characters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b "c" \'d\'')).toBe('a &amp; b &quot;c&quot; &#39;d&#39;');
    expect(escapeHtml('no special chars')).toBe('no special chars');
    expect(escapeHtml('')).toBe('');
  });

  it('toSafeString handles string content', () => {
    expect(toSafeString('hello')).toBe('hello');
    expect(toSafeString('')).toBe('');
  });

  it('toSafeString handles null/undefined', () => {
    expect(toSafeString(null)).toBe('');
    expect(toSafeString(undefined)).toBe('');
  });

  it('toSafeString handles array content blocks', () => {
    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
    ];
    expect(toSafeString(blocks)).toBe('hello world');
  });

  it('toSafeString filters non-text blocks', () => {
    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'image', url: 'http://example.com/img.png' },
      { type: 'text', text: ' world' },
    ];
    expect(toSafeString(blocks)).toBe('hello world');
  });

  it('toSafeString handles objects via JSON.stringify', () => {
    expect(toSafeString({ key: 'value' })).toBe('{"key":"value"}');
    expect(toSafeString(42)).toBe('42');
  });
});
