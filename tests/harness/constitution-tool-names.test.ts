/**
 * 宪法工具名一致性（default-agents.md）
 *
 * 背景：模型会按宪法里的写法照抄工具名。历史上 §E 用了 `the ask tool`、
 * `http`、`file_*` 等非工具名写法，而 `file_edit` 一次都没被点名，模型于是
 * 调出并不存在的 `edit`（实测 33 次）。这里钉住「宪法只出现真实工具名」。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONSTITUTION = join(
  ROOT,
  'packages/engine/src/harness/context/constitution/default-agents.md',
);

const text = readFileSync(CONSTITUTION, 'utf-8');

describe('宪法 §E 工具命名', () => {
  it('点名 file_edit，且明确内置集没有 edit 工具', () => {
    expect(text).toContain('`file_edit`');
    expect(text).toContain('the built-in set has no `edit`, `read`, or `write` tool');
  });

  it('区分「工具名不存在」与「内容找不到」两类 not found', () => {
    expect(text).toContain('Tool "<name>" not found');
    expect(text).toContain('re-read the file rather than switching tools');
  });

  it('不出现裸 ask 工具写法', () => {
    expect(text).not.toMatch(/the ask tool/i);
    expect(text).toContain('`ask_user`');
  });

  it('http 工具按全名 http_request 书写', () => {
    expect(text).toContain('`http_request`');
    expect(text).not.toMatch(/- http: /);
  });

  it('不再用 file_* 通配符代替具体工具名', () => {
    expect(text).not.toMatch(/file_\*/);
  });

  it('file 家族列举完整（含 file_rmdir，不留半截清单）', () => {
    for (const name of [
      'file_read',
      'file_write',
      'file_edit',
      'file_delete',
      'file_list',
      'file_stat',
      'file_mkdir',
      'file_rename',
      'file_copy',
      'file_rmdir',
      'file_search',
    ]) {
      expect(text).toContain(`\`${name}\``);
    }
  });
});
