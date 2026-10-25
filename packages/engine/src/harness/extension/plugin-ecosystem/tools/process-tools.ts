/**
 * process_list 工具 — 只读进程诊断（ops P1）
 *
 * 引擎侧枚举（procfs / ps / powershell），不经 shell 工具：
 * macOS 牢笼拒 exec setuid 的 `ps`，Linux 牢笼在新 pidns 里看不到宿主进程，
 * 「看进程」只能由牢笼外的引擎进程自己做。零权限放松——不杀进程、不改状态。
 *
 * 能力标签为 `host-read`（宿主内省，超出 workspace 信息面）：
 * reduced 工具面（untrusted 降级）**剥掉**本工具——argv 是凭证泄漏面
 * （`--token=…`、内联脚本），且引擎侧数据源会绕过牢笼「看不到宿主进程」的边界。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import {
  getAncestorPidChain,
  listProcesses,
  resolveProcessImage,
  selectProcesses,
  type ProcessInfoEntry,
} from '../../execution-environment/process-info.js';

function entryToJson(entry: ProcessInfoEntry): Record<string, unknown> {
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    command: entry.command,
    rssBytes: entry.rssBytes,
    cpuTimeMs: entry.cpuTimeMs,
    threads: entry.threads,
  };
}

/**
 * 创建 process_list 工具
 *
 * 参数：
 * - pid (number, optional): 查单个 pid —— 返回该进程条目 + 祖先链（远祖在前，自身为链尾）+ 可执行映像；不可与其余参数同用
 * - pids (number[], optional): 只列出这些 pid
 * - nameContains (string, optional): 命令行子串过滤（大小写不敏感）
 * - sort ('rss' | 'pid', optional): 排序键，缺省 'rss' 降序（重的在前）
 * - limit (number, optional): 返回上限，缺省 200；截断时 `truncated` 为 true
 *
 * 返回：进程条目（pid/ppid/command/rssBytes/cpuTimeMs/threads）+ matched/total/truncated
 * + source + complete + notes。complete=false 表示来源降级/不全（如牢笼内 ps 被拒、
 * 表行被跳过），此时进程表不可当作「机器上只有这些」。
 * pid 模式另有 chainComplete：祖先链是否每一环都解析到了（与 complete 相互独立）。
 *
 * @returns 注册好的只读工具
 */
export function createProcessListTool(): RegisteredTool {
  return {
    definition: {
      name: 'process_list',
      capabilities: ['host-read'],
      description:
        'List running processes (read-only host diagnostics; engine-side procfs/ps read, works even where a jailed shell cannot run `ps`). ' +
        'Fields per entry: pid, ppid, command, rssBytes, cpuTimeMs (cumulative CPU time — no percentage without sampling), threads. ' +
        'Pass `pid` to inspect one process: returns its entry, its ancestor chain (root-first, ending with the pid itself) and executable image. ' +
        'Check `complete`: false means the source was degraded/unreadable or dropped unparseable lines and the list is partial or empty — never read it as "nothing is running". ' +
        '`chainComplete` (pid mode) reports whether every ancestor link resolved.',
      parameters: {
        pid: {
          type: 'number',
          minimum: 1,
          description:
            'Inspect a single pid: returns that entry plus its ancestor chain and image. Cannot be combined with any other parameter.',
        },
        pids: {
          type: 'array',
          items: { type: 'number', minimum: 1, description: 'pid' },
          description: 'Restrict the listing to these pids (composes with nameContains/sort/limit)',
        },
        nameContains: {
          type: 'string',
          description: 'Case-insensitive substring filter on the command line',
        },
        sort: {
          type: 'string',
          enum: ['rss', 'pid'],
          description: "Sort key: 'rss' (default; heaviest first) or 'pid' (ascending)",
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: 'Maximum entries to return (default 200); `truncated` reports the cut',
        },
      },
      timeoutMs: 60_000,
    },
    handler: async (args) => {
      const pid = args.pid;
      const pids = args.pids;
      const nameContains = args.nameContains;
      const sort = args.sort;
      const limit = args.limit;

      if (pid !== undefined && (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)) {
        throw new Error(`process_list: pid must be a positive integer, got ${JSON.stringify(pid)}`);
      }
      if (pid !== undefined && (pids !== undefined || nameContains !== undefined || sort !== undefined || limit !== undefined)) {
        throw new Error('process_list: pid cannot be combined with pids/nameContains/sort/limit');
      }
      if (
        pids !== undefined &&
        (!Array.isArray(pids) || pids.some((p) => typeof p !== 'number' || !Number.isInteger(p) || p <= 0))
      ) {
        throw new Error('process_list: pids must be an array of positive integers');
      }
      if (nameContains !== undefined && (typeof nameContains !== 'string' || nameContains === '')) {
        throw new Error('process_list: nameContains must be a non-empty string');
      }
      if (sort !== undefined && sort !== 'rss' && sort !== 'pid') {
        throw new Error(`process_list: sort must be 'rss' or 'pid', got ${JSON.stringify(sort)}`);
      }
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) {
        throw new Error(`process_list: limit must be a positive integer, got ${JSON.stringify(limit)}`);
      }

      const listed = await listProcesses();

      if (pid !== undefined) {
        const built = await getAncestorPidChain(pid, listed);
        const found = listed.processes.find((p) => p.pid === pid) ?? null;
        return {
          process: found ? entryToJson(found) : null,
          image: await resolveProcessImage(pid),
          ancestors: built.chain.map((ancestorPid) => ({
            pid: ancestorPid,
            command: listed.processes.find((p) => p.pid === ancestorPid)?.command ?? null,
          })),
          chainComplete: built.complete,
          source: listed.source,
          complete: listed.complete,
          notes: found ? listed.notes : [...listed.notes, `pid ${pid} not present in this enumeration`],
        };
      }

      const selected = selectProcesses(listed.processes, {
        pids: pids as number[] | undefined,
        nameContains: nameContains as string | undefined,
        sort: sort === 'pid' ? 'pid' : 'rss',
        limit: limit === undefined ? 200 : (limit as number),
      });
      return {
        processes: selected.selected.map(entryToJson),
        matched: selected.matched,
        total: selected.total,
        truncated: selected.truncated,
        source: listed.source,
        complete: listed.complete,
        notes: listed.notes,
      };
    },
  };
}
