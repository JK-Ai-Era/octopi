/**
 * 本机 / 局域网监听 host 配置解析
 */

import { describe, test, expect } from 'vitest';
import {
  resolveListenHost,
  resolveViteHostArg,
  isLanHost,
} from '../src/config.js';
import { ChannelConfigSchema, HarnessConfigSchema } from '../src/config-schema.js';
import { resolveViteLaunch } from '../src/cli/process-utils.js';

describe('resolveListenHost', () => {
  test('defaults to loopback', () => {
    expect(resolveListenHost(undefined)).toBe('127.0.0.1');
    expect(resolveListenHost('local')).toBe('127.0.0.1');
  });

  test('lan binds all interfaces', () => {
    expect(resolveListenHost('lan')).toBe('0.0.0.0');
  });

  test('explicit address is passed through', () => {
    expect(resolveListenHost('192.168.1.5')).toBe('192.168.1.5');
  });
});

describe('resolveViteHostArg', () => {
  test('defaults to localhost', () => {
    expect(resolveViteHostArg(undefined)).toBe('localhost');
    expect(resolveViteHostArg('local')).toBe('localhost');
  });

  test('lan maps to 0.0.0.0', () => {
    expect(resolveViteHostArg('lan')).toBe('0.0.0.0');
  });

  test('explicit address is passed through', () => {
    expect(resolveViteHostArg('10.0.0.2')).toBe('10.0.0.2');
  });
});

describe('isLanHost', () => {
  test('local is not lan', () => {
    expect(isLanHost(undefined)).toBe(false);
    expect(isLanHost('local')).toBe(false);
    expect(isLanHost('localhost')).toBe(false);
    expect(isLanHost('127.0.0.1')).toBe(false);
    expect(isLanHost('::1')).toBe(false);
  });

  test('lan / non-loopback is lan', () => {
    expect(isLanHost('lan')).toBe(true);
    expect(isLanHost('0.0.0.0')).toBe(true);
    expect(isLanHost('192.168.1.5')).toBe(true);
  });
});

describe('config schema host field', () => {
  test('accepts local / lan / custom host on channel', () => {
    expect(ChannelConfigSchema.parse({ type: 'http', host: 'local' }).host).toBe('local');
    expect(ChannelConfigSchema.parse({ type: 'http', host: 'lan' }).host).toBe('lan');
    expect(ChannelConfigSchema.parse({ type: 'http', host: '192.168.0.1' }).host).toBe('192.168.0.1');
  });

  test('accepts host on web block', () => {
    const parsed = HarnessConfigSchema.parse({
      agents: [{ id: 'a', model: 'openai/m' }],
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'k',
            api: 'openai-completions',
            models: [{ id: 'm', name: 'm' }],
          },
        },
      },
      web: { dir: './web', host: 'lan' },
    });
    expect(parsed.web?.host).toBe('lan');
  });
});

describe('resolveViteLaunch host arg', () => {
  test('returns null without vite install (no throw)', () => {
    expect(resolveViteLaunch('/definitely/missing/web-dir', { hostArg: '0.0.0.0' })).toBeNull();
  });
});
