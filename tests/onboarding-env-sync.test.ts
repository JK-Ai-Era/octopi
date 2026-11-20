import { describe, expect, it } from 'vitest';

describe('评审回归锚（del-1d95563a）', () => {
  it('B3：writeEnvLine 同步 process.env（热应用 expandEnvValues 读进程 env——只写盘会用空/旧 key）', async () => {
    const { writeEnvLine } = await import('../packages/engine/src/config-admin/onboarding-apply.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'octopi-envsync-'));
    const key = `TEST_ENV_SYNC_${Date.now()}`;
    try {
      writeEnvLine(home, `${key}=fresh-value`);
      expect(process.env[key]).toBe('fresh-value');
      writeEnvLine(home, `${key}=rotated-value`);
      expect(process.env[key]).toBe('rotated-value'); // 重跑向导换 key：新值即刻生效
    } finally {
      delete process.env[key];
      rmSync(home, { recursive: true, force: true });
    }
  });
});
