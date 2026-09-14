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
});

describe('legacySessionFileName', () => {
  test('returns raw id when it needs sanitizing', () => {
    expect(legacySessionFileName('default:web:1')).toBe('default:web:1');
  });

  test('returns null when already safe', () => {
    expect(legacySessionFileName('default-web-1')).toBeNull();
  });
});
