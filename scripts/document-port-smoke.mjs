/**
 * 真实语料冒烟：对 documents-test 目录逐个 extract，打印摘要。
 * 运行: node scripts/document-port-smoke.mjs
 */
import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { createDefaultDocumentPort } from '../packages/engine/dist/harness/capabilities/document/port.js';

const dir = process.argv[2] ?? String.raw`C:\Users\James\.octopi\workspace\default\documents-test`;

const port = createDefaultDocumentPort({
  config: { timeoutMs: 120_000, maxFileBytes: 80 * 1024 * 1024 },
});

const caps = await port.capabilities();
console.log('=== capabilities ===');
console.log(JSON.stringify(caps, null, 2));

const entries = await readdir(dir);
const files = [];
for (const name of entries) {
  const p = join(dir, name);
  const st = await stat(p);
  if (st.isFile()) files.push({ path: p, name, size: st.size });
}
files.sort((a, b) => a.name.localeCompare(b.name));

console.log('\n=== extract ===');
for (const f of files) {
  const t0 = Date.now();
  try {
    const probe = await port.probe({ path: f.path, name: f.name });
    const result = await port.extract({ path: f.path, name: f.name });
    const ms = Date.now() - t0;
    const head = result.markdown.slice(0, 120).replace(/\s+/g, ' ');
    console.log(
      [
        `OK  ${f.name}`,
        `    format=${result.meta.format} probe=${probe.level} backend=${result.backend} pages=${result.meta.pages ?? '-'}`,
        `    chars=${result.markdown.length} ms=${ms} warnings=${result.warnings.map((w) => w.code).join(',') || '-'}`,
        `    head: ${head}${result.markdown.length > 120 ? '…' : ''}`,
      ].join('\n'),
    );
  } catch (err) {
    const ms = Date.now() - t0;
    const code = err && typeof err === 'object' && 'code' in err ? err.code : 'ERROR';
    const req = err && typeof err === 'object' && 'requires' in err ? err.requires : null;
    console.log(
      `FAIL ${f.name}\n    ${code}${req ? ` requires=${req.join(',')}` : ''} ${err instanceof Error ? err.message : err} (${ms}ms)`,
    );
  }
}
