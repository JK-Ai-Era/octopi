/**
 * SessionTask 注入渲染 — goal 全量 + step rollup
 */

import type { SessionTask } from './types.js';

function isActive(status: SessionTask['status']): boolean {
  return status === 'open' || status === 'paused';
}

function stepProgressLine(goalId: string, all: SessionTask[]): string | null {
  const steps = all
    .filter((t) => t.parentId === goalId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (steps.length === 0) return null;

  const settled = steps.filter((t) => t.status === 'done' || t.status === 'dropped').length;
  const current = steps.find((t) => t.status === 'open');
  let line = `      进度：步骤 ${settled}/${steps.length}`;
  if (current) {
    line += `（当前：${current.description}）`;
  }
  return line;
}

/**
 * 渲染 <session_tasks> 注入块。
 * 仅包含未闭合 goal；step 只出现 rollup，不罗列全部描述。
 *
 * @param tasks - 会话全部任务（含 step）
 * @returns 注入字符串；无活跃 goal 时返回空串
 */
export function renderSessionTasksInjection(tasks: SessionTask[]): string {
  const goals = tasks
    .filter((t) => !t.parentId && isActive(t.status))
    .sort((a, b) => a.createdAt - b.createdAt);

  if (goals.length === 0) return '';

  const lines: string[] = [
    '<session_tasks>',
    '当前会话未完成任务：',
    '',
  ];

  for (const goal of goals) {
    lines.push(`- [${goal.id}] ${goal.status} | ${goal.description}`);
    const rollup = stepProgressLine(goal.id, tasks);
    if (rollup) {
      lines.push(rollup);
    }
    if (goal.progressNote) {
      lines.push(`      进展：${goal.progressNote}`);
    }
  }

  lines.push('');
  lines.push('说明：');
  lines.push('- 用户要求继续或话题回归时，可恢复对应任务或先说明进展。');
  lines.push('- 与当前消息无关时，优先处理当前消息，不要强行续做。');
  lines.push('- 完成或放弃时请调用 task_complete / task_drop，保持列表与对话一致。');
  lines.push('- 复杂任务可先 task_create 建目标，再用 task_plan 或 task_create(parent_id) 登记步骤。');
  lines.push('</session_tasks>');

  return lines.join('\n');
}
