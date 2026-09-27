/**
 * IssueRegistry — 进程内产品问题登记（幂等 id，fail-open）
 */

import type {
  IssueDomain,
  IssueReportInput,
  IssueStatus,
  IssueUpsert,
  SystemIssue,
} from './types.js';

export class IssueRegistry {
  private issues = new Map<string, SystemIssue>();
  private listeners = new Set<(ev: IssueUpsert) => void>();

  /** 同 id 再次 report = 更新；resolved/dismissed 视为复现，重开为 open */
  report(input: IssueReportInput): SystemIssue {
    const now = Date.now();
    const existing = this.issues.get(input.id);
    const issue: SystemIssue = existing
      ? {
          ...existing,
          ...input,
          status: 'open',
          resolvedAt: undefined,
          updatedAt: now,
        }
      : {
          ...input,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        };
    this.issues.set(issue.id, issue);
    this.emit({ type: 'upsert', issue });
    return issue;
  }

  resolve(id: string, _reason?: string): void {
    const issue = this.issues.get(id);
    if (!issue || issue.status === 'resolved') return;
    const now = Date.now();
    const next: SystemIssue = { ...issue, status: 'resolved', resolvedAt: now, updatedAt: now };
    this.issues.set(id, next);
    this.emit({ type: 'resolved', id, status: 'resolved', resolvedAt: now });
  }

  dismiss(id: string): void {
    const issue = this.issues.get(id);
    if (!issue || issue.status === 'dismissed') return;
    const now = Date.now();
    const next: SystemIssue = { ...issue, status: 'dismissed', updatedAt: now };
    this.issues.set(id, next);
    this.emit({ type: 'resolved', id, status: 'dismissed' });
  }

  get(id: string): SystemIssue | null {
    return this.issues.get(id) ?? null;
  }

  list(filter?: { domain?: IssueDomain; status?: IssueStatus }): SystemIssue[] {
    let items = Array.from(this.issues.values());
    if (filter?.domain) items = items.filter((i) => i.domain === filter.domain);
    if (filter?.status) items = items.filter((i) => i.status === filter.status);
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  subscribe(fn: (ev: IssueUpsert) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(ev: IssueUpsert): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // 观察者失败不影响 issue 通道（fail-open）
      }
    }
  }
}
