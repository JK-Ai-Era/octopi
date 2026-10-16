/**
 * SessionSchedule 注入渲染 — `<session_schedules>`
 *
 * 对齐 renderSessionTasksInjection；直接由 Service 查询结果渲染，不投影进 state.json。
 */

import type { SessionSchedule } from './types.js';

function formatWhen(ts: number): string {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

/**
 * 渲染 `<session_schedules>` 注入块。
 *
 * @param schedules - 本会话作业（含 active / paused）
 * @returns 注入字符串；无未闭合作业时返回空串
 */
export function renderSessionSchedulesInjection(schedules: SessionSchedule[]): string {
  const open = schedules
    .filter((s) => s.status === 'active' || s.status === 'paused')
    .sort(
      (a, b) => a.nextFireAt - b.nextFireAt || a.createdBy.at - b.createdBy.at,
    );

  if (open.length === 0) return '';

  const lines: string[] = [
    '<session_schedules>',
    '当前会话未闭合的定时作业：',
    '',
  ];

  for (const s of open) {
    const title = s.payload.title
      ? `「${s.payload.title}」`
      : `「${s.payload.text.slice(0, 40)}」`;
    const rhythm =
      s.kind === 'once'
        ? `once @ ${formatWhen(s.fireAt ?? s.nextFireAt)}`
        : s.kind === 'interval'
          ? `every ${s.intervalMs}ms`
          : `cron ${s.cron ?? ''}`;
    const runs =
      s.maxRuns !== undefined
        ? `run ${s.runCount}/${s.maxRuns}`
        : `run ${s.runCount}`;
    const whenNote =
      s.status === 'paused'
        ? 'paused，不会自动点火'
        : `next ${formatWhen(s.nextFireAt)}`;
    lines.push(`- [${s.id}] ${s.status} | ${rhythm} | ${runs} | ${whenNote} | ${title}`);
  }

  const hasActive = open.some((s) => s.status === 'active');
  const hasPaused = open.some((s) => s.status === 'paused');

  lines.push('');
  lines.push('说明：');
  if (hasActive) {
    lines.push('- active 作业到点后系统会在本会话自动唤醒并执行事项正文。');
  }
  if (hasPaused) {
    lines.push('- paused 作业**不会**自动点火；恢复请 schedule_resume，取消请 schedule_cancel。');
  }
  lines.push('- **禁止在当前回合执行上述事项**；现在只处理用户当前消息，或直接结束回合。');
  lines.push('- 不必重复 schedule_set 同一事项，除非要改时间或内容。');
  lines.push('- 事项已结束时请 schedule_cancel，避免继续点火。');
  lines.push('</session_schedules>');

  return lines.join('\n');
}
