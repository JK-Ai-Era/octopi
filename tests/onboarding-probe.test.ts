/**
 * 探针鉴权头回归（评审 B1）：probeProvider 必须把展开后的真 key 放进
 * Authorization，绝不能把 `${VAR}` 字面量发出去（曾导致非 Ollama 路径恒 401）。
 * 起本地假 HTTP 端点断言请求头——真实 provider 链路，无 seam。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeProvider } from '../src/cli/wizard/onboarding.js';
import type { OnboardingChoices } from '../packages/engine/src/config-admin/onboarding.js';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function baseChoices(overrides: Partial<OnboardingChoices> = {}): OnboardingChoices {
  return {
    lang: 'zh',
    initMode: 'cli',
    deploymentMode: 'personal',
    providerId: 'custom',
    providerOverrides: { baseUrl: '' }, // 由各用例填
    apiKey: 'sk-real-secret-123',
    modelId: 'test-model',
    ...overrides,
  };
}

describe('probeProvider 鉴权头（B1 回归）', () => {
  it('Authorization 带真 key、不含 ${ 占位符字面量', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as AddressInfo).port;

    const outcome = await probeProvider(
      baseChoices({ providerOverrides: { baseUrl: `http://127.0.0.1:${port}/v1` } }),
    );

    expect(outcome).toBe('ok'); // 假端点 200 → 探针通过
    expect(seen.length).toBeGreaterThan(0);
    const auth = seen[0].auth ?? '';
    expect(auth).toBe('Bearer sk-real-secret-123');
    expect(auth).not.toContain('${'); // B1 病灶判据
  });

  it('连接失败不误判为 auth（isAvailable 折叠异常为 false；四类归并锚在 classifyProbeError 单测）', async () => {
    const outcome = await probeProvider(
      baseChoices({ providerOverrides: { baseUrl: 'http://127.0.0.1:1/v1' } }),
    );
    expect(['network', 'server']).toContain(outcome);
  });
});
