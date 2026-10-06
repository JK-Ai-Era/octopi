/**
 * GatewayKnowledgeRuntime：manageLocal 拉起 + disabled 语义
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayKnowledgeRuntime } from '@octopi-agent/gateway/gateway/knowledge-runtime.js';

describe('GatewayKnowledgeRuntime', () => {
  it('未配置且 manageLocal=false → disabled', async () => {
    const rt = new GatewayKnowledgeRuntime();
    await rt.start({ manageLocal: false }, { dataDir: await mkdtemp(join(tmpdir(), 'kn-rt-')) });
    expect(rt.state).toBe('disabled');
    expect(rt.knowledgeClient).toBeNull();
  });

  it('manageLocal 缺省 true → ready + client', async () => {
    const rt = new GatewayKnowledgeRuntime();
    const dir = await mkdtemp(join(tmpdir(), 'kn-rt2-'));
    // 测试用临时端口，避免与真实 18280 实例冲突
    await rt.start({ manageLocal: true, port: 0 }, { dataDir: dir, gatewayId: 'gw-test' });
    expect(rt.state).toBe('ready');
    expect(rt.knowledgeClient).toBeTruthy();
    const h = await rt.knowledgeClient!.health();
    expect(h.ok).toBe(true);
    await rt.stop();
    expect(rt.state).toBe('disabled');
  });
});
