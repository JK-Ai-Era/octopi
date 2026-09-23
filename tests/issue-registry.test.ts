/**
 * System Issues — IssueRegistry 幂等 / resolve
 */
import { describe, test, expect } from 'vitest';
import { IssueRegistry } from '../src/harness/diagnostics/registry.js';

describe('IssueRegistry', () => {
  test('report 幂等更新，且 resolved 后复现重开', () => {
    const reg = new IssueRegistry();
    const a = reg.report({
      id: 'commands:command.conflict:pdf',
      domain: 'commands',
      code: 'command.conflict',
      severity: 'warning',
      title: 't',
      detail: 'd1',
    });
    const b = reg.report({
      id: 'commands:command.conflict:pdf',
      domain: 'commands',
      code: 'command.conflict',
      severity: 'warning',
      title: 't',
      detail: 'd2',
    });
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.detail).toBe('d2');
    expect(reg.list()).toHaveLength(1);

    reg.resolve('commands:command.conflict:pdf');
    expect(reg.get('commands:command.conflict:pdf')?.status).toBe('resolved');
    const c = reg.report({
      id: 'commands:command.conflict:pdf',
      domain: 'commands',
      code: 'command.conflict',
      severity: 'warning',
      title: 't',
      detail: 'd3',
    });
    expect(c.status).toBe('open');
  });

  test('resolve / dismiss', () => {
    const reg = new IssueRegistry();
    reg.report({
      id: 'x',
      domain: 'plugins',
      code: 'plugin.load_failed',
      severity: 'error',
      title: 't',
      detail: 'd',
    });
    reg.resolve('x');
    expect(reg.get('x')?.status).toBe('resolved');
    reg.dismiss('x');
    expect(reg.get('x')?.status).toBe('dismissed');
  });

  test('subscribe 收到 upsert', () => {
    const reg = new IssueRegistry();
    const events: string[] = [];
    reg.subscribe((ev) => events.push(ev.type));
    reg.report({
      id: 'y',
      domain: 'skills',
      code: 'skill.command_invalid',
      severity: 'info',
      title: 't',
      detail: 'd',
    });
    expect(events).toEqual(['upsert']);
  });
});
