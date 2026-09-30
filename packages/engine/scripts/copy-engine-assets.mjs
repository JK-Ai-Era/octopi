import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ASSET_EXT = new Set(['.yaml', '.yml', '.md', '.json', '.txt']);

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

// constitution
const constitutionSrc = join(root, 'src', 'harness', 'context', 'constitution', 'default-agents.md');
const constitutionDistDir = join(root, 'dist', 'harness', 'context', 'constitution');
const constitutionDest = join(constitutionDistDir, 'default-agents.md');
if (existsSync(constitutionSrc)) {
  await mkdir(constitutionDistDir, { recursive: true });
  await cp(constitutionSrc, constitutionDest);
  console.log('[copy-engine-assets] constitution →', constitutionDest);
} else {
  console.error('[copy-engine-assets] FAILED: missing', constitutionSrc);
  process.exitCode = 1;
}

// built-in subsystems (yaml/md/config) — handlers come from tsc
const subSrc = join(root, 'src', 'subsystems');
const subDist = join(root, 'dist', 'subsystems');
if (existsSync(subSrc)) {
  let copied = 0;
  for (const file of await walk(subSrc)) {
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (!ASSET_EXT.has(ext)) continue;
    const dest = join(subDist, relative(subSrc, file));
    await mkdir(dirname(dest), { recursive: true });
    await cp(file, dest);
    copied += 1;
  }
  console.log(`[copy-engine-assets] subsystems: ${copied} asset(s) → ${subDist}`);
}
