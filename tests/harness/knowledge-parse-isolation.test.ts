/**
 * 解析链路进程/线程隔离 — 文本 worker / Knowledge 独立子进程 / DocumentPort worker
 *
 * 回归：Gateway 不得与 Knowledge 共进程；CPU 密集步骤不得占事件循环。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTextInWorker } from '../../packages/engine/src/harness/knowledge/parse-text-in-worker.js';
import { startKnowledgeServiceProcess } from '../../packages/engine/src/harness/knowledge/start-service-process.js';
import { createWorkerDocumentPort } from '../../packages/engine/src/harness/capabilities/document/worker-port.js';
import { markdownAdapter, textAdapter } from '../../packages/engine/src/harness/knowledge/adapters.js';
import { buildFtsTokens } from '../../packages/engine/src/harness/knowledge/fts.js';

describe('parse isolation (workers / child process)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-parse-iso-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parseTextInWorker 与主线程 adapter.chunk 结果一致，且预计算 ftsToks', async () => {
    const body = [
      '# Title',
      '',
      '段落一：知识服务拆分。',
      '',
      '段落二：File 本位防重。',
      '',
      'function hello() { return 1; }',
    ].join('\n');
    const p = join(dir, 'sample.md');
    await writeFile(p, body, 'utf8');

    const parsed = await parseTextInWorker(p, { sizeDecision: 'ok' });
    const expected = markdownAdapter.chunk(body, p);
    expect(parsed.adapterId).toBe('markdown');
    expect(parsed.chunks.map((c) => c.text)).toEqual(expected.map((c) => c.text));
    expect(parsed.chunks.length).toBeGreaterThan(0);
    for (const c of parsed.chunks) {
      expect(c.ftsToks).toBe(buildFtsTokens(c.text, p));
    }
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('parseTextInWorker partial 截断', async () => {
    const body = 'x'.repeat(5000);
    const p = join(dir, 'big.txt');
    await writeFile(p, body, 'utf8');
    const parsed = await parseTextInWorker(p, {
      sizeDecision: 'partial',
      maxTextChars: 100,
    });
    expect(parsed.chunks[0]?.text).toContain('truncated:');
    expect(parsed.contentLength).toBe(5000);
  });

  it('textAdapter 大段无空行不炸且可切', () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `line-${i}-padding-padding`).join('\n');
    const chunks = textAdapter.chunk(body, 'a.txt');
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((c) => c.text.length <= 2400)).toBe(true);
  });

  it('startKnowledgeServiceProcess 独立子进程监听并 /health 可达', async () => {
    const dbPath = join(dir, 'knowledge.db');
    const handle = await startKnowledgeServiceProcess({
      dbPath,
      port: 0,
      tokens: [{ token: 'test-token', tenantId: 'default', gatewayId: 'gw-test' }],
    });
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.child.pid).toBeGreaterThan(0);
      expect(handle.child.pid).not.toBe(process.pid);
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(res.ok).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('createWorkerDocumentPort 可抽纯文本', async () => {
    const p = join(dir, 'doc.txt');
    await writeFile(p, 'hello worker port', 'utf8');
    const port = createWorkerDocumentPort({ documentConfig: null });
    const result = await port.extract({ path: p, name: p });
    expect(result.markdown).toContain('hello worker port');
    expect(result.backend).toBeTruthy();
  });
});
