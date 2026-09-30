/**
 * Remove compiled output before build so stale pre-split artifacts never ship.
 * Also strips accidental .js/.map/.d.ts from package src trees (tsc output must live in dist only).
 * node scripts/clean-dist.mjs
 */
import { rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'dist',
  'packages/core/dist',
  'packages/engine/dist',
  'packages/gateway/dist',
];

for (const rel of targets) {
  const p = join(root, rel);
  if (existsSync(p)) {
    await rm(p, { recursive: true, force: true });
    console.log('[clean-dist] removed', rel);
  }
}

const JUNK = /\.(js|js\.map|d\.ts|d\.ts\.map)$/;

async function stripSrcJunk(dir) {
  if (!existsSync(dir)) return;
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) {
      await stripSrcJunk(full);
    } else if (JUNK.test(name) && name !== 'types.d.ts') {
      // keep intentional ambient .d.ts (e.g. sqlite-vec.d.ts is .d.ts but under types/)
      // only delete emit artifacts sitting next to sources
      if (/\.(js|js\.map|d\.ts\.map)$/.test(name) || (name.endsWith('.d.ts') && existsSync(full.replace(/\.d\.ts$/, '.ts')))) {
        await rm(full, { force: true });
        console.log('[clean-dist] stripped src junk', full.slice(root.length + 1));
      }
    }
  }
}

for (const rel of ['packages/core/src', 'packages/engine/src', 'packages/gateway/src', 'src']) {
  await stripSrcJunk(join(root, rel));
}
