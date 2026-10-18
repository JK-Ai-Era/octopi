#!/usr/bin/env node
// POSIX executes bin entries via shebang; tsc emits 0644 and a clean rebuild
// silently strips the executable bit that npm install/link had set — Windows
// development never notices. Restore it after every build.
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bins = Object.values(pkg.bin ?? {});
for (const rel of bins) {
  chmodSync(join(root, rel), 0o755);
}
console.log(`[postbuild-bin] +x on ${bins.length} bin entr${bins.length === 1 ? 'y' : 'ies'}`);
