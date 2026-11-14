import { writeFile, rename } from 'node:fs/promises';

/**
 * 原子写 tmp 路径命名（按「写操作」唯一）。
 *
 * tmp+rename 原子写的前提：tmp 名在同一目标上绝不复用。仅 pid+毫秒 不够——
 * 同毫秒双写共用 tmp 名：先到者 rename 走 tmp，后到者 rename ENOENT；更糟时
 * 后到者 writeFile 的半截被 rename 进目标（静默损坏）。T5 演练实锤 2026-11-14
 * （sessions.json 元索引同毫秒双写）。
 *
 * 前提声明：唯一性成立域是**单机**（pid 不撞）；多机共享同一 OCTOPI_HOME（P2
 * 拓扑）时补 random 段兜底。进程内另以单调序号断言同 ms 不复用。
 *
 * @param target - 目标文件路径
 * @returns 该次写操作专属的 tmp 路径（pid + 毫秒 + 进程内单调序号 + 随机段）
 */
let seq = 0;
export function atomicTmpPath(target: string): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${target}.${process.pid}.${Date.now()}.${seq}.${rand}.tmp`;
}

/**
 * tmp+rename 原子整文件写：读侧任何时刻只见旧版或新版，绝不见半截。
 *
 * （T5 演练实锤 2026-11-14：截断式 writeFile 并发读曾 254/320 次读到空转录，
 * load→save 放大链路会把转录永久清空。）
 *
 * @param target - 目标文件路径
 * @param content - 整文件内容
 * @returns 写入完成（rename 落位）的 Promise
 */
export async function atomicWriteFile(target: string, content: string | Buffer): Promise<void> {
  const tmpPath = atomicTmpPath(target);
  await writeFile(tmpPath, content);
  await rename(tmpPath, target);
}
