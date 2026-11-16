import { describe, expect, it } from 'vitest';
import {
  classifyErrorKind,
  probeErrorCopy,
  runtimeErrorCopy,
} from '../packages/engine/src/config-admin/error-copy.js';

describe('错误分类与文案单源（批 3-2 四份单源化）', () => {
  it('classifyErrorKind：五类码全覆盖（含 context 与 server 兜底）', () => {
    expect(classifyErrorKind('401 unauthorized')).toBe('auth');
    expect(classifyErrorKind('ECONNREFUSED')).toBe('network');
    expect(classifyErrorKind('getaddrinfo ENOTFOUND')).toBe('network');
    expect(classifyErrorKind('model gpt-x not found')).toBe('model');
    expect(classifyErrorKind('context length exceeded maximum')).toBe('context');
    expect(classifyErrorKind('something exploded')).toBe('server');
  });

  it('文案表：双语非空；probe 语境无 context（探针不会上下文超限）', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const kind of ['auth', 'network', 'model', 'context', 'server'] as const) {
        const copy = runtimeErrorCopy(kind, lang);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.detail.length).toBeGreaterThan(0);
      }
      for (const kind of ['auth', 'network', 'model', 'server'] as const) {
        const copy = probeErrorCopy(kind, lang);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('probe 与 run 语境分表（同码不同语境文案：向导有「上一步」，对话流有「设置」）', () => {
    const probe = probeErrorCopy('auth', 'zh');
    const runtime = runtimeErrorCopy('auth', 'zh');
    expect(probe.title).not.toBe(runtime.title);
  });
});
