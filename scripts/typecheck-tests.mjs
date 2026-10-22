/**
 * tests 类型检查门禁（增量基线模式）
 *
 * 背景：tests/ 长期不在任何 tsc 检查内（根 tsconfig exclude），存量类型债 400+
 * 一次性清理是独立批次（arch/NEXT-STEPS.md T1）。本脚本把**存量错误快照进基线**，
 * 只对**新增**错误失败：新写/改动的测试必须干净，存量债不阻塞，还一批收敛一次基线。
 *
 * 比对粒度：`文件(错误码, 消息|第一条续行)` 多重集（去行/列号、消息内 (n,n) 归一，
 * 行号随编辑漂移免疫）。同键数量超过基线即判新增。已知盲区（有意取舍）：
 * 净零置换（修一处旧债、别处新增同键错误）不报——行号无关比对的固有代价。
 *
 * 退出码：0 = 无新增（或 --update 成功）；1 = 有新增错误；2 = 门禁故障
 * （tsc 没跑起来/配置坏/解析不出输出/基线缺失），**故障绝不冒充绿**。
 *
 * 用法：node scripts/typecheck-tests.mjs [--update] [--force]
 *   --update：重写基线（修完一批债后收敛用；前后键数会打印；
 *             基线骤减超 10% 需叠加 --force，防配置坏掉时把基线清空）
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'tests', '.typecheck-baseline.txt');
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

/** tsc 输出 → 键数组 + 无法解析的 error 行（非空即视为解析失败） */
function parseTscOutput(stdout) {
  const lines = stdout.split(/\r?\n/);
  const keys = [];
  const unparseable = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    const m = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/);
    if (m) {
      // 首条续行参与键：TS2345/TS2741 的「缺哪个属性」形状变化必须可见（评审 P2）
      const next = lines[i + 1] ?? '';
      const elaboration = next !== '' && !next.includes('): error TS') ? next.trim() : '';
      const message = [m[3], elaboration].filter(Boolean).join(' | ');
      keys.push({ key: `${m[1]}(${m[2]}): ${message}`, raw: line });
      continue;
    }
    if (line.includes('error TS')) unparseable.push(line);
  }
  return { keys, unparseable };
}

function countKeys(keys) {
  const counts = new Map();
  for (const { key } of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function fail(msg, extra = '') {
  console.error(`[typecheck:tests] ${msg}`);
  if (extra !== '') console.error(extra);
  process.exit(2);
}

// 直接执行本地 tsc（不经 npx：npx 在 Windows 上是 npx.cmd 需 shell，
// 且缺依赖时会回退 registry 装无关的 tsc@2 包——门禁绝不能依赖网络）
if (!existsSync(tscBin)) {
  fail(`typescript not found at ${tscBin} — run \`npm install\` first.`);
}
const run = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.tests.json', '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 120_000,
});
if (run.error) {
  fail(`tsc failed to run: ${run.error.message}`, run.stderr ?? '');
}

const { keys, unparseable } = parseTscOutput(run.stdout ?? '');

// 故障判定：tsc 崩溃/配置坏（TS5058、TS18003 等无 (line,col) 的全局诊断）时
// 解析结果为空或半空——绝不能落进「0 新增」的绿（评审 P1 假绿三路）
if (unparseable.length > 0) {
  fail(
    `tsc emitted ${unparseable.length} unparseable diagnostic(s) — config broken? refusing to judge:`,
    unparseable.slice(0, 5).join('\n'),
  );
}
if (run.status !== 0 && keys.length === 0) {
  fail(
    `tsc exited ${run.status} but produced no parseable diagnostics — refusing to judge:`,
    (run.stderr ?? '').slice(0, 2000),
  );
}

if (process.argv.includes('--update')) {
  if (!existsSync(baselinePath)) {
    fail('baseline missing — cannot compute diff for --update; run without baseline needs explicit care.');
  }
  const before = countKeys(
    readFileSync(baselinePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((key) => ({ key })),
  );
  const now = countKeys(keys);
  // 护栏：骤减超 10% 大概率是「配置坏掉 → 0 错误」而非还得清了债（评审 P1）
  const beforeTotal = [...before.values()].reduce((a, b) => a + b, 0);
  const nowTotal = keys.length;
  if (nowTotal < beforeTotal * 0.9 && !process.argv.includes('--force')) {
    fail(
      `baseline would shrink ${beforeTotal} -> ${nowTotal} (>10%). ` +
        'If this is real debt paydown, re-run with --update --force.',
    );
  }
  const added = [...now.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !now.has(k));
  writeFileSync(baselinePath, [...keys.map((k) => k.key)].sort().join('\n') + '\n');
  console.log(
    `[typecheck:tests] baseline updated: ${beforeTotal} -> ${nowTotal} error(s) ` +
      `(+${added.length} new key(s), -${removed.length} resolved key(s))`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  fail('baseline missing — run `npm run typecheck:update-baseline` once to snapshot the current debt.');
}
const baselineKeys = readFileSync(baselinePath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((key) => ({ key, raw: key }));
const base = countKeys(baselineKeys);
const now = countKeys(keys);

const fresh = [];
for (const [key, n] of now) {
  const excess = n - (base.get(key) ?? 0);
  const rawLines = keys.filter((k) => k.key === key).map((k) => k.raw);
  for (let i = 0; i < excess; i += 1) fresh.push({ key, raw: rawLines[i] ?? key });
}

if (fresh.length > 0) {
  console.error(`[typecheck:tests] ${fresh.length} new type error(s) beyond baseline:`);
  for (const f of fresh) console.error(`  ${f.raw}`);
  process.exit(1);
}
console.log(
  `[typecheck:tests] ok — ${keys.length} known error(s) in baseline, 0 new. Debt: fix and shrink the baseline.`,
);
