/**
 * TUI /issues 详情视图——展示与选择的纯逻辑。
 *
 * 钉住：列表行（严重度标记/序号/id）、按序号或 id 选择、详情展开（含多行详情）。
 */

import { describe, it, expect } from 'vitest';
import {
  formatIssueList,
  formatIssueDetail,
  findIssue,
  type TuiIssue,
} from '../src/integration/tui/issues.js';

const issues: TuiIssue[] = [
  {
    id: 'issue-circuit-breaker',
    severity: 'critical',
    title: 'Circuit breaker open',
    detail: 'provider xiaomi-coding 连续失败\n需人工确认后恢复',
  },
  {
    id: 'issue-9f',
    severity: 'low',
    title: 'gitStatusPollSeconds 非法值',
    detail: '',
  },
];

describe('formatIssueList', () => {
  it('每问题一行：序号 + 严重度标记 + 标题 + id', () => {
    const lines = formatIssueList(issues);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('🔴');
    expect(lines[0]).toContain('Circuit breaker open');
    expect(lines[0]).toContain('[issue-circuit-breaker]');
    expect(lines[0]).toContain('1.');
    expect(lines[1]).toContain('🔵');
    expect(lines[1]).toContain('[issue-9f]');
    expect(lines[1]).toContain('2.');
  });

  it('未知严重度用 ⚪（不猜语义）；空列表无输出', () => {
    const lines = formatIssueList([
      { id: 'x', severity: 'weird', title: 'T', detail: '' },
    ]);
    expect(lines[0]).toContain('⚪');
    expect(formatIssueList([])).toEqual([]);
  });
});

describe('findIssue', () => {
  it('序号（1 起）与 id 均可命中', () => {
    expect(findIssue(issues, '2')?.id).toBe('issue-9f');
    expect(findIssue(issues, '1')?.id).toBe('issue-circuit-breaker');
    expect(findIssue(issues, 'issue-9f')?.id).toBe('issue-9f');
  });

  it('未命中/空参返回 undefined', () => {
    expect(findIssue(issues, '9')).toBeUndefined();
    expect(findIssue(issues, 'nope')).toBeUndefined();
    expect(findIssue(issues, '')).toBeUndefined();
  });
});

describe('formatIssueDetail', () => {
  it('详情含 id/severity 与逐行详情正文', () => {
    const lines = formatIssueDetail(issues[0]);
    expect(lines[0]).toContain('Circuit breaker open');
    expect(lines[0]).toContain('🔴');
    expect(lines.join('\n')).toContain('issue-circuit-breaker');
    expect(lines.join('\n')).toContain('severity: critical');
    expect(lines.join('\n')).toContain('provider xiaomi-coding 连续失败');
    expect(lines.join('\n')).toContain('需人工确认后恢复');
  });

  it('空详情不输出空行', () => {
    const lines = formatIssueDetail(issues[1]);
    expect(lines).toHaveLength(2);
  });
});
