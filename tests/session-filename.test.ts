/**
 * Session 文件名跨平台映射
 */

import { describe, test, expect } from 'vitest';
import { toSessionFileName, legacySessionFileName } from '../src/integration/storage/session-filename.js';

describe('toSessionFileName', () => {
  test('replaces Windows-illegal colon', () => {
    expect(toSessionFileName('default:web:1789413355353')).toBe(
      'default_web_1789413355353',
    );
  });

  test('keeps safe id characters', () => {
    expect(toSessionFileName('assistant-web-123')).toBe('assistant-web-123');
  });

  test('strips other illegal path chars', () => {
    expect(toSessionFileName('a<b>c:d"e/f\\g|h?i*j')).toBe(
      'a_b_c_d_e_f_g_h_i_j',
    );
  });

  test('prefixes Windows reserved device names', () => {
    expect(toSessionFileName('CON')).toBe('_CON');
    expect(toSessionFileName('nul')).toBe('_nul');
    expect(toSessionFileName('COM1')).toBe('_COM1');
    expect(toSessionFileName('LPT9.session')).toBe('_LPT9.session');
  });

  test('strips trailing dots and spaces', () => {
    expect(toSessionFileName('session-1...')).toBe('session-1');
    expect(toSessionFileName('session-1  ')).toBe('session-1');
  });

  test('falls back to underscore when empty after sanitize', () => {
    expect(toSessionFileName('...')).toBe('_');
  });
});

describe('legacySessionFileName', () => {
  test('returns raw id when it needs sanitizing', () => {
    expect(legacySessionFileName('default:web:1')).toBe('default:web:1');
  });

  test('returns null when already safe', () => {
    expect(legacySessionFileName('default-web-1')).toBeNull();
  });

  test('returns raw reserved name so legacy macOS file can be found', () => {
    expect(legacySessionFileName('CON')).toBe('CON');
  });
});
