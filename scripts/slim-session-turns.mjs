#!/usr/bin/env node
/**
 * slim-session-turns — 瘦身历史会话 state.json
 *
 * 背景：旧版每个 turn 向 state.json 的 turns[].input 写入一份全量历史快照，
 * state.json 随会话长度二次方膨胀（数百 MB 级），load 时把服务拖挂。
 * 新引擎已停止写入 input（读取即剥），本脚本把存量文件一次性瘦身。
 *
 * 用法：
 *   node scripts/slim-session-turns.mjs [--sessions-dir <dir>] [--dry-run] [--backup]
 *
 *   --sessions-dir  会话目录（默认 $OCTOPI_HOME/sessions 或 ~/.octopi/sessions）
 *   --dry-run       只报告将删掉什么，不写文件
 *   --backup        覆盖前把原文件复制为 <name>.bak（默认不备份：input 为已废弃冗余数据）
 *
 * 安全性：每个文件独立 parse → 剥 turns[].input → 原子写（tmp + rename）。
 * 单文件 parse 失败则跳过并报告，不影响其余文件。
 */
import { readFile, writeFile, rename, readdir, stat, copyFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const backup = args.includes('--backup');
const dirIdx = args.indexOf('--sessions-dir');
const sessionsDir =
  dirIdx >= 0 && args[dirIdx + 1]
    ? args[dirIdx + 1]
    : join(process.env.OCTOPI_HOME || join(homedir(), '.octopi'), 'sessions');

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

async function slimFile(path) {
  const before = (await stat(path)).size;
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    return { path, status: 'skip-parse-error', detail: String(err?.message ?? err), before };
  }
  if (!state || !Array.isArray(state.turns)) {
    return { path, status: 'skip-no-turns', before, after: before };
  }
  let droppedInputs = 0;
  let droppedInputBytes = 0;
  for (const turn of state.turns) {
    if (turn && typeof turn === 'object' && 'input' in turn) {
      droppedInputs += 1;
      if (Array.isArray(turn.input)) droppedInputBytes += JSON.stringify(turn.input).length;
      delete turn.input;
    }
  }
  if (droppedInputs === 0) {
    return { path, status: 'skip-clean', before, after: before };
  }
  const serialized = JSON.stringify(state, null, 2);
  const after = Buffer.byteLength(serialized, 'utf-8');
  if (dryRun) {
    return { path, status: 'would-slim', before, after, droppedInputs, droppedInputBytes };
  }
  if (backup) {
    await copyFile(path, `${path}.bak`);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, serialized);
  await rename(tmp, path);
  return { path, status: 'slimmed', before, after, droppedInputs, droppedInputBytes };
}

const entries = await readdir(sessionsDir).catch(() => null);
if (!entries) {
  console.error(`[slim-session-turns] cannot read sessions dir: ${sessionsDir}`);
  process.exit(1);
}
const targets = entries.filter((e) => e.endsWith('.state.json')).map((e) => join(sessionsDir, e));
console.log(`[slim-session-turns] dir=${sessionsDir}`);
console.log(`[slim-session-turns] mode=${dryRun ? 'dry-run' : 'write'}${backup ? ' +backup' : ''}`);
console.log(`[slim-session-turns] targets=${targets.length} state.json files\n`);

let totalBefore = 0;
let totalAfter = 0;
let slimmed = 0;
for (const path of targets.sort()) {
  const r = await slimFile(path);
  totalBefore += r.before ?? 0;
  totalAfter += r.after ?? r.before ?? 0;
  if (r.status === 'slimmed' || r.status === 'would-slim') {
    slimmed += 1;
    console.log(
      `${r.status === 'slimmed' ? '[slimmed]' : '[would]  '} ${basename(path)}  ` +
        `${fmtBytes(r.before)} -> ${fmtBytes(r.after)}  ` +
        `(drops ${r.droppedInputs} input snapshots, ~${fmtBytes(r.droppedInputBytes)})`,
    );
  } else {
    console.log(`[${r.status}] ${basename(path)}`);
  }
}
console.log(
  `\n[slim-session-turns] done: ${slimmed}/${targets.length} files ${dryRun ? 'would be ' : ''}slimmed, ` +
    `total ${fmtBytes(totalBefore)} -> ${fmtBytes(totalAfter)}`,
);
