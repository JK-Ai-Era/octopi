/**
 * BoundaryValidator 测试
 *
 * 测试 act.mode 与 boundary.authority 的交叉校验，
 * 以及 condition / conditionRef 互斥等规则。
 */

import { describe, it, expect } from 'vitest';
import { validateSubsystemSpec } from '../../src/harness/autonomous-subsystem/boundary/validator.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

/**
 * 构建最小合法的 SubsystemSpec
 */
function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'test-subsystem',
    name: 'Test Subsystem',
    description: 'A test subsystem',
    sense: {
      source: 'eventBus',
      isolation: 'structured',
    },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async () => ({ signals: [{ action: 'no-op', reason: 'test' }] }),
    },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

describe('validateSubsystemSpec', () => {
  describe('act.mode 与 boundary.authority 交叉校验', () => {
    it('observe + none → 通过', () => {
      const spec = makeSpec({
        boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
        act: { mode: 'none' },
      });
      expect(validateSubsystemSpec(spec)).toHaveLength(0);
    });

    it('observe + block → 失败', () => {
      const spec = makeSpec({
        boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
        act: { mode: 'block' },
      });
      const errors = validateSubsystemSpec(spec);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('act.mode');
      expect(errors[0].message).toContain('observe');
      expect(errors[0].message).toContain('block');
    });

    it('suggest + modify → 失败', () => {
      const spec = makeSpec({
        boundary: { visibility: 'structured', authority: 'suggest', security: 'sandboxed' },
        act: { mode: 'modify' },
      });
      const errors = validateSubsystemSpec(spec);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('act.mode');
    });

    it('act + block → 通过', () => {
      const spec = makeSpec({
        boundary: { visibility: 'structured', authority: 'act', security: 'sandboxed' },
        act: { mode: 'block' },
      });
      expect(validateSubsystemSpec(spec)).toHaveLength(0);
    });

    it('act + inject → 通过', () => {
      const spec = makeSpec({
        boundary: { visibility: 'structured', authority: 'act', security: 'sandboxed' },
        act: { mode: 'inject' },
      });
      expect(validateSubsystemSpec(spec)).toHaveLength(0);
    });

    it('override + block → 通过', () => {
      const spec = makeSpec({
        boundary: { visibility: 'full', authority: 'override', security: 'privileged' },
        act: { mode: 'block' },
      });
      expect(validateSubsystemSpec(spec)).toHaveLength(0);
    });
  });

  describe('condition 与 conditionRef 互斥', () => {
    it('同时配置 → 失败', () => {
      const spec = makeSpec({
        sense: {
          source: 'eventBus',
          filter: {
            events: ['test.event'],
            condition: 'turn.count > 0',
            conditionRef: './handler.ts:check',
          },
          isolation: 'structured',
        },
      });
      const errors = validateSubsystemSpec(spec);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('sense.filter');
      expect(errors[0].message).toContain('mutually exclusive');
    });

    '只配置 condition → 通过',
    () => {
      const spec = makeSpec({
        sense: {
          source: 'eventBus',
          filter: { events: ['test.event'], condition: 'turn.count > 0' },
          isolation: 'structured',
        },
      });
      expect(validateSubsystemSpec(spec)).toHaveLength(0);
    };
  });

  describe('think.implementation 校验', () => {
    it('code 模式无 handler → 失败', () => {
      const spec = makeSpec({
        think: {
          strategy: 'deterministic',
          implementation: 'code',
          // handler 缺失
        },
      });
      const errors = validateSubsystemSpec(spec);
      expect(errors.some((e) => e.field === 'think.handler')).toBe(true);
    });

    it('llm 模式无 systemPrompt → 失败', () => {
      const spec = makeSpec({
        think: {
          strategy: 'heuristic',
          implementation: 'llm',
          model: 'mini',
          // systemPrompt 缺失
        },
      });
      const errors = validateSubsystemSpec(spec);
      expect(errors.some((e) => e.field === 'think.systemPrompt')).toBe(true);
    });

    it('hybrid 模式无 preProcess 和 postProcess → 失败', () => {
      const spec = makeSpec({
        think: {
          strategy: 'heuristic',
          implementation: 'hybrid',
          systemPrompt: 'test',
          model: 'mini',
          // preProcess 和 postProcess 都缺失
        },
      });
      const errors = validateSubsystemSpec(spec);
      expect(errors.some((e) => e.field === 'think')).toBe(true);
    });

    it('hybrid 模式有 preProcess → 通过', () => {
      const spec = makeSpec({
        think: {
          strategy: 'heuristic',
          implementation: 'hybrid',
          systemPrompt: 'test',
          model: 'mini',
          preProcess: async (input) => input,
        },
      });
      // 需要 authority=act 因为默认 act=none
      expect(validateSubsystemSpec(spec)).toHaveLength(0);
    });
  });

  describe('tools 校验', () => {
    it('subset 模式无 names → 失败', () => {
      const spec = makeSpec({
        tools: { mode: 'subset' },
      });
      const errors = validateSubsystemSpec(spec);
      expect(errors.some((e) => e.field === 'tools.names')).toBe(true);
    });

    it('custom 模式无 definitions → 失败', () => {
      const spec = makeSpec({
        tools: { mode: 'custom' },
      });
      const errors = validateSubsystemSpec(spec);
      expect(errors.some((e) => e.field === 'tools.definitions')).toBe(true);
    });
  });

  describe('完整合法 spec', () => {
    it('最小合法 spec → 零错误', () => {
      const spec = makeSpec();
      expect(validateSubsystemSpec(spec)).toHaveLength(0);
    });

    it('LLM 子系统完整合法 spec → 零错误', () => {
      const spec = makeSpec({
        sense: {
          source: 'eventBus',
          filter: { events: ['iteration.end'], condition: 'turn.count % 10 === 0' },
          isolation: 'structured',
        },
        think: {
          strategy: 'heuristic',
          implementation: 'llm',
          systemPrompt: 'You are a memory extractor.',
          model: 'mini',
          maxIterations: 1,
        },
        act: { mode: 'none' },
        signal: { severity: 'advisory', channel: ['event'] },
        boundary: { visibility: 'structured', authority: 'suggest', security: 'sandboxed' },
        tools: { mode: 'none' },
        session: { mode: 'persistent', scope: 'agent', ttl: '24h' },
        lifecycle: { maxDurationMs: 30000, maxConcurrent: 1, degradeOn: 'timeout' },
      });
      expect(validateSubsystemSpec(spec)).toHaveLength(0);
    });
  });
});
