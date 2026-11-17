/**
 * forkChildNodeOptions — fork 本地 node 子进程的选项单一出口。
 *
 * 集中在一处的理由：这里每一项都是「不写就静默出问题」的配置，分散手抄必然以
 * 「有人漏了其中一个」的方式复发 —— `run-serve-child` 就漏了 `windowsHide`：
 *
 * - `windowsHide`：Windows 上父进程**没有控制台**（detached daemon / 服务宿主）时，
 *   console 子系统的子进程会被分配一个新的**可见**控制台窗口，且随实例存活不消失。
 *   注意判断依据是「是否分配控制台」，不是 `stdio`（`stdio` 只管句柄继承）：
 *   `stdio: 'ignore'` 的 taskkill 同样需要 `windowsHide`。
 * - `execArgv: []`：不继承父进程的箭头参数（`--inspect` / `--loader` / `--require` 等）。
 *   **不覆盖 `NODE_OPTIONS`**：那是环境变量，实测在 `execArgv: []` 下仍然生效。
 * - 剥离 `NODE_CHANNEL_*` / `NODE_UNIQUE_ID`：Node 自己 fork 出来的子进程会在 bootstrap
 *   阶段消费掉它注入的通道变量，所以在当前 Node 上这一步通常是 no-op；保留它是为了
 *   宿主（IDE 插件 / Electron / 非 node 启动器）把陈旧值留在环境里的情形——那些值会
 *   原样传给孙进程。注意：「按 advanced 序列化编码」由 `fork()` 的 `serialization`
 *   选项决定，不由环境变量决定，故此处不宣称修复编码错配。
 * - Electron 宿主：`ELECTRON_RUN_AS_NODE=1`，且调用方必须**保持** `process.execPath`
 *   （换成捆绑 node.exe 会切断 Windows 上的 fork IPC）。
 *
 * `stdio` 的前三路由调用方决定（日志经 fd 转发 vs 全静默）；`ipc` 末位由本函数追加，
 * 调用方无法漏配。
 *
 * `@types/node` 的 `ForkOptions` 未声明 `windowsHide`（运行时有效），此处只豁免该字段，
 * 其余字段仍受类型检查。
 */
import type { ChildProcess, ForkOptions } from 'node:child_process';

/** {@link stopForkedChild} 的三段等待预算（毫秒） */
export interface StopForkedChildOptions {
  /** 发 close 消息后等子进程自行收摊的宽限 */
  graceMs: number;
  /** SIGTERM 后等它退出的宽限 */
  termMs: number;
  /** SIGKILL 后仍观察 exit 的时长，超时则放行并告警 */
  reapFallbackMs: number;
  /** 告警里的调用方标识（如 `knowledge` / `run`）：兜底放行时排障要知道是谁 */
  label: string;
}

/** 调用方可选的三路 stdio 策略（取值收窄：本函数只支持这三者） */
export type ChildStdio = 'ignore' | 'inherit' | 'pipe';

/** `forkChildNodeOptions` 的调用方可变项 */
export interface ForkChildNodeOptionsInput {
  /** `[stdin, stdout, stderr]`；ipc 通道由本函数追加 */
  stdio: readonly [ChildStdio, ChildStdio, ChildStdio];
}

/**
 * 当前进程是否跑在 Electron 宿主里（打包的桌面端 / MiMo.exe）。
 *
 * `process.versions.electron` 是权威判据；execPath 正则只作兜底（老版本 Electron 或
 * 包装器可能不设 versions.electron）。兜底会误判路径中恰好含 `electron` 的普通 node
 * 宿主，代价是多设一个 `ELECTRON_RUN_AS_NODE=1`（对 node 无副作用）。
 *
 * @returns true 表示需要以 node 模式拉起 node 子进程
 */
export function isElectronHost(): boolean {
  return (
    Boolean((process.versions as { electron?: string }).electron) ||
    /electron|MiMo\.exe/i.test(process.execPath)
  );
}

/**
 * 生成本地 node 子进程的 fork 选项。
 *
 * @param input - 调用方决定的前三路 stdio 策略
 * @returns 完整 fork 选项（含 `windowsHide` 与 ipc 末位）
 */
export function forkChildNodeOptions(
  input: ForkChildNodeOptionsInput,
): ForkOptions & { windowsHide?: boolean } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_ID;
  delete env.NODE_CHANNEL_SERIALIZATION;
  delete env.NODE_UNIQUE_ID;
  if (isElectronHost()) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return {
    execArgv: [],
    stdio: [input.stdio[0], input.stdio[1], input.stdio[2], 'ipc'],
    env,
    windowsHide: true,
  };
}

/**
 * 停止一个由 {@link forkChildNodeOptions} 拉起的本地 node 子进程。
 *
 * 与「发个信号就返回」的区别：**完成条件必须是观察到 `exit`**。调用方依赖这个语义
 * （释放文件句柄后才能删目录；Windows 上删被打开的文件直接 EPERM）。
 *
 * 阶梯：`close` 消息（通道在）→ graceMs → SIGTERM → termMs → SIGKILL → reapFallbackMs
 * 兜底放行（并 warn）。兜底是为了不让不可观测的僵尸把调用方永久挂住；它牺牲了
 * 「绝对已退出」，因此必须留痕而不是静默。
 *
 * 集中在这里的原因：两处调用方（knowledge 子进程 / run 实例）曾各自实现，阶梯与兜底
 * 已经漂移——run 侧是 5s/3s 且 SIGKILL 后 `await exited` 无兜底，理论上可永久挂起。
 *
 * @param child - 目标子进程
 * @param options - 三段等待预算（毫秒）
 * @returns 子进程已退出（或兜底放行）时 resolve
 */
export async function stopForkedChild(
  child: ChildProcess,
  options: StopForkedChildOptions,
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => {
    let graceTimer: NodeJS.Timeout | undefined;
    let termTimer: NodeJS.Timeout | undefined;
    let reapFallbackTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let escalated = false;

    const finish = (): void => {
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (termTimer) clearTimeout(termTimer);
      if (reapFallbackTimer) clearTimeout(reapFallbackTimer);
      child.off('exit', finish);
      resolve();
    };

    child.once('exit', finish);

    /** SIGTERM → termMs → SIGKILL → reapFallbackMs 兜底。单发。 */
    const escalate = (): void => {
      // settled 也要查：exit 先到之后迟到的 send 错误仍可能进来，此时再武装定时器
      // 会在 promise 已 resolve 后打出假的 unobservable 告警。
      if (settled || escalated) return;
      escalated = true;
      if (graceTimer) clearTimeout(graceTimer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已经退出：exit 事件会/已把 promise 收掉 */
      }
      termTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出（同上） */
        }
        reapFallbackTimer = setTimeout(() => {
          console.warn(
            `[child-process:${options.label}] pid=${String(child.pid)} unobservable after SIGKILL; releasing stop() without exit`,
          );
          finish();
        }, options.reapFallbackMs);
        reapFallbackTimer.unref?.();
      }, options.termMs);
      termTimer.unref?.();
    };

    if (!child.connected) {
      // 通道已断（等价宿主硬死）：没有优雅关闭通道可走，直接升级
      escalate();
      return;
    }
    graceTimer = setTimeout(escalate, options.graceMs);
    graceTimer.unref?.();
    try {
      // 通道刚断时 send 不抛异常，错误只进回调——必须由回调转入升级，
      // 否则会白等满 graceMs。无回调形式会 emit 'error'，可致未捕获异常。
      child.send({ type: 'close' }, (err?: Error | null) => {
        if (err) escalate();
      });
    } catch {
      escalate();
    }
  });
}
