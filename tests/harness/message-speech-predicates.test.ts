/**
 * 双谓词拆分（2026-10-24 拍板）：wake「开轮但不是人话」。
 *
 * - isTurnAnchor = turn 边界类消费方（isMidTurn / compact / tool-result-aging）
 * - isHumanSpeech = 人类文本类消费方（title / grounding / backfill）
 */

import { describe, it, expect } from 'vitest';
import {
  isTurnAnchor,
  isHumanSpeech,
  isTurnBoundaryAnchor,
} from '@octopi-agent/engine/harness/context/layer-types.js';

const user = (metadata?: Record<string, unknown>) => ({ role: 'user', metadata });

describe('message speech predicates（isTurnAnchor / isHumanSpeech）', () => {
  it('真人裸输入：既是轮次锚点也是人话', () => {
    expect(isTurnAnchor(user())).toBe(true);
    expect(isHumanSpeech(user())).toBe(true);
  });

  it('activation wake（source:runtime）：开轮但不是人话', () => {
    const wake = user({ source: 'runtime' });
    expect(isTurnAnchor(wake)).toBe(true);
    expect(isHumanSpeech(wake)).toBe(false);
  });

  it('schedule notify 便签（delivery:notify）：不开轮也不是人话', () => {
    const note = user({ source: 'runtime', delivery: 'notify' });
    expect(isTurnAnchor(note)).toBe(false);
    expect(isHumanSpeech(note)).toBe(false);
  });

  it('引擎载体（turn 闭标等）：不开轮也不是人话', () => {
    const carrier = user({ source: 'turnEnd' });
    expect(isTurnAnchor(carrier)).toBe(false);
    expect(isHumanSpeech(carrier)).toBe(false);
  });

  it('assistant 消息：一律 false', () => {
    expect(isTurnAnchor({ role: 'assistant' })).toBe(false);
    expect(isHumanSpeech({ role: 'assistant' })).toBe(false);
  });
});

describe('isTurnBoundaryAnchor（边界类共用锚点：isTurnAnchor 基础上剔 agentId 归因）', () => {
  it('真人裸输入与 wake：是边界锚点', () => {
    expect(isTurnBoundaryAnchor(user())).toBe(true);
    expect(isTurnBoundaryAnchor(user({ source: 'runtime' }))).toBe(true);
  });

  it('agentId 归因 user（appendCommandDiscourse 命令话语）：不是边界锚点', () => {
    // isTurnAnchor 认它是 user 输入，但边界类消费方不得被它推进（2026-11-20 收敛）
    const cmdUser = { role: 'user', agentId: 'a1', metadata: { kind: 'command' } as Record<string, unknown> };
    expect(isTurnAnchor(cmdUser)).toBe(true);
    expect(isTurnBoundaryAnchor(cmdUser)).toBe(false);
  });

  it('引擎载体 / schedule notify / assistant：不是边界锚点', () => {
    expect(isTurnBoundaryAnchor(user({ source: 'engineHint' }))).toBe(false);
    expect(isTurnBoundaryAnchor(user({ source: 'runtime', delivery: 'notify' }))).toBe(false);
    expect(isTurnBoundaryAnchor({ role: 'assistant' })).toBe(false);
  });
});
