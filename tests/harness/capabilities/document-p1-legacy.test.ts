/**
 * DocumentPort P1 — soffice 老格式闸门（探测 / 无二进制失败语义）
 */
import { describe, expect, it } from 'vitest';
import {
  createDefaultDocumentPort,
  createLegacyConverterFromConfig,
  createSofficeLegacyConverter,
  isDocumentExtractError,
  probeSoffice,
} from '../../../packages/engine/src/harness/capabilities/document/index.js';

describe('soffice legacy converter', () => {
  it('factory: none → null; soffice → converter', () => {
    expect(createLegacyConverterFromConfig({ converter: 'none' })).toBeNull();
    expect(createLegacyConverterFromConfig({})).toBeNull();
    const c = createLegacyConverterFromConfig({ converter: 'soffice' });
    expect(c?.id).toBe('soffice');
  });

  it('probe missing binary returns false (no throw)', async () => {
    expect(await probeSoffice('octopi-soffice-not-exist-binary')).toBe(false);
    const conv = createSofficeLegacyConverter({ sofficePath: 'octopi-soffice-not-exist-binary' });
    expect(await conv.isAvailable()).toBe(false);
  });

  it('extract legacy doc without available converter → UNSUPPORTED_LEGACY', async () => {
    const conv = createSofficeLegacyConverter({ sofficePath: 'octopi-soffice-not-exist-binary' });
    const port = createDefaultDocumentPort({
      backends: [],
      legacyConverter: conv,
    });
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    try {
      await port.extract({ data: ole, name: 'old.doc', formatHint: 'doc' });
      expect.unreachable('should throw');
    } catch (e) {
      expect(isDocumentExtractError(e)).toBe(true);
      expect((e as { code: string }).code).toBe('UNSUPPORTED_LEGACY');
    }
  });

  it('capabilities marks legacy via-converter when probe succeeds is false', async () => {
    const conv = createSofficeLegacyConverter({ sofficePath: 'octopi-soffice-not-exist-binary' });
    const port = createDefaultDocumentPort({ backends: [], legacyConverter: conv });
    const caps = await port.capabilities();
    expect(caps.formats.doc.level).toBe('none');
    expect(caps.legacyConverter).toBe('none');
  });
});
