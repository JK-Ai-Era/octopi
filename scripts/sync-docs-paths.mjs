/**
 * Sync docs/comments to post-split package topology (arch/npm-package-split.md).
 * Historical CHANGELOG entries are left untouched.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'dist' || n === 'CHANGELOG.md') continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(md|ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

const root = process.cwd();
const files = [
  ...walk('docs'),
  ...walk('packages'),
  ...walk('src'),
  'README.md',
  'README_CN.md',
  'AGENTS.md',
];

/** @type {[RegExp, string][]} */
const rules = [
  // import examples
  [/from ['"]octopi\/plugin-sdk\//g, "from '@octopi-agent/engine/plugin-sdk/"],
  [/from ['"]octopi\/harness['"]/g, "from '@octopi-agent/engine'"],
  [/from ['"]octopi\/integration['"]/g, "from '@octopi-agent/engine/integration'"],
  [/from ['"]octopi\/plugins\//g, "from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/"],
  [/from ['"]octopi['"]/g, "from 'octopi-agent'"],
  [/from ['"]octopi-agent\/plugin-sdk\//g, "from '@octopi-agent/engine/plugin-sdk/"],
  // subsystem npm convention
  [/@octopi\/subsystem-/g, '@octopi-agent/subsystem-'],
  [/@octopi\/plugin-/g, '@octopi-agent/plugin-'],
  // paths
  [/node_modules\/octopi\//g, 'node_modules/octopi-agent/'],
  [/`src\/harness\//g, '`packages/engine/src/harness/'],
  [/\bsrc\/harness\//g, 'packages/engine/src/harness/'],
  [/\bsrc\/core\//g, 'packages/core/src/core/'],
  [/\bsrc\/loop\//g, 'packages/core/src/loop/'],
  [/\bsrc\/integration\/gateway\//g, 'packages/gateway/src/gateway/'],
  [/\bsrc\/integration\/web\//g, 'packages/gateway/src/web/'],
  [/\bsrc\/integration\/protocols\//g, 'packages/gateway/src/protocols/'],
  [/\bsrc\/integration\/providers\//g, 'packages/engine/src/integration/providers/'],
  [/\bsrc\/integration\/storage\//g, 'packages/engine/src/integration/storage/'],
];

let changed = 0;
for (const f of files) {
  let t = readFileSync(f, 'utf8');
  const before = t;
  for (const [re, rep] of rules) t = t.replace(re, rep);
  if (t !== before) {
    writeFileSync(f, t);
    changed++;
    console.log('updated', f);
  }
}
console.log(`[sync-docs] files changed: ${changed}`);
