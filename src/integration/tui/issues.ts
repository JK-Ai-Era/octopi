/**
 * TUI 系统问题（/issues）展示 — 纯函数
 *
 * 数据源：gateway welcome 快照 + `system.issue` / `system.issue.resolved` 事件
 * （app.ts 维护 openIssues 集合）。此处只做格式化与选择，无 IO——单测直接钉行为。
 */

export interface TuiIssue {
  id: string;
  severity: string;
  title: string;
  detail: string;
}

/**
 * 严重度 → 展示标记。
 *
 * @param severity - 严重度字符串（大小写不敏感）
 * @returns 标记 emoji（未知严重度 ⚪，不猜语义）
 */
function severityMark(severity: string): string {
  switch (severity.trim().toLowerCase()) {
    case 'critical':
      return '🔴';
    case 'high':
      return '🟠';
    case 'medium':
      return '🟡';
    case 'low':
      return '🔵';
    default:
      return '⚪';
  }
}

/**
 * 问题列表 → 展示行（序号 + 严重度标记 + 标题 + id）。
 *
 * @param issues - open issues（顺序即展示顺序）
 * @returns 每问题一行
 */
export function formatIssueList(issues: TuiIssue[]): string[] {
  return issues.map(
    (issue, i) =>
      `${String(i + 1).padStart(3)}. ${severityMark(issue.severity)} ${issue.title}  [${issue.id}]`,
  );
}

/**
 * 按 `/issues` 参数解析目标：序号（1 起）或问题 id。
 *
 * @param issues - open issues
 * @param ref - 序号或 id
 * @returns 命中的问题；无命中返回 undefined
 */
export function findIssue(issues: TuiIssue[], ref: string): TuiIssue | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    return issues[Number(trimmed) - 1];
  }
  return issues.find((issue) => issue.id === trimmed);
}

/**
 * 问题详情 → 展示行（标记+标题、id/severity、详情正文逐行）。
 *
 * @param issue - 目标问题
 * @returns 详情行
 */
export function formatIssueDetail(issue: TuiIssue): string[] {
  const lines = [
    `${severityMark(issue.severity)} ${issue.title}`,
    `   id: ${issue.id}  severity: ${issue.severity}`,
  ];
  if (issue.detail) {
    for (const seg of issue.detail.split('\n')) lines.push(`   ${seg}`);
  }
  return lines;
}
