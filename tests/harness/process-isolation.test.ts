/**
 * L4 process isolation contract — env scrub, L4 floor, supervised spawn honesty.
 */
import { describe, it, expect } from 'vitest';

import {
  assessL4ProcessMinimum,
  probeProcessIsolation,
  scrubEnv,
  supervisedSpawnProfile,
  L4_PROCESS_MINIMUM,
} from '@octopi-agent/engine/harness/extension/execution-environment/process-isolation.js';
import {
  ProcessSandbox,
  createProcessSandbox,
} from '@octopi-agent/engine/harness/extension/execution-environment/sandbox.js';

describe('scrubEnv', () => {
  it('drops secrets and keeps allowlisted keys', () => {
    const env = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      OPENAI_API_KEY: 'sk-secret',
      AWS_SECRET_ACCESS_KEY: 'x',
      NPM_TOKEN: 't',
      LANG: 'C',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.LANG).toBe('C');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  it('returns empty object when nothing allowlisted', () => {
    expect(scrubEnv({ FOO: '1', BAR: '2' })).toEqual({});
    expect(scrubEnv()).toEqual({});
  });
});

describe('assessL4ProcessMinimum', () => {
  it('supervised spawn does not meet L4 floor', () => {
    const a = assessL4ProcessMinimum(supervisedSpawnProfile());
    expect(a.ok).toBe(false);
    expect(a.missing).toContain('filesystem');
    expect(a.missing).toContain('privilege');
  });

  it('full jail profile meets floor', () => {
    const a = assessL4ProcessMinimum({
      backend: 'linux-bwrap',
      processTree: 'contained',
      filesystem: 'root-jailed',
      resources: 'os-enforced',
      network: 'open',
      privilege: 'dropped',
      envHygiene: 'scrubbed',
    });
    expect(a.ok).toBe(true);
    expect(a.missing).toEqual([]);
  });

  it('Windows best-effort write jail meets floor', () => {
    const a = assessL4ProcessMinimum({
      backend: 'win-job',
      processTree: 'killable',
      filesystem: 'write-jailed-best-effort',
      resources: 'best-effort',
      network: 'open',
      privilege: 'dropped',
      envHygiene: 'scrubbed',
    });
    expect(a.ok).toBe(true);
  });

  it('network is not part of the floor', () => {
    const base = {
      backend: 'linux-bwrap' as const,
      processTree: 'contained' as const,
      filesystem: 'root-jailed' as const,
      resources: 'os-enforced' as const,
      privilege: 'dropped' as const,
      envHygiene: 'scrubbed' as const,
    };
    expect(assessL4ProcessMinimum({ ...base, network: 'open' }).ok).toBe(true);
    expect(assessL4ProcessMinimum({ ...base, network: 'deny' }).ok).toBe(true);
  });

  it('exports L4 floor keys', () => {
    expect(L4_PROCESS_MINIMUM.processTree).toContain('killable');
    expect(L4_PROCESS_MINIMUM.filesystem).toContain('write-jailed-best-effort');
  });
});

describe('ProcessSandbox honesty', () => {
  it('reports supervised isolation when no jail backend', async () => {
    const sb = new ProcessSandbox({
      profile: supervisedSpawnProfile(),
    });
    const profile = await sb.probe();
    expect(profile.backend).toBe('supervised-spawn');
    expect(profile.filesystem).toBe('cwd-pin');
    expect(assessL4ProcessMinimum(profile).ok).toBe(false);
  });

  it('execute result carries isolation profile and does not inherit secrets', async () => {
    process.env.OCTOPI_TEST_SECRET = 'should-not-leak';
    try {
      const sb = new ProcessSandbox({ profile: supervisedSpawnProfile() });
      const isWin = process.platform === 'win32';
      const script = isWin
        ? 'echo [%OCTOPI_TEST_SECRET%]'
        : 'echo "[$OCTOPI_TEST_SECRET]"';
      const result = await sb.execute(script, {
        cwd: process.cwd(),
        limits: { timeoutMs: 10_000, maxOutputBytes: 4096 },
      });
      expect(result.isolation.backend).toBe('supervised-spawn');
      expect(result.isolation.envHygiene).toBe('scrubbed');
      // Secret is scrubbed from child env — expansion is empty / literal
      expect(result.stdout).not.toContain('should-not-leak');
    } finally {
      delete process.env.OCTOPI_TEST_SECRET;
    }
  });

  it('createProcessSandbox probes the host', async () => {
    const sb = await createProcessSandbox();
    const profile = await sb.probe();
    expect(profile.envHygiene).toBe('scrubbed');
    expect(profile.backend).toBeTruthy();
  });
});
