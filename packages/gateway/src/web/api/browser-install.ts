/**
 * web/api/browser-install — 浏览器引擎安装任务（WebUI 设置页消费）
 *
 * 一次性安装任务的进程内注册表：`installEngine` 的输出按行缓冲进任务，前端轮询
 * 读取（router 无流式先例——不为进度发明 SSE 基建）。进程重启任务丢失可接受：
 * 安装幂等，重跑即可，故不引入持久化。
 */

import { randomUUID } from 'node:crypto';
import {
  installEngine,
  probeEngines,
  type EngineStatus,
} from '@octopi-agent/engine/integration/browser/install.js';

/** 任务视图（前端轮询消费的形状） */
export interface BrowserInstallJobView {
  id: string;
  engine: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  /** 汇总（done/failed 时为 installEngine 的 detail） */
  detail?: string;
  /** 进度输出（保留最近 MAX_LINES 行） */
  lines: string[];
  /** 输出曾被截断（fail-loud 标记，不静默丢行） */
  truncated: boolean;
}

const MAX_LINES = 400;

const VALID_ENGINES: ReadonlySet<string> = new Set(['playwright', 'rebrowser', 'camoufox', 'stealth']);

export class BrowserInstallJobs {
  private readonly jobs = new Map<string, BrowserInstallJobView>();
  /** 同引擎并发闸：安装中拒绝新任务（幂等重跑的前提是不并发写同目录） */
  private readonly running = new Set<string>();

  /**
   * @param installer - 安装实现（缺省 engine 的 installEngine；测试可注入假实现）
   */
  constructor(private readonly installer: typeof installEngine = installEngine) {}

  /**
   * 探测全部引擎就绪状态。
   *
   * @returns 各引擎状态（探测口径见 EngineStatus.detail）
   */
  status(): EngineStatus[] {
    return probeEngines();
  }

  /**
   * 启动安装任务（异步：立即返回任务视图，输出渐进可查）。
   *
   * @param engine - 引擎名（playwright | rebrowser | camoufox | stealth）
   * @returns 任务视图；引擎非法或同引擎安装在途时返回 { error }
   */
  start(engine: string): BrowserInstallJobView | { error: string } {
    if (!VALID_ENGINES.has(engine)) {
      return {
        error: `unknown browser engine "${engine}" — supported: playwright | rebrowser | camoufox | stealth`,
      };
    }
    if (this.running.has(engine)) {
      return { error: `install already running for engine "${engine}" — wait for it to finish` };
    }
    const job: BrowserInstallJobView = {
      id: randomUUID(),
      engine,
      status: 'running',
      startedAt: new Date().toISOString(),
      lines: [],
      truncated: false,
    };
    this.jobs.set(job.id, job);
    this.running.add(engine);
    const push = (line: string): void => {
      job.lines.push(line);
      if (job.lines.length > MAX_LINES) {
        job.lines.splice(0, job.lines.length - MAX_LINES);
        job.truncated = true;
      }
    };
    void this.installer(engine, { onProgress: push })
      .then((result) => {
        job.status = result.ok ? 'done' : 'failed';
        job.detail = result.detail;
        job.finishedAt = new Date().toISOString();
      })
      .catch((err: unknown) => {
        // 安装器自身异常也要落到任务里（前端能看到失败依据，不是无声卡死）
        job.status = 'failed';
        job.detail = err instanceof Error ? err.message : String(err);
        job.finishedAt = new Date().toISOString();
        push(`[!] install crashed: ${job.detail}`);
      })
      .finally(() => {
        this.running.delete(engine);
      });
    return job;
  }

  /**
   * 按任务 id 取任务视图。
   *
   * @param id - 任务 id（start 返回值的 id）
   * @returns 任务视图；不存在时 undefined
   */
  get(id: string): BrowserInstallJobView | undefined {
    return this.jobs.get(id);
  }
}
