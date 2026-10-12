/**
 * send_file 卡片从 history tool_result 重建 fileRef
 */

import { describe, it, expect } from 'vitest';
import { fileRefFromToolResult } from '../packages/webui/src/file-ref.js';

describe('fileRefFromToolResult', () => {
  const ref = {
    fileId: 'f_1',
    name: 'boot.md',
    mime: 'text/markdown',
    sizeBytes: 6,
  };

  it('从 ClientToolCallCard.resolve 的 value.data 恢复', () => {
    const result = {
      kind: 'value',
      data: { shown: true, ...ref },
    };
    expect(fileRefFromToolResult('send_file', result)).toEqual(ref);
  });

  it('从扁平 tool_result 恢复', () => {
    expect(fileRefFromToolResult('send_file', { ...ref })).toEqual(ref);
  });

  it('非 send_file / 缺 fileId 返回 null', () => {
    expect(fileRefFromToolResult('html_ui', { kind: 'value', data: ref })).toBeNull();
    expect(fileRefFromToolResult('send_file', { kind: 'value', data: { name: 'x' } })).toBeNull();
    expect(fileRefFromToolResult('send_file', 'not-json')).toBeNull();
  });

  it('缺省 mime/size 回退安全值', () => {
    const out = fileRefFromToolResult('send_file', { fileId: 'f_2' });
    expect(out).toEqual({
      fileId: 'f_2',
      name: 'f_2',
      mime: 'application/octet-stream',
      sizeBytes: 0,
    });
  });
});
