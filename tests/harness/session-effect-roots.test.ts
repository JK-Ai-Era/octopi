/**
 * Session-scoped temporary transactionRoots (append-only, session lifetime).
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

import {
  mergeTransactionRoots,
  normalizeTransactionRoots,
  readSessionEffectOverrides,
  SESSION_EFFECT_OVERRIDES_KEY,
} from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';

describe('normalizeTransactionRoots', () => {
  it('resolves to absolute and dedupes', () => {
    const abs = resolve('/data/scratch');
    const out = normalizeTransactionRoots(['/data/scratch', abs, '/data/other']);
    expect(out).toContain(abs);
    expect(out).toContain(resolve('/data/other'));
    expect(new Set(out.map((p) => p.toLowerCase())).size).toBe(out.length);
  });

  it('rejects empty and relative paths', () => {
    expect(() => normalizeTransactionRoots([''])).toThrow(/effect_root_empty/);
    expect(() => normalizeTransactionRoots(['   '])).toThrow(/effect_root_empty/);
    // resolve() makes relative absolute against cwd — require explicit absolute
    expect(() => normalizeTransactionRoots(['relative/path'])).toThrow(
      /effect_root_not_absolute/,
    );
  });
});

describe('mergeTransactionRoots', () => {
  it('appends extra without dropping base', () => {
    const base = ['/ws', '/data/shared'];
    const extra = ['/data/scratch', '/ws'];
    const out = mergeTransactionRoots(base, extra);
    expect(out[0]).toBe('/ws');
    expect(out).toContain('/data/shared');
    expect(out).toContain('/data/scratch');
    expect(out.filter((p) => p === '/ws')).toHaveLength(1);
  });

  it('empty extra returns base', () => {
    expect(mergeTransactionRoots(['/a'], undefined)).toEqual(['/a']);
    expect(mergeTransactionRoots(['/a'], [])).toEqual(['/a']);
  });
});

describe('readSessionEffectOverrides', () => {
  it('reads metadata bag', () => {
    const meta = {
      [SESSION_EFFECT_OVERRIDES_KEY]: {
        transactionRoots: ['/data/x', '/data/x', '/data/y'],
      },
    };
    const o = readSessionEffectOverrides(meta);
    expect(o.transactionRoots).toEqual([resolve('/data/x'), resolve('/data/y')]);
  });

  it('returns empty for missing or invalid', () => {
    expect(readSessionEffectOverrides(undefined)).toEqual({});
    expect(readSessionEffectOverrides({})).toEqual({});
    expect(readSessionEffectOverrides({ effectOverrides: 'nope' })).toEqual({});
    expect(
      readSessionEffectOverrides({ effectOverrides: { transactionRoots: 'x' } }),
    ).toEqual({});
  });

  it('skips corrupt entries without throwing (read path is resilient)', () => {
    const o = readSessionEffectOverrides({
      effectOverrides: {
        transactionRoots: ['relative/nope', '', 42, '/data/ok', '/data/ok'],
      },
    });
    expect(o.transactionRoots).toEqual([resolve('/data/ok')]);
  });
});
