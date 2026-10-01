/**
 * LibreOffice 老格式转换闸门（LegacyConverter）
 *
 * 将 .doc/.xls/.ppt 转为 OOXML 后走 T0 抽取；不常驻、用完即退。
 *
 * @module harness/context/capabilities/document/legacy/soffice
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DocumentExtractError } from '../errors.js';
import type { DocumentMeta, ExtractSource, LegacyConverter } from '../types.js';

export interface SofficeLegacyOptions {
  /** soffice 可执行文件；缺省 PATH 上的 soffice */
  sofficePath?: string | null;
  /** 转换超时 ms（默认 60000） */
  timeoutMs?: number;
  /** 最大输入字节（默认 50MB） */
  maxInputBytes?: number;
  /** 转换件缓存目录；缺省不缓存 */
  cacheDir?: string | null;
}

const EXT_TO_TARGET: Record<string, 'docx' | 'xlsx' | 'pptx' | 'pdf'> = {
  doc: 'docx',
  xls: 'xlsx',
  ppt: 'pptx',
  rtf: 'docx',
};

function resolveSofficeBin(explicit?: string | null): string {
  return explicit && explicit.trim() ? explicit : 'soffice';
}

/**
 * 创建 soffice LegacyConverter
 *
 * @param options - sofficePath / timeoutMs / maxInputBytes
 * @returns LegacyConverter
 */
export function createSofficeLegacyConverter(options: SofficeLegacyOptions = {}): LegacyConverter {
  const bin = resolveSofficeBin(options.sofficePath);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxInputBytes = options.maxInputBytes ?? 50 * 1024 * 1024;
  const cacheDir = options.cacheDir?.trim() || null;

  return {
    id: 'soffice',

    async isAvailable(): Promise<boolean> {
      return await probeSoffice(bin, timeoutMs);
    },

    async convert(source: ExtractSource, target) {
      const data = source.data ?? (await readSourcePath(source, maxInputBytes));
      const name = source.name ?? source.path ?? `input.${source.formatHint ?? 'bin'}`;
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      const wanted = EXT_TO_TARGET[ext] ?? target;
      const from = (source.formatHint ?? 'unknown') as DocumentMeta['format'];

      const hash = createHash('sha256').update(data).digest('hex');
      const cacheKey = `${hash}.${wanted}`;
      if (cacheDir) {
        const hit = join(cacheDir, cacheKey);
        try {
          const cachedBytes = await readFile(hit);
          return {
            data: new Uint8Array(cachedBytes),
            meta: {
              format: wanted,
              legacyConversion: { from, converter: 'soffice', cached: true },
            },
          };
        } catch {
          // miss → convert
        }
      }

      const result = await runSofficeConvert({
        bin,
        data,
        name,
        target: wanted,
        timeoutMs,
        from,
      });

      if (cacheDir) {
        try {
          await mkdir(cacheDir, { recursive: true });
          await writeFile(join(cacheDir, cacheKey), result.data);
        } catch {
          // cache write is best-effort
        }
      }
      return result;
    },
  };
}

async function readSourcePath(source: ExtractSource, maxInputBytes: number): Promise<Uint8Array> {
  if (!source.path) {
    throw new DocumentExtractError('INVALID_SOURCE', 'legacy convert requires path or data');
  }
  const st = await stat(source.path);
  if (st.size > maxInputBytes) {
    throw new DocumentExtractError('FILE_TOO_LARGE', `legacy input exceeds ${maxInputBytes} bytes`);
  }
  return new Uint8Array(await readFile(source.path));
}

/**
 * 探测 soffice 是否可用（`--version`）
 *
 * @param bin - 可执行名或路径
 * @param timeoutMs - 探测超时
 */
export async function probeSoffice(bin: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const { code } = await runProcess(bin, ['--version'], timeoutMs);
    return code === 0;
  } catch {
    return false;
  }
}

async function runSofficeConvert(args: {
  bin: string;
  data: Uint8Array;
  name: string;
  target: 'docx' | 'xlsx' | 'pptx' | 'pdf';
  timeoutMs: number;
  from: DocumentMeta['format'];
}): Promise<{ data: Uint8Array; meta: DocumentMeta }> {
  const work = await mkdtemp(join(tmpdir(), 'octopi-soffice-'));
  try {
    const input = join(work, basename(args.name) || `input.${args.target}`);
    await writeFile(input, args.data);

    const env = {
      ...process.env,
      SAL_USE_VCLPLUGIN: 'svp',
    };

    const { code, stderr } = await runProcess(
      args.bin,
      ['--headless', '--norestore', '--convert-to', args.target, '--outdir', work, input],
      args.timeoutMs,
      env,
    );
    if (code !== 0) {
      throw new DocumentExtractError(
        'INVALID_SOURCE',
        `soffice convert failed (${code}): ${stderr.slice(0, 200)}`,
      );
    }

    const stem = basename(input).replace(/\.[^.]+$/, '');
    const outFile = join(work, `${stem}.${args.target}`);
    const out = await readFile(outFile);
    return {
      data: new Uint8Array(out),
      meta: {
        format: args.target,
        legacyConversion: { from: args.from, converter: 'soffice', cached: false },
      },
    };
  } catch (err) {
    if (err instanceof DocumentExtractError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(msg)) {
      throw new DocumentExtractError('BACKEND_UNAVAILABLE', 'soffice not found', ['legacy-converter']);
    }
    throw new DocumentExtractError('INVALID_SOURCE', `legacy convert failed: ${msg}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {
      // temp cleanup is best-effort
    });
  }
}

function runProcess(
  bin: string,
  argv: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, argv, {
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new DocumentExtractError('TIMEOUT', `process timed out: ${bin}`));
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
