/**
 * Gateway HTTP 监听配置解析（src/cli/listen-config.ts）
 *
 * 钉住 gateway 进程面覆盖段的优先级语义（docs/KNOWN-ISSUES.md `gateway` 条目）：
 * CLI --port > gateway.port > channels[type=http].port > 18180；
 * host：gateway.host > channels[].host > web.host。
 */
import { describe, it, expect } from 'vitest';
import { resolveListenConfig } from '../src/cli/listen-config.js';

describe('resolveListenConfig', () => {
  it('port precedence: cli > gateway > channels > default', () => {
    expect(
      resolveListenConfig({
        cliPort: 1,
        gateway: { port: 2 },
        http: { port: 3 },
      }).port,
    ).toBe(1);
    expect(resolveListenConfig({ gateway: { port: 2 }, http: { port: 3 } }).port).toBe(2);
    expect(resolveListenConfig({ http: { port: 3 } }).port).toBe(3);
    expect(resolveListenConfig({}).port).toBe(18180);
  });

  it('host precedence: gateway > channels > web', () => {
    expect(
      resolveListenConfig({
        gateway: { host: 'lan' },
        http: { host: 'local' },
        webHost: 'local',
      }).host,
    ).toBe('lan');
    expect(resolveListenConfig({ http: { host: 'local' }, webHost: 'lan' }).host).toBe('local');
    expect(resolveListenConfig({ webHost: 'lan' }).host).toBe('lan');
    expect(resolveListenConfig({}).host).toBeUndefined();
  });

  it('listen gate: enabled only with an explicit port source or http channel', () => {
    expect(resolveListenConfig({ cliPort: 9 }).enabled).toBe(true);
    expect(resolveListenConfig({ gateway: { port: 9 } }).enabled).toBe(true);
    expect(resolveListenConfig({ http: {} }).enabled).toBe(true);
    // 单独 gateway.host / web.host 不启动监听（与 web.host 既有语义一致）
    expect(resolveListenConfig({ gateway: { host: 'lan' } }).enabled).toBe(false);
    expect(resolveListenConfig({ webHost: 'lan' }).enabled).toBe(false);
    expect(resolveListenConfig({}).enabled).toBe(false);
  });
});

// C1 回归钉：resolveListenPort（serve start 注入 --port、pid/占用预检共用）必须走
// 完整优先级。曾只读 channels[].port，导致 gateway.port 在首选启动路径永远被压掉。
describe('resolveListenPort (daemon config-file resolution)', () => {
  it('honors gateway.port over channels and CLI over gateway, via real config file', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { resolveListenPort } = await import('../src/cli/daemon.js');
    // 夹具基于 canonical example（engine schema 要求 agents/models 必填，最小配置会校验失败回退）
    const example = JSON.parse(
      readFileSync(new URL('../octopi.example.json', import.meta.url), 'utf-8'),
    ) as { channels: Array<{ type: string; port?: number }> };
    const exampleHttpPort = example.channels.find((c) => c.type === 'http')?.port;
    const dir = mkdtempSync(join(tmpdir(), 'octopi-listen-'));
    try {
      const withGateway = join(dir, 'with-gateway.json');
      writeFileSync(withGateway, JSON.stringify({ ...example, gateway: { port: 8787 } }));
      expect(resolveListenPort({}, withGateway)).toBe(8787);
      expect(resolveListenPort({ port: 9000 }, withGateway)).toBe(9000);

      const channelsOnly = join(dir, 'channels-only.json');
      writeFileSync(channelsOnly, JSON.stringify({ ...example, gateway: undefined }));
      expect(resolveListenPort({}, channelsOnly)).toBe(exampleHttpPort);
      expect(resolveListenPort({}, join(dir, 'missing.json'))).toBe(18180);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
