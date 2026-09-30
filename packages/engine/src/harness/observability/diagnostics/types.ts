/**
 * System Issue — 产品问题面（用户可读、可修、影响可调用能力）
 *
 * 与 Observer / Telemetry / Doctor 分流：本通道只服务 UI「该不该慌」。
 */

export type IssueSeverity = 'info' | 'warning' | 'error';

export type IssueDomain =
  | 'commands'
  | 'plugins'
  | 'skills'
  | 'providers'
  | 'mcp'
  | 'config'
  | 'memory'
  | 'other';

export type IssueStatus = 'open' | 'resolved' | 'dismissed';

export interface IssueRef {
  label: string;
  path?: string;
  pluginId?: string;
  skillId?: string;
}

export interface IssueAction {
  id: 'doctor' | 'retry' | 'dismiss' | 'open';
  label: string;
}

export interface SystemIssue {
  id: string;
  domain: IssueDomain;
  code: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  refs?: IssueRef[];
  actions?: IssueAction[];
  status: IssueStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

export type IssueReportInput = Omit<SystemIssue, 'status' | 'createdAt' | 'updatedAt' | 'resolvedAt'>;

export type IssueUpsert =
  | { type: 'upsert'; issue: SystemIssue }
  | { type: 'resolved'; id: string; status: IssueStatus; resolvedAt?: number };
