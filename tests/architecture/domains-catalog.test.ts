/**
 * Domains catalog tests
 *
 * 防再漂门禁（docs/domains.md §6）：
 * - packages/engine/src/harness/ 目录（深度 1–2）与 docs/domains.yaml 的
 *   module_catalog 一致：每个目录须登记，或其下含已登记子模块；
 *   `planned: true` 允许暂缺，未登记的目录 fail。
 * - product_domain_count 与 domains 段条目数一致（= 10）。
 *
 * 解析为行级解析（不引入 YAML 依赖）；module_catalog 条目为单行 flow map：
 *   - { id: run/reliability, domain: run }
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = fileURLToPath(new URL('../../packages/engine/src/harness', import.meta.url));
const DOMAINS_YAML = fileURLToPath(new URL('../../docs/domains.yaml', import.meta.url));

interface CatalogEntry {
  id: string;
  planned: boolean;
}

function parseCatalog(yamlText: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  let inCatalog = false;
  for (const line of yamlText.split(/\r?\n/)) {
    if (/^module_catalog:/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (!inCatalog) continue;
    // 段落结束：顶格非注释行
    if (line.trim() !== '' && !/^\s/.test(line) && !/^#/.test(line)) break;
    const m = line.match(/id:\s*([A-Za-z0-9_./-]+)/);
    if (m) {
      entries.push({ id: m[1], planned: /planned:\s*true/.test(line) });
    }
  }
  return entries;
}

function listDirs(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      out.push(relative(root, full).split(sep).join('/'));
      walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return out.sort();
}

describe('domains.yaml module_catalog', () => {
  const yamlText = readFileSync(DOMAINS_YAML, 'utf-8');
  const catalog = parseCatalog(yamlText);

  it('parses a non-empty catalog', () => {
    expect(catalog.length).toBeGreaterThan(10);
  });

  it('every catalog id exists on disk (planned: true 允许暂缺)', () => {
    const missing = catalog
      .filter((e) => !e.planned)
      .filter((e) => {
        const asDir = statSync(join(HARNESS, e.id), { throwIfNoEntry: false });
        const asFile = statSync(join(HARNESS, `${e.id}.ts`), { throwIfNoEntry: false });
        return !asDir?.isDirectory() && !asFile?.isFile();
      })
      .map((e) => e.id);
    expect(missing, `domains.yaml module id missing on disk: ${missing.join(', ')}`).toEqual([]);
  });

  it('every harness dir (depth 1–2) is registered or contains a registered submodule', () => {
    const ids = new Set(catalog.map((e) => e.id));
    const unregistered = listDirs(HARNESS, 2).filter((dir) => {
      if (ids.has(dir)) return false;
      // 允许伞形目录：其下含已登记子模块
      return ![...ids].some((id) => id.startsWith(`${dir}/`));
    });
    expect(
      unregistered,
      `harness dirs not registered in domains.yaml module_catalog: ${unregistered.join(', ')}`
    ).toEqual([]);
  });

  it('product_domain_count matches domains entries (10)', () => {
    const declared = Number(yamlText.match(/product_domain_count:\s*(\d+)/)?.[1] ?? '0');
    const section = yamlText.split(/^domains:/m)[1]?.split(/^(capabilities|foundation):/m)[0] ?? '';
    const domainIds = section.match(/^\s{2}- id:\s*/gm) ?? [];
    expect(declared).toBe(10);
    expect(domainIds.length).toBe(declared);
  });
});
