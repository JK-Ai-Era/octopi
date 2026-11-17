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
import type { ForkOptions } from 'node:child_process';

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
