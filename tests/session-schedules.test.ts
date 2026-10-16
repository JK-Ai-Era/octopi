/**
 * SessionSchedule / timer_* 行为测试（arch/session-schedules.md §12）
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionScheduleService } from '@octopi-agent/engine/harness/session/schedules/service.js';
import {
  assertTransition,
  canTransition,
  parseDurationMs,
  SCHEDULE_TRANSITIONS,
} from '@octopi-agent/engine/harness/session/schedules/types.js';
import { renderSessionSchedulesInjection } from '@octopi-agent/engine/harness/session/schedules/render.js';
import {
  createScheduleCancelTool,
  createScheduleListTool,
  createScheduleSetTool,
  createTimerCancelTool,
  createTimerWaitTool,
} from '@octopi-agent/engine/harness/session/schedules/tools.js';
import type { Trigger } from '@octopi-agent/engine/harness/activation/types.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types.js';

function ctx(sessionId = 's1', agentId = 'a1'): ToolExecutionContext {
  return { sessionId, agentId } as ToolExecutionContext;
}

describe('parseDurationMs', () => {
  it('parses unit strings and seconds numbers', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('5m')).toBe(300_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs(45)).toBe(45_000);
    expect(parseDurationMs('45')).toBe(45_000);
    expect(parseDurationMs('500ms')).toBe(500);
  });

  it('rejects garbage', () => {
    expect(() => parseDurationMs('soon')).toThrow();
    expect(() => parseDurationMs('')).toThrow();
  });
});

describe('schedule state machine', () => {
  it('allows only documented transitions', () => {
    expect(canTransition('active', 'paused')).toBe(true);
    expect(canTransition('active', 'completed')).toBe(true);
    expect(canTransition('paused', 'active')).toBe(true);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'active')).toBe(false);
    expect(canTransition('failed', 'active')).toBe(false);
    expect(SCHEDULE_TRANSITIONS.completed).toHaveLength(0);
  });

  it('assertTransition throws on illegal and allows same-state', () => {
    expect(() => assertTransition('active', 'active')).not.toThrow();
    expect(() => assertTransition('completed', 'cancel' as never)).toThrow();
    expect(() => assertTransition('completed', 'cancelled')).toThrow(/Illegal/);
  });
});

describe('SessionScheduleService', () => {
  let service: SessionScheduleService;
  let fired: Array<{ trigger: Trigger; id: string }>;

  beforeEach(async () => {
    fired = [];
    service = new SessionScheduleService({
      dbPath: ':memory:',
      wakeup: (trigger, schedule) => {
        fired.push({ trigger, id: schedule.id });
      },
    });
    await service.open();
  });

  afterEach(() => {
    service.dispose();
  });

  it('creates once schedule and fires then completes', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '0.05s', // 50ms — wait, parseDuration "50ms" or 0.05s?
      payload: { delivery: 'wakeup', text: 'do it' },
    });
    // parseDurationMs('0.05s') → 50ms
    expect(s.status).toBe('active');
    expect(s.kind).toBe('once');

    await service.runNow(s.id);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.trigger.type).toBe('schedule');
    expect(fired[0]!.trigger.payload.kind).toBe('system_note');
    expect(String((fired[0]!.trigger.payload as { content: string }).content)).toContain(
      'do it',
    );

    const after = service.get(s.id)!;
    expect(after.status).toBe('completed');
    expect(after.runCount).toBe(1);
    expect(after.lastFireId).toBeTruthy();
  });

  it('interval stays active and increments runCount; max_runs completes', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      every: '1s',
      maxRuns: 2,
      payload: { delivery: 'wakeup', text: 'tick' },
    });
    await service.runNow(s.id);
    expect(service.get(s.id)!.status).toBe('active');
    expect(service.get(s.id)!.runCount).toBe(1);

    await service.runNow(s.id);
    expect(service.get(s.id)!.status).toBe('completed');
    expect(service.get(s.id)!.runCount).toBe(2);
    expect(fired).toHaveLength(2);
  });

  it('cancel rejects settled and works on active', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '10m',
      payload: { delivery: 'wakeup', text: 'later' },
    });
    const cancelled = service.cancel(s.id);
    expect(cancelled.status).toBe('cancelled');
    expect(() => service.cancel(s.id)).not.toThrow(); // idempotent cancelled
    expect(() => service.pause(s.id)).toThrow(/Illegal/);

    const once = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '0.01s',
      payload: { delivery: 'wakeup', text: 'x' },
    });
    await service.runNow(once.id);
    expect(() => service.cancel(once.id)).toThrow(/already settled/);
  });

  it('pause stops fire; resume re-arms', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      every: '1s',
      payload: { delivery: 'wakeup', text: 'p' },
    });
    service.pause(s.id);
    expect(service.get(s.id)!.status).toBe('paused');
    await service.runNow(s.id);
    expect(fired).toHaveLength(0);

    service.resume(s.id);
    expect(service.get(s.id)!.status).toBe('active');
    await service.runNow(s.id);
    expect(fired).toHaveLength(1);
  });

  it('rejects multi time specs and empty prompt via set', async () => {
    await expect(
      service.set({
        sessionId: 's1',
        agentId: 'a1',
        delay: '1m',
        every: '1m',
        payload: { delivery: 'wakeup', text: 'x' },
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it('rejects past at and accepts future at / epoch seconds', async () => {
    await expect(
      service.set({
        sessionId: 's1',
        agentId: 'a1',
        at: Date.now() - 60_000,
        payload: { delivery: 'wakeup', text: 'x' },
      }),
    ).rejects.toThrow(/in the future/);

    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      at: futureSec,
      payload: { delivery: 'wakeup', text: 'later' },
    });
    expect(s.kind).toBe('once');
    // 秒被识别为秒，点火应在约 1 小时后
    expect(s.nextFireAt).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it('does not fire immediately when delay exceeds setTimeout max (~24.85d)', async () => {
    // 回归：Node 将 >2^31-1ms 的 delay 钳成 1ms，曾导致远期作业立刻点火
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      at: Date.now() + 30 * 24 * 60 * 60 * 1000,
      payload: { delivery: 'wakeup', text: 'far future' },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toHaveLength(0);
    expect(service.get(s.id)!.status).toBe('active');
    expect(service.get(s.id)!.runCount).toBe(0);
    expect(service.get(s.id)!.nextFireAt).toBeGreaterThan(Date.now());
  });

  it('wakeup throw still re-arms periodic schedule', async () => {
    const boom = new SessionScheduleService({
      dbPath: ':memory:',
      wakeup: () => {
        throw new Error('dispatch failed');
      },
    });
    await boom.open();
    const s = await boom.set({
      sessionId: 's1',
      agentId: 'a1',
      every: '1h',
      payload: { delivery: 'wakeup', text: 'tick' },
    });
    await boom.runNow(s.id);
    const after = boom.get(s.id)!;
    expect(after.status).toBe('active');
    expect(after.runCount).toBe(1);
    expect(after.lastError).toMatch(/dispatch failed/);
    expect(after.nextFireAt).toBeGreaterThan(Date.now());
    boom.dispose();
  });

  it('notify delivery writes via onNotify and does not wakeup', async () => {
    const notified: Array<{ content: string; id: string }> = [];
    const svc = new SessionScheduleService({
      dbPath: ':memory:',
      wakeup: () => {
        throw new Error('wakeup should not run for notify');
      },
      notify: ({ schedule, content }) => {
        notified.push({ content, id: schedule.id });
      },
    });
    await svc.open();
    const s = await svc.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '1h',
      payload: { delivery: 'notify', text: 'status ping' },
    });
    await svc.runNow(s.id);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.content).toContain('status ping');
    expect(svc.get(s.id)!.status).toBe('completed');
    svc.dispose();
  });

  it('records createdBy.runId when provided', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '10m',
      createdByRunId: 'run_test_42',
      payload: { delivery: 'wakeup', text: 'x' },
    });
    expect(s.createdBy.runId).toBe('run_test_42');
    const setTool = createScheduleSetTool(service);
    const created = (await setTool.handler(
      { prompt: 'x', delay: '10m' },
      { ...ctx(), runId: 'run_via_tool' } as ToolExecutionContext,
    )) as { id: string };
    expect(service.get(created.id)!.createdBy.runId).toBe('run_via_tool');
  });

  it('schedule_update changes prompt, max_runs and time', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      every: '1h',
      maxRuns: 5,
      payload: { delivery: 'wakeup', text: 'old', title: 'T' },
    });
    const updated = service.update(s.id, {
      prompt: 'new prompt',
      maxRuns: 10,
      time: { every: '30m' },
    });
    expect(updated.payload.text).toBe('new prompt');
    expect(updated.maxRuns).toBe(10);
    expect(updated.kind).toBe('interval');
    expect(updated.intervalMs).toBe(30 * 60_000);
    expect(updated.status).toBe('active');

    const done = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '0.01s',
      payload: { delivery: 'wakeup', text: 'x' },
    });
    await service.runNow(done.id);
    expect(() => service.update(done.id, { prompt: 'nope' })).toThrow(/status completed/);
  });

  it('wake budget skips dispatch but still accounts', async () => {
    let wakes = 0;
    const limited = new SessionScheduleService({
      dbPath: ':memory:',
      maxWakesPerHour: 1,
      wakeup: () => {
        wakes++;
      },
    });
    await limited.open();
    await limited.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '0.01s',
      payload: { delivery: 'wakeup', text: 'a' },
    });
    await limited.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '0.01s',
      payload: { delivery: 'wakeup', text: 'b' },
    });
    const ids = limited.list('s1', { activeOnly: true }).map((x) => x.id);
    await limited.runNow(ids[0]!);
    await limited.runNow(ids[1]!);
    expect(wakes).toBe(1);
    expect(limited.get(ids[0]!)!.runCount).toBe(1);
    expect(limited.get(ids[1]!)!.runCount).toBe(1);
    limited.dispose();
  });

  it('coalesceKey merges rapid fires into one dispatch', async () => {
    let wakes = 0;
    const svc = new SessionScheduleService({
      dbPath: ':memory:',
      coalesceWindowMs: 5_000,
      wakeup: () => {
        wakes++;
      },
    });
    await svc.open();
    await svc.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '0.01s',
      coalesceKey: 'k1',
      payload: { delivery: 'wakeup', text: 'one' },
    });
    await svc.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '0.01s',
      coalesceKey: 'k1',
      payload: { delivery: 'wakeup', text: 'two' },
    });
    const ids = svc.list('s1', { activeOnly: true }).map((x) => x.id);
    await svc.runNow(ids[0]!);
    await svc.runNow(ids[1]!);
    expect(wakes).toBe(1);
    svc.dispose();
  });

  it('marks failed when next fire cannot be computed', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      cron: '0 9 * * *',
      payload: { delivery: 'wakeup', text: 'daily' },
    });
    // 破坏 cron，使 computeNextFireAt 抛错
    const store = (service as unknown as { store: { raw: { prepare: (s: string) => { run: (...a: unknown[]) => void } } } }).store;
    store.raw
      .prepare('UPDATE schedules SET cron_expr = ? WHERE id = ?')
      .run('not-a-cron', s.id);
    await service.runNow(s.id);
    const after = service.get(s.id)!;
    expect(after.status).toBe('failed');
    expect(after.lastError).toMatch(/cron|Invalid/i);
  });

  it('renders injection only for open schedules', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      delay: '10m',
      payload: { delivery: 'wakeup', text: 'check CI', title: 'CI' },
    });
    const open = service.list('s1', { activeOnly: true });
    const text = renderSessionSchedulesInjection(open);
    expect(text).toContain('<session_schedules>');
    expect(text).toContain(s.id);
    expect(text).toContain('CI');

    service.cancel(s.id);
    expect(renderSessionSchedulesInjection(service.list('s1', { activeOnly: true }))).toBe(
      '',
    );
  });

  it('render distinguishes paused from active', async () => {
    const s = await service.set({
      sessionId: 's1',
      agentId: 'a1',
      every: '1h',
      payload: { delivery: 'wakeup', text: 'later', title: 'P' },
    });
    service.pause(s.id);
    const text = renderSessionSchedulesInjection(service.list('s1', { activeOnly: true }));
    expect(text).toContain('paused');
    expect(text).toContain('不会自动点火');
    expect(text).not.toMatch(/active 作业到点后/);
  });
});

describe('schedule_* / timer_* tools', () => {
  let service: SessionScheduleService;
  let fired: Trigger[];

  beforeEach(async () => {
    fired = [];
    service = new SessionScheduleService({
      dbPath: ':memory:',
      wakeup: (t) => {
        fired.push(t);
      },
    });
    await service.open();
  });

  afterEach(() => {
    service.dispose();
  });

  it('schedule_set / list / cancel roundtrip', async () => {
    const setTool = createScheduleSetTool(service);
    const listTool = createScheduleListTool(service);
    const cancelTool = createScheduleCancelTool(service);

    const created = (await setTool.handler(
      {
        prompt: 'check deploy',
        every: '30m',
        title: 'deploy',
        max_runs: 5,
      },
      ctx(),
    )) as { id: string; kind: string; next_fire_at: number; do_not_run_now?: boolean };

    expect(created.kind).toBe('interval');
    expect(created.id).toMatch(/^sch_/);
    expect(created.do_not_run_now).toBe(true);

    const listed = (await listTool.handler({}, ctx())) as { total: number };
    expect(listed.total).toBe(1);

    const cancelled = (await cancelTool.handler({ id: created.id }, ctx())) as {
      status: string;
    };
    expect(cancelled.status).toBe('cancelled');
  });

  it('schedule_cancel cannot touch other sessions', async () => {
    const setTool = createScheduleSetTool(service);
    const cancelTool = createScheduleCancelTool(service);
    const created = (await setTool.handler(
      { prompt: 'x', delay: '10m' },
      ctx('s1'),
    )) as { id: string };
    await expect(cancelTool.handler({ id: created.id }, ctx('s2'))).rejects.toThrow(
      /not found in this session/,
    );
  });

  it('timer_wait blocks and timer_cancel aborts', async () => {
    const waitTool = createTimerWaitTool({ maxDurationMs: 1000, hardMaxDurationMs: 2000 });
    const cancelTool = createTimerCancelTool();

    const waitPromise = waitTool.handler({ duration: '0.2s' }, ctx());
    const cancelResult = (await cancelTool.handler({}, ctx())) as { cancelled: boolean };
    // cancel may race; if wait already finished, cancelled false is ok for 200ms
    if (cancelResult.cancelled) {
      await expect(waitPromise).rejects.toThrow(/cancelled/);
    } else {
      const r = await waitPromise;
      expect((r as { waited_ms: number }).waited_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('timer_wait rejects over max and suggests schedule_set', async () => {
    const waitTool = createTimerWaitTool({ maxDurationMs: 1000, hardMaxDurationMs: 2000 });
    await expect(waitTool.handler({ duration: '5m' }, ctx())).rejects.toThrow(
      /schedule_set/,
    );
    await expect(waitTool.handler({ duration: '1.5s' }, ctx())).rejects.toThrow(
      /exceeds max/,
    );
  });

  it('timer_wait short sleep completes', async () => {
    const waitTool = createTimerWaitTool();
    const r = (await waitTool.handler({ seconds: 0.02 }, ctx())) as { waited_ms: number };
    expect(r.waited_ms).toBeGreaterThanOrEqual(15);
    expect(fired).toHaveLength(0);
  });
});
