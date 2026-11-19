/**
 * B-1 — init 脚手架默认生成随机 apiKey（secure-by-default）。
 */
import { describe, expect, it } from 'vitest';

interface Scaffolded {
  channels?: Array<{ type: string; apiKey?: string }>;
  effectPolicy?: { mode?: string };
}

describe('generateDefaultConfig — 默认随机 apiKey', () => {
  it('两次生成的 apiKey 不同、长度 ≥32、写入 http 通道', async () => {
    const { generateDefaultConfig } = await import('../src/init.js');
    const a = generateDefaultConfig('/tmp/octopi-a') as Scaffolded;
    const b = generateDefaultConfig('/tmp/octopi-b') as Scaffolded;
    const httpA = a.channels?.find((c) => c.type === 'http');
    const httpB = b.channels?.find((c) => c.type === 'http');
    expect(httpA?.apiKey).toBeTruthy();
    expect((httpA?.apiKey ?? '').length).toBeGreaterThanOrEqual(32);
    expect(httpA?.apiKey).not.toBe(httpB?.apiKey);
  });
});

describe('generateDefaultConfig — effectPolicy.mode', () => {
  it('init 缺省 project（编码 agent 档）；全机 host 由用户显式改', async () => {
    const { generateDefaultConfig } = await import('../src/init.js');
    const cfg = generateDefaultConfig('/tmp/octopi-c') as Scaffolded;
    expect(cfg.effectPolicy?.mode).toBe('project');
  });
});
