/**
 * documents.extract.backend 档位路由 — per-call ExtractOptions.tier > 部署缺省 > auto
 *
 * 防回归背景：`extract.backend`（auto|t0-only）自 27a0993 起仅声明未接线；
 * v0.98.11 把它接到 DocumentPort 的 tierOrder 部署缺省（t0-only = 钉死本地抽取，
 * 内容不外发增强/云档）。
 */
import { describe, it, expect } from 'vitest';
import { createDefaultDocumentPort } from '@octopi-agent/engine/harness/capabilities/document/port.js';
import type {
  DocumentExtractBackend,
  DocumentFormatHint,
  ExtractResult,
} from '@octopi-agent/engine/harness/capabilities/document/types.js';

function fakeBackend(
  id: string,
  tier: 't0' | 't1' | 't2',
  formats: DocumentFormatHint[] = ['pdf'],
): DocumentExtractBackend {
  return {
    id,
    tier,
    formats,
    async isAvailable() {
      return true;
    },
    accepts({ format }) {
      return formats.includes(format);
    },
    async extract(): Promise<ExtractResult> {
      return {
        markdown: `via-${id}`,
        meta: { format: 'pdf' },
        warnings: [],
        backend: id,
      };
    },
  };
}

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

describe('documents.extract.backend tier routing', () => {
  it('auto（缺省）在 t0 不可用时降级 t1', async () => {
    const port = createDefaultDocumentPort({ backends: [fakeBackend('t1-ext', 't1')] });
    const res = await port.extract({ data: pdfBytes, formatHint: 'pdf' });
    expect(res.backend).toBe('t1-ext');
  });

  it('t0-only 钉死本地档：只有 t1 后端时直接不支持（内容不外发）', async () => {
    const port = createDefaultDocumentPort({
      config: { backend: 't0-only' },
      backends: [fakeBackend('t1-ext', 't1')],
    });
    await expect(port.extract({ data: pdfBytes, formatHint: 'pdf' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  it('per-call tier 覆盖部署缺省', async () => {
    const port = createDefaultDocumentPort({
      config: { backend: 't0-only' },
      backends: [fakeBackend('t0-local', 't0'), fakeBackend('t1-ext', 't1')],
    });
    // 显式 tier='t1' 无视 t0-only 缺省
    const res = await port.extract({ data: pdfBytes, formatHint: 'pdf' }, { tier: 't1' });
    expect(res.backend).toBe('t1-ext');
  });

  it('t0-only 有 t0 后端时正常本地抽取', async () => {
    const port = createDefaultDocumentPort({
      config: { backend: 't0-only' },
      backends: [fakeBackend('t0-local', 't0'), fakeBackend('t1-ext', 't1')],
    });
    const res = await port.extract({ data: pdfBytes, formatHint: 'pdf' });
    expect(res.backend).toBe('t0-local');
    expect(res.degraded).toBeUndefined();
  });
});
