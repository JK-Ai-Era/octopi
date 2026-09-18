/**
 * 构建后资源拷贝（非 tsc 产出物）：
 * 1) src/subsystems → dist/subsystems（yaml/md 等；仅清理 src 中已删除的一级包，保留 handler.js）
 * 2) 全局宪法 default-agents.md → dist/harness/context/constitution/
 * node scripts/copy-build-assets.mjs
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src', 'subsystems');
const distRoot = join(root, 'dist', 'subsystems');

const ASSET_EXT = new Set(['.yaml', '.yml', '.md', '.json', '.txt']);

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...await walk(p));
    } else {
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
      if (ASSET_EXT.has(ext)) out.push(p);
    }
  }
  return out;
}

async function topLevelDirs(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// ── 1) subsystems 资源 ──
const srcPkgs = new Set(await topLevelDirs(srcRoot));
for (const name of await topLevelDirs(distRoot)) {
  if (!srcPkgs.has(name)) {
    await rm(join(distRoot, name), { recursive: true, force: true });
    console.log(`[copy-build-assets] removed obsolete dist package: ${name}`);
  }
}

const files = await walk(srcRoot);
let copied = 0;
for (const file of files) {
  const rel = relative(srcRoot, file);
  const dest = join(distRoot, rel);
  await mkdir(dirname(dest), { recursive: true });
  await cp(file, dest);
  copied += 1;
}
console.log(`[copy-build-assets] subsystems: ${copied} file(s) → ${distRoot}`);

// ── 2) 全局宪法（产品资产；tsc 不处理 .md） ──
const constitutionSrc = join(root, 'src', 'harness', 'context', 'constitution', 'default-agents.md');
const constitutionDistDir = join(root, 'dist', 'harness', 'context', 'constitution');
if (existsSync(constitutionSrc)) {
  await mkdir(constitutionDistDir, { recursive: true });
  await cp(constitutionSrc, join(constitutionDistDir, 'default-agents.md'));
  console.log(`[copy-build-assets] constitution → ${join(constitutionDistDir, 'default-agents.md')}`);
} else {
  console.warn(`[copy-build-assets] constitution missing at ${constitutionSrc}`);
}

const verify = join(constitutionDistDir, 'default-agents.md');
if (!existsSync(verify)) {
  console.error('[copy-build-assets] FAILED: dist constitution not present after copy');
  process.exitCode = 1;
}
