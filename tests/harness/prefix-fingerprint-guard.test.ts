import { describe, expect, it, vi } from 'vitest';
import { diffPrefixFingerprint, fingerprintRequestView } from '@octopi-agent/engine/harness/context/prefix-fingerprint.js';

/**
 * 前缀指纹护栏：摘要请求发出前必须等比「最近一次会话请求」的完整前缀。
 *
 * 2026-11-13 生产事故：tools 与 system 完全相同，只有 messages 半区（老化形态）
 * 分叉，旧护栏只比 toolsHash 因此完全沉默，直到实测发现 1.11M 字符缓存全 miss。
 */

const sys = { role: 'system' as const, content: 'SYSTEM' };
const msg = (c: string) => ({ role: 'user' as const, content: c });

const tools = [{ type: 'function' as const, function: { name: 'file_read', description: 'd', parameters: {} } }];

function view(messages: unknown[], t = tools) {
  return { messages: [sys, ...messages], tools: t } as never;
}

describe('前缀指纹护栏（摘要 vs 会话）', () => {
  it('红线：tools/system 相同、messages 老化形态不同 → 必须报 messages', () => {
    const session = view([msg('[aged] file_read lines 1-31/31 — call file_read for current text')]);
    const summary = view([msg('[aged tool result · pointer] file_read; result 1624 chars')]);
    const diffs = diffPrefixFingerprint(fingerprintRequestView(session), fingerprintRequestView(summary));
    expect(diffs).toEqual(['messages']);
  });

  it('红线：这就是 2026-11-13 事故形状——tools 哈希相同所以旧护栏沉默', () => {
    const session = view([msg('per-tool ager shape')]);
    const summary = view([msg('default pointer shape')]);
    const a = fingerprintRequestView(session);
    const b = fingerprintRequestView(summary);
    expect(a.toolsHash).toBe(b.toolsHash); // 旧护栏只看这个 → 通过
    expect(a.systemHash).toBe(b.systemHash);
    expect(a.prefixHash).not.toBe(b.prefixHash); // 新护栏看到差异
  });

  it('同形前缀 → 无差异（不得误报）', () => {
    const a = view([msg('same'), msg('same2')]);
    const b = view([msg('same'), msg('same2')]);
    expect(diffPrefixFingerprint(fingerprintRequestView(a), fingerprintRequestView(b))).toEqual([]);
  });

  it('tools 不同优先报 tools，且不重复报 messages', () => {
    const a = view([msg('x')]);
    const b = view([msg('x')], [] as never);
    expect(diffPrefixFingerprint(fingerprintRequestView(a), fingerprintRequestView(b))).toEqual(['tools']);
  });

    it('system 不同报 system，且不重复报 messages', () => {
    const a = view([msg('x')]);
    const b = { messages: [{ role: 'system', content: 'OTHER' }, msg('x')], tools } as never;
    expect(diffPrefixFingerprint(fingerprintRequestView(a), fingerprintRequestView(b))).toEqual(['system']);
  });

  it('尾部差异不算前缀差异（tailLength 排除尾部指令）', () => {
    const a = view([msg('prefix-part'), msg('TAIL-A')]);
    const b = view([msg('prefix-part'), msg('TAIL-B')]);
    const fa = fingerprintRequestView(a, { tailLength: 1 });
    const fb = fingerprintRequestView(b, { tailLength: 1 });
    expect(diffPrefixFingerprint(fa, fb)).toEqual([]);
  });

  it('指纹稳定：同输入重复计算逐字节相同', () => {
    const v = view([msg('a'), msg('b')]);
    expect(fingerprintRequestView(v).prefixHash).toBe(fingerprintRequestView(view([msg('a'), msg('b')])).prefixHash);
  });

  it('非空前缀计数如实反映消息数', () => {
    expect(fingerprintRequestView(view([msg('a'), msg('b')])).prefixCount).toBe(3); // system + 2
  });
});
