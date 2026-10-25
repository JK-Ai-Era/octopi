/**
 * 未知工具名近似建议（tool-name-suggestion）契约测试
 *
 * 背景：模型实测会调用不存在的简写名 `edit`（33 次，且写进 transcript 后
 * 逐轮模仿）。这里钉住「必须给出可执行正确名」与「不许乱猜」两侧行为。
 */

import { describe, it, expect } from 'vitest';
import {
  formatUnknownToolError,
  suggestToolNames,
} from '@octopi-agent/core/loop/tool-name-suggestion.js';

const FILE_TOOLS = [
  'file_read',
  'file_list',
  'file_write',
  'file_delete',
  'file_edit',
  'file_search',
  'file_mkdir',
  'file_rmdir',
  'file_rename',
  'file_copy',
  'file_stat',
];

describe('suggestToolNames — 简写名映射到规范名', () => {
  it('edit → file_edit（错名现场：file_edit 排在 package_edit 之前）', () => {
    const got = suggestToolNames('edit', [...FILE_TOOLS, 'package_edit']);
    expect(got[0]).toBe('file_edit');
    expect(got).toContain('package_edit');
  });

  it('write → file_write', () => {
    expect(suggestToolNames('write', FILE_TOOLS)[0]).toBe('file_write');
  });

  it('read → file_read（多候选同样不猜死，file_read 居首）', () => {
    const got = suggestToolNames('read', [...FILE_TOOLS, 'session_read', 'knowledge_read']);
    expect(got[0]).toBe('file_read');
    expect(got.length).toBeLessThanOrEqual(2);
  });

  it('前缀简写 ask → ask_user、http → http_request', () => {
    expect(suggestToolNames('ask', ['ask_user', 'shell'])[0]).toBe('ask_user');
    expect(suggestToolNames('http', ['http_request', 'web_search'])[0]).toBe('http_request');
  });
});

describe('suggestToolNames — 其他错名形态', () => {
  it('重复前缀 file_file_edit → file_edit', () => {
    expect(suggestToolNames('file_file_edit', FILE_TOOLS)[0]).toBe('file_edit');
  });

  it('拼写错 file_edti → file_edit', () => {
    expect(suggestToolNames('file_edti', FILE_TOOLS)[0]).toBe('file_edit');
  });

  it('段序颠倒（verb-first 惯用名）edit_file → file_edit', () => {
    expect(suggestToolNames('edit_file', FILE_TOOLS)).toEqual(['file_edit']);
    expect(suggestToolNames('read_file', FILE_TOOLS)).toEqual(['file_read']);
    expect(suggestToolNames('write_file', FILE_TOOLS)).toEqual(['file_write']);
    expect(suggestToolNames('delete_file', FILE_TOOLS)).toEqual(['file_delete']);
  });

  it('归一化全等只给一条，不带出无关近邻候选', () => {
    // 回归：曾把 File_Edit 判成最低档，再并列带出 file_list
    expect(suggestToolNames('File_Edit', FILE_TOOLS)).toEqual(['file_edit']);
    expect(suggestToolNames('fileedit', FILE_TOOLS)).toEqual(['file_edit']);
  });

  it('毫不相干的错名不给建议（宁缺勿错）', () => {
    expect(suggestToolNames('quantum_flux', FILE_TOOLS)).toEqual([]);
    expect(suggestToolNames('', FILE_TOOLS)).toEqual([]);
  });

  it('空候选表不报错', () => {
    expect(suggestToolNames('edit', [])).toEqual([]);
  });
});

describe('formatUnknownToolError — 回灌文案', () => {
  it('无建议时保持历史文案', () => {
    expect(formatUnknownToolError('edit', [])).toBe('Tool "edit" not found');
  });

  it('单候选给出唯一正确名', () => {
    expect(formatUnknownToolError('file_file_edit', ['file_edit'])).toBe(
      'Tool "file_file_edit" not found. Did you mean "file_edit"?',
    );
  });

  it('多候选如实列出，不替模型抉择', () => {
    expect(formatUnknownToolError('edit', ['file_edit', 'package_edit'])).toBe(
      'Tool "edit" not found. Did you mean one of: "file_edit", "package_edit"?',
    );
  });
});
