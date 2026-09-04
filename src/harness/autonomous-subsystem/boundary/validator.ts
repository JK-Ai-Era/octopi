/**
 * Autonomous Subsystem — Boundary Validator
 *
 * 校验 SubsystemSpec 的 boundary 与 act 配置一致性。
 *
 * @module autonomous-subsystem/boundary/validator
 */

import type { AuthorityLevel, ActMode, SubsystemSpec } from '../types.js';

/**
 * authority 允许的 act.mode 集合
 */
const AUTHORITY_ACT_MAP: Record<AuthorityLevel, Set<ActMode>> = {
  observe: new Set(['none']),
  suggest: new Set(['none']),
  act: new Set(['block', 'modify', 'inject', 'none']),
  override: new Set(['block', 'modify', 'inject', 'none']),
};

/**
 * 校验错误
 */
export interface ValidationError {
  /** 错误字段路径 */
  field: string;
  /** 错误描述 */
  message: string;
}

/**
 * 校验 SubsystemSpec 的内部一致性
 *
 * @param spec - 子系统规格
 * @returns 校验错误数组，空数组表示通过
 */
export function validateSubsystemSpec(spec: SubsystemSpec): ValidationError[] {
  const errors: ValidationError[] = [];

  // ── act.mode 与 boundary.authority 交叉校验 ──
  const allowedModes = AUTHORITY_ACT_MAP[spec.boundary.authority];
  if (!allowedModes.has(spec.act.mode)) {
    errors.push({
      field: 'act.mode',
      message: `authority "${spec.boundary.authority}" does not allow act.mode "${spec.act.mode}". Allowed: ${Array.from(allowedModes).join(', ')}`,
    });
  }

  // ── condition 与 conditionRef 互斥 ──
  if (spec.sense.filter?.condition && spec.sense.filter?.conditionRef) {
    errors.push({
      field: 'sense.filter',
      message: 'condition and conditionRef are mutually exclusive',
    });
  }

  // ── act.mode 非 none 时，信号通道不能只有 escalate ──
  // （如果 act 已经直接行动了，escalate 应该配合其他通道一起用）
  // 这是一个软警告，不阻止注册
  // if (spec.act.mode !== 'none' && spec.signal.channel.length === 1 && spec.signal.channel[0] === 'escalate') {
  //   errors.push({ field: 'signal.channel', message: '...' });
  // }

  // ── think.implementation=code 时必须有 handler ──
  if (spec.think.implementation === 'code' && !spec.think.handler) {
    errors.push({
      field: 'think.handler',
      message: 'think.implementation "code" requires a handler function',
    });
  }

  // ── think.implementation=llm/hybrid 时必须有 systemPrompt ──
  if (
    (spec.think.implementation === 'llm' || spec.think.implementation === 'hybrid') &&
    !spec.think.systemPrompt
  ) {
    errors.push({
      field: 'think.systemPrompt',
      message: `think.implementation "${spec.think.implementation}" requires a systemPrompt`,
    });
  }

  // ── hybrid 模式必须有 preProcess 或 postProcess 至少一个 ──
  if (spec.think.implementation === 'hybrid' && !spec.think.preProcess && !spec.think.postProcess) {
    errors.push({
      field: 'think',
      message: 'think.implementation "hybrid" requires at least one of preProcess or postProcess',
    });
  }

  // ── tools.mode=subset 时必须有 names ──
  if (spec.tools.mode === 'subset' && (!spec.tools.names || spec.tools.names.length === 0)) {
    errors.push({
      field: 'tools.names',
      message: 'tools.mode "subset" requires a non-empty names array',
    });
  }

  // ── tools.mode=custom 时必须有 definitions ──
  if (spec.tools.mode === 'custom' && (!spec.tools.definitions || spec.tools.definitions.length === 0)) {
    errors.push({
      field: 'tools.definitions',
      message: 'tools.mode "custom" requires a non-empty definitions array',
    });
  }

  return errors;
}
