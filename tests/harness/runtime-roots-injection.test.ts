/**
 * Runtime workspace injection includes allowRoots + effectMode.
 */
import { describe, it, expect } from 'vitest';

import {
  formatRuntimeWorkspaceInjection,
  withRuntimeEnvironmentInjection,
} from '@octopi-agent/engine/harness/context/runtime-datetime.js';

describe('formatRuntimeWorkspaceInjection', () => {
  it('includes workspace, allowRoots, and effect mode', () => {
    const s = formatRuntimeWorkspaceInjection('/ws/project', {
      allowRoots: ['/ws/project', '/data/scratch'],
      effectMode: 'project',
    });
    expect(s).toContain('Workspace: /ws/project');
    expect(s).toContain('Allowed roots');
    expect(s).toContain('/ws/project');
    expect(s).toContain('/data/scratch');
    expect(s).toContain('Effect mode: project');
  });

  it('host mode gets a non-sandbox note', () => {
    const s = formatRuntimeWorkspaceInjection('/home/u', { effectMode: 'host' });
    expect(s).toContain('not a sandbox');
  });

  it('empty cwd returns empty string', () => {
    expect(formatRuntimeWorkspaceInjection(undefined)).toBe('');
    expect(formatRuntimeWorkspaceInjection('  ')).toBe('');
  });

  it('withRuntimeEnvironmentInjection threads roots', () => {
    const out = withRuntimeEnvironmentInjection('extra', {
      cwd: '/ws',
      allowRoots: ['/ws'],
      effectMode: 'workspace',
    });
    expect(out).toContain('Current datetime:');
    expect(out).toContain('Workspace: /ws');
    expect(out).toContain('Allowed roots');
    expect(out).toContain('extra');
  });
});
