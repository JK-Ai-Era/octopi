/**
 * 错误卡分类回归（批 2-3 / §5d）：classifyProviderError 四类人话映射 ——
 * auth/network/model → user-action 级 + 出路；context → 压缩指引；
 * 其余 → support 级 + 诊断 ID + raw 折叠（不默认甩）。
 */

import { describe, expect, it } from 'vitest';
import { classifyProviderError, makeDiagnosticId } from '../packages/webui/src/components/error-classify';

describe('classifyProviderError', () => {
  it('auth 错误 → user-action + 去设置出路', () => {
    const e = classifyProviderError('401 Unauthorized: invalid api key', () => {});
    expect(e.level).toBe('user-action');
    expect(e.title).toContain('密钥');
    expect(e.action?.label).toBe('去设置');
    expect(e.raw).toBeUndefined(); // user-action 级不带 raw
  });

  it('network 错误 → user-action + 连不上模型服务', () => {
    const e = classifyProviderError('fetch failed: ECONNREFUSED 127.0.0.1:11434');
    expect(e.level).toBe('user-action');
    expect(e.title).toContain('连不上');
  });

  it('model 错误 → user-action + 换模型指引', () => {
    const e = classifyProviderError('model "qwen9" not found');
    expect(e.level).toBe('user-action');
    expect(e.title).toContain('模型');
  });

  it('context 超限 → user-action + 压缩指引', () => {
    const e = classifyProviderError('context length exceeded maximum');
    expect(e.level).toBe('user-action');
    expect(e.detail).toContain('压缩');
  });

  it('未知错误 → support 级 + 诊断 ID + raw 保留（折叠不默认展示）', () => {
    const e = classifyProviderError('upstream exploded: boom');
    expect(e.level).toBe('support');
    expect(e.diagnosticId).toMatch(/^diag-/);
    expect(e.raw).toBe('upstream exploded: boom');
    expect(e.action).toBeUndefined();
  });

  it('诊断 ID 形态稳定（diag- 前缀、可复制）', () => {
    expect(makeDiagnosticId()).toMatch(/^diag-[a-z0-9]+-[a-z0-9]+$/);
  });
});
