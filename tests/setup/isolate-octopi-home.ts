/**
 * 测试进程 OCTOPI_HOME 隔离
 *
 * Gateway.stop() 会清扫 <OCTOPI_HOME>/sessions/<sid>/undo（进程退出收尾）。
 * 测试不隔离时扫的是真实 ~/.octopi，会把开发中正在运行的会话 undo 整个删掉
 * （表现为 file_write/file_edit 集体 ENOENT: undo/blobs）。每个测试文件
 * 独立临时 home，测试之间也不互相干扰。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCTOPI_HOME = mkdtempSync(join(tmpdir(), 'octopi-test-home-'));
