// @vitest-environment jsdom
/**
 * ContextRuntimePanel — 压缩进行中「已等待 Ns」必须走秒（M-5，2026-11-07 评审）。
 *
 * 事故形态：provider 静默期没有任何新事件 → React 不重渲染 → elapsed 冻结在 0s，
 * 用户无法判断时间在流逝。修复 = compact.active 期间挂 1s tick 强制刷新。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { ContextRuntimePanel } from './ContextRuntimePanel';
import type { InspectorState } from '@octopi-agent/gateway/web/runtime/store';

function inspectorWithCompact(startedAt: number): InspectorState {
  return {
    compact: {
      active: true,
      reason: 'proactive',
      phase: 'summarize',
      requestChars: 2_130_000,
      timeoutMs: 300_000,
      startedAt,
    },
  } as unknown as InspectorState;
}

function renderPanel(inspector: InspectorState) {
  return render(
    <ContextRuntimePanel
      inspector={inspector}
      viewMode="context"
      runStatus="waiting"
      sessionId="s1"
      agentId="a1"
      connection="connected"
    />,
  );
}

/** 取当前渲染的「已等待 Ns」数字（compactText 渲染在多个槽位，取第一个）；不存在返回 undefined */
function elapsedOnScreen(): number | undefined {
  const nodes = screen.getAllByText(/已等待 \d+s/);
  const m = nodes[0]?.textContent?.match(/已等待 (\d+)s/);
  return m ? Number(m[1]) : undefined;
}

describe('ContextRuntimePanel 压缩 elapsed tick', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('compact.active 期间「已等待 Ns」随秒推进（fake timers）', () => {
    vi.useFakeTimers();
    const startedAt = Date.now() - 3000;
    renderPanel(inspectorWithCompact(startedAt));

    const t0 = elapsedOnScreen();
    expect(t0).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const t1 = elapsedOnScreen();
    expect(t1, '1s tick 必须驱动数字走秒').toBe(t0! + 2);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(elapsedOnScreen()).toBe(t1! + 1);
  });

  it('compact 不活跃时无 tick 文本（不泄漏「进行中」）', () => {
    vi.useFakeTimers();
    const inspector = {
      compact: { active: false, error: 'summarize_timeout:300000ms' },
    } as unknown as InspectorState;
    renderPanel(inspector);
    expect(screen.queryByText(/已等待/)).toBeNull();
  });
});
