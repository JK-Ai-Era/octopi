/**
 * 把 src/subsystems 下的非 TS 资源拷到 dist/subsystems（tsc 不处理 yaml/md）。
 * node scripts/copy-subsystem-assets.mjs
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
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

const files = await walk(srcRoot);
let copied = 0;
for (const file of files) {
  const rel = relative(srcRoot, file);
  const dest = join(distRoot, rel);
  await mkdir(dirname(dest), { recursive: true });
  await cp(file, dest);
  copied += 1;
}

console.log(`[copy-subsystem-assets] ${copied} file(s) → ${distRoot}`);
if (copied === 0 && existsSync(srcRoot)) {
  console.warn('[copy-subsystem-assets] no assets found under src/subsystems');
}
