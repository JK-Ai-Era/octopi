import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubsystemLoader } from '../../src/harness/autonomous-subsystem/loader.js';

function writeSubsystem(dir: string, id: string, overrides: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: id }));
  writeFileSync(join(dir, 'handler.ts'), `export async function handler() {
  return { signals: [{ action: 'suggest', reason: 'stub' }] };
}
`);
  writeFileSync(join(dir, 'config.yaml'), [
    `id: ${id}`,
    'sense:',
    '  source: eventBus',
    '  filter:',
    '    events: [test.event]',
    '  isolation: structured',
    'think:',
    '  implementation: code',
    '  strategy: deterministic',
    'act:',
    '  mode: none',
    'signal:',
    '  severity: info',
    '  channel: [event]',
    'boundary:',
    '  visibility: structured',
    '  authority: observe',
    '  security: sandboxed',
    'tools:',
    '  mode: none',
    'session:',
    '  mode: ephemeral',
    '  scope: session',
    ...Object.entries(overrides).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
  ].join('\n'));
}

describe('SubsystemLoader npm discovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'octopi-npm-loader-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers @octopi/subsystem-* packages from node_modules', async () => {
    const projectDir = join(tmpDir, 'project', '.octopi', 'subsystems');
    const npmDir = join(tmpDir, 'project', 'node_modules');

    writeSubsystem(join(projectDir, 'local-sub'), 'local.sub', { emits: ['local'] });
    writeSubsystem(join(npmDir, '@octopi', 'subsystem-safe'), '@octopi/subsystem-safe', { emits: ['safe'] });

    const loader = new SubsystemLoader({ projectDir, npmDir });
    const result = await loader.loadAll();

    expect(result.errors).toEqual([]);
    const ids = result.specs.map((s) => s.id).sort();
    expect(ids).toEqual(['@octopi/subsystem-safe', 'local.sub']);
  });

  it('supports plain octopi-subsystem-* naming', async () => {
    const npmDir = join(tmpDir, 'project', 'node_modules');
    writeSubsystem(join(npmDir, 'octopi-subsystem-review'), 'octopi-subsystem-review');

    const loader = new SubsystemLoader({ npmDir });
    const result = await loader.loadAll();

    expect(result.errors).toEqual([]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].id).toBe('octopi-subsystem-review');
  });

  it('ignores unrelated npm packages', async () => {
    const npmDir = join(tmpDir, 'project', 'node_modules');
    mkdirSync(join(npmDir, 'lodash'), { recursive: true });
    writeFileSync(join(npmDir, 'lodash', 'package.json'), '{}');

    const loader = new SubsystemLoader({ npmDir });
    const result = await loader.loadAll();

    expect(result.specs).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });
});
