import { describe, it, expect } from 'vitest';
import { SubsystemLoader } from '../../src/harness/autonomous-subsystem/loader.js';
import { join } from 'node:path';

describe('builtin subsystem configs', () => {
  it('loads memory-steward multi-spec package and safety-guard', async () => {
    const loader = new SubsystemLoader({
      builtinDir: join(process.cwd(), 'src', 'subsystems'),
    });
    const { specs, errors } = await loader.loadAll();
    const ids = specs.map((s) => s.id);
    expect(ids).toContain('memory.steward.backfill');
    expect(ids).toContain('memory.steward.govern');
    expect(ids).toContain('safety-guard');
    expect(ids).not.toContain('memory.extractor');
    const unexpected = errors.filter((e) => e.path.includes('memory-steward'));
    expect(unexpected).toEqual([]);
  });
});
