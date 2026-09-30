import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  'src/index.ts',
  'src/config.ts',
  'src/builtin-model-info.ts',
];

for (const f of files) {
  const now = readFileSync(f, 'utf8');
  const orig = execSync(`git show HEAD:${f}`, { encoding: 'utf8' });
  const specs = [];
  const re = /from\s+['"](\.\/core\/[^'"]+|\.\/loop\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(orig)) !== null) specs.push(m[1]);

  let i = 0;
  const next = now.replace(/@octopi-agent\/core(?:\/loop)?\/undefined/g, () => {
    const spec = specs[i++];
    if (!spec) throw new Error(`ran out of specs for ${f}`);
    if (spec.startsWith('./loop/')) return '@octopi-agent/core/loop/' + spec.slice('./loop/'.length);
    return '@octopi-agent/core/' + spec.slice('./core/'.length);
  });
  writeFileSync(f, next);
  console.log(f, 'fixed', i, 'imports; specs found', specs.length);
}
