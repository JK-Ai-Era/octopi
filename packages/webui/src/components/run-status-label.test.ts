import { describe, it, expect } from 'vitest';
import { zh, en } from '../i18n/messages';
import { RUN_STATUS_LABEL_KEY, runStatusLabelKey } from './run-status-label';

describe('runStatusLabelKey（顶栏运行状态标签）', () => {
  it('每个 RunStatus 的标签键在中英文目录都存在且非空', () => {
    for (const key of Object.values(RUN_STATUS_LABEL_KEY)) {
      expect(zh[key], `zh missing: ${key}`).toBeTruthy();
      expect(en[key], `en missing: ${key}`).toBeTruthy();
    }
  });

  it('压缩进行中覆盖显示「正在压缩」（任意运行状态）', () => {
    for (const status of Object.keys(RUN_STATUS_LABEL_KEY)) {
      expect(runStatusLabelKey(status as keyof typeof RUN_STATUS_LABEL_KEY, true)).toBe('chatWorkspace.statusCompacting');
    }
    expect(zh['chatWorkspace.statusCompacting']).toBe('正在压缩');
    expect(en['chatWorkspace.statusCompacting']).toBeTruthy();
  });

  it('非压缩时按状态映射（不覆盖）', () => {
    expect(runStatusLabelKey('idle', false)).toBe('chatWorkspace.statusIdle');
    expect(runStatusLabelKey('waiting', false)).toBe('chatWorkspace.statusWaiting');
    expect(runStatusLabelKey('error', false)).toBe('chatWorkspace.statusError');
  });
});
