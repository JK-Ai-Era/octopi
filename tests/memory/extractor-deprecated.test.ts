/**
 * memory-extractor 已移除 — 旧工厂路径的兼容垫片已不存在。
 * 见 docs/memory.md（Memory Steward 取代 ETL 提取主路径）。
 */

describe('memory extractor removal', () => {
  it('statistical extractCandidates no longer produced by redesign path', async () => {
    const { InMemoryMemoryStore } = await import('../../src/harness/memory/store.js');
    const { evaluateGates } = await import('../../src/harness/memory/gates.js');
    const store = new InMemoryMemoryStore();
    const junk = '用户在会话中明确表达/确认了 3 条约束或偏好';
    const gate = evaluateGates({
      type: 'norm',
      proposition: junk,
      evidence: 'evt',
      channel: 'model_inference',
    });
    expect(gate.ok).toBe(false);
    // 不得通过 store 路径入库（门控在工具层）
    const found = await store.retrieve({ text: '约束', includeShadow: true });
    expect(found).toHaveLength(0);
  });
});
