/**
 * session-filename — toSessionFileName
 */

import { describe, it, expect } from 'vitest';
import { toSessionFileName } from '../src/integration/storage/session-filename.js';

describe('toSessionFileName', () => {
  it('maps colons to underscores', () => {
    expect(toSessionFileName('default:web:1700000000000')).toBe('default_web_1700000000000');
  });

  it('keeps safe names unchanged', () => {
    expect(toSessionFileName('default-web-1')).toBe('default-web-1');
  });

  it('escapes Windows reserved device names', () => {
    expect(toSessionFileName('CON')).toBe('_CON');
    expect(toSessionFileName('con.txt')).toBe('_con.txt');
  });

  it('strips trailing dots and spaces', () => {
    expect(toSessionFileName('abc. ')).toBe('abc');
  });

  it('replaces illegal characters', () => {
    expect(toSessionFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('never returns empty', () => {
    expect(toSessionFileName('...')).toBe('_');
  });
});
