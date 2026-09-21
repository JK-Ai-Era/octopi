/**
 * One-off: rewrite legacy TokenUsage literals in tests/src to makeTokenUsage(...)
 * Run: node scripts/migrate-token-usage-literals.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync(
  `& "$process.env.MIMO_RIPGREP_PATH" -l "promptTokens" src tests --glob "*.ts"`,
  { encoding: 'utf8', shell: 'powershell.exe' },
)
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const objectRe =
  /(?:usage:\s*)?\{\s*promptTokens:\s*([^,}]+),\s*completionTokens:\s*([^,}]+)(?:,\s*totalTokens:\s*[^,}]+)?\s*\}/g;

let changed = 0;
for (const file of files) {
  if (file.includes('core/types/turn.ts')) continue;
  if (file.includes('integration/providers/usage.ts')) continue;
  let text = readFileSync(file, 'utf8');
  const before = text;
  text = text.replace(objectRe, (full, p, c) => {
    // keep property name when present
    if (full.trimStart().startsWith('usage:')) {
      return `usage: makeTokenUsage({ promptTokens: ${p.trim()}, completionTokens: ${c.trim()} })`;
    }
    if (full.includes('promptTokens:') && full.trimStart().startsWith('{')) {
      // bare object used as usage value
      return `makeTokenUsage({ promptTokens: ${p.trim()}, completionTokens: ${c.trim()} })`;
    }
    return `makeTokenUsage({ promptTokens: ${p.trim()}, completionTokens: ${c.trim()} })`;
  });
  // also handle usage: { totalTokens: N } alone — leave for manual
  if (text !== before) {
    if (!text.includes('makeTokenUsage') ) {
      // no-op
    }
    if (!/from ['"].*core\/types(\.js)?['"]/.test(text) && !text.includes('makeTokenUsage')) {
      // skip
    }
    if (text.includes('makeTokenUsage') && !text.includes("import { makeTokenUsage") && !text.includes('makeTokenUsage,')) {
      // insert import after first import line
      const lines = text.split('\n');
      let idx = lines.findIndex((l) => l.startsWith('import '));
      if (idx >= 0) {
        const importPath = file.includes(`${'\\'}src${'\\'}`) || file.includes('/src/')
          ? (file.includes('tests/') || file.includes('tests\\')
              ? '../src/core/types/turn.js'
              : '../../core/types/turn.js')
          : '../src/core/types/turn.js';
        // relative from tests/* vs tests/harness/*
        let rel = '../src/core/types/turn.js';
        if (file.replace(/\\/g, '/').includes('tests/harness/')) rel = '../../src/core/types/turn.js';
        if (file.replace(/\\/g, '/').includes('src/')) {
          const depth = file.replace(/\\/g, '/').split('src/')[1].split('/').length - 1;
          rel = `${'../'.repeat(depth + 1)}core/types/turn.js`;
        }
        lines.splice(idx + 1, 0, `import { makeTokenUsage } from '${rel}';`);
        text = lines.join('\n');
      }
    }
    writeFileSync(file, text);
    changed++;
  }
}
console.log(`rewrote ${changed} files`);
