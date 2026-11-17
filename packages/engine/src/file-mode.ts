/**
 * 平台能力探测 + 秘密文件的真实权限收紧。
 *
 * ## 为什么不能只靠 `mode: 0o600`
 *
 * `statSync(path).mode & 0o777` 在 Windows 上恒报 `0o666` 形态，与 `writeFile` 的
 * `mode`、`chmodSync` 都无关——所以「用 mode 保护秘密文件」在 Windows 上**完全不生效**。
 * 实测：`writeFileSync(f, '{"apiKey":"sk-..."}', {mode:0o600})` 之后，`f` 的 ACL 仍是
 * 从父目录继承来的一串主体（含一个可修改的用户组与多个可读写 SID）。也就是说秘密
 * 文件的保护面完全由**它落在哪个目录**决定。
 *
 * ## 因此这里的契约是「收紧，而不是请求」
 *
 * - POSIX：`chmod` 就是真实生效的收紧。
 * - Windows：改成 ACL——`icacls <target> /inheritance:r /grant:r "<user>:F"`，移除
 *   继承并只授予当前用户。实测收紧后目录为 `user:(OI)(CI)(F)`、其中新建文件自动继承
 *   `user:(I)(F)`，不再有其他主体。
 *
 * 收紧失败时**不留文件**：一个已知不安全的秘密文件比没有文件更糟（调用方拿到的是
 * "写成功"的假象）。`writeSecretFileSync` 会删掉已写内容再抛错。
 *
 * ## 平台判断为什么集中在这里
 *
 * 生产侧（`plugin doctor`、boot 文件写入）与测试侧（权限断言）必须同一口径，否则会
 * 各自漂移——`plugin doctor` 曾因在 Windows 上判 `mode & 0o077` 而对每个 state 目录
 * 误报告警。
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 当前平台是否支持 POSIX 文件权限位（Windows 不支持）。
 *
 * 注意这是**平台能力**而非"平台名"：判断放在这里而不是散落 `process.platform === 'win32'`，
 * 是为了让生产侧与测试侧用同一个口径。
 */
export const POSIX_FILE_MODE: boolean = process.platform !== 'win32';

/** `icacls` 收紧要授予的主体（授权目标）。 */
let cachedPrincipal: OwnerPrincipal | null | undefined;

type OwnerPrincipal = { form: 'sid' | 'name'; value: string };

/**
 * 取当前进程令牌的 SID 作为授权主体。
 *
 * 为什么不用 `USERDOMAIN\USERNAME`：那两个环境变量不是身份权威，且可被父进程污染。
 * 真实失败面包括——服务/计划任务下常缺失；Azure AD 加入的机器上 `USERDOMAIN` 是计算机名，
 * `MACHINE\user` 无法解析（icacls 报 status 1332）；同名/改名账户可能解析到他人主体
 * （不报错，但把秘密授权给了错误账户）。SID 与本机域/工作组/AAD/系统语言全部解耦。
 *
 * `whoami` 必须用绝对路径：Windows 上常见 Git Bash 的 coreutils `whoami` 排在 WINPATH 前面，
 * 它不认识 `/user /fo csv`（实测报 `extra operand '/user'`）。
 *
 * @returns 可交给 icacls 的主体；无法确定时返回 null（由调用方决定降级策略）
 */
function currentOwnerPrincipal(): OwnerPrincipal | null {
  // 进程内缓存：一个进程的令牌主体不会变，而每次 restrictToOwner 起一个 whoami.exe
  // 是纯浪费（credentials 打开一次最多 4 次调用）。
  if (cachedPrincipal !== undefined) return cachedPrincipal;
  cachedPrincipal = resolveOwnerPrincipal();
  return cachedPrincipal;
}

/**
 * 解析当前令牌主体（不做缓存）。
 *
 * @returns 可交给 icacls 的主体；无法确定时返回 null（由调用方决定降级策略）
 */
function resolveOwnerPrincipal(): OwnerPrincipal | null {
  const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
  try {
    const raw = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    // 形如 `"machine\user","S-1-5-21-..."`
    const sid = raw.trim().replace(/^"|"$/g, '').split('","').pop();
    if (sid && /^S-\d+(-\d+)+$/.test(sid)) return { form: 'sid', value: sid };
  } catch {
    /* whoami 不可用：退到名字形式，仍由 icacls 的 exit code 兜底判定成败 */
  }
  const username = process.env.USERNAME ?? '';
  const domain = process.env.USERDOMAIN ?? '';
  if (!username) return null;
  // 名字形式只作兜底：工作组下 USERDOMAIN 是机器名，域下是域名，两种都能解析
  return { form: 'name', value: domain ? `${domain}\\${username}` : username };
}

/**
 * 把目标收紧到「仅当前用户可访问」。
 *
 * @param target - 文件或目录路径
 * @param kind - `dir` 用继承形式授权（`(OI)(CI)`），使其中新建的文件自动安全
 * @throws 当无法收紧时抛出（调用方不得把它当作可忽略的告警）
 */
export function restrictToOwner(target: string, kind: 'file' | 'dir'): void {
  if (POSIX_FILE_MODE) {
    chmodSync(target, kind === 'dir' ? 0o700 : 0o600);
    return;
  }
  const owner = currentOwnerPrincipal();
  if (!owner) {
    throw new Error(
      `[permissions] cannot restrict ${target}: could not determine the current user (whoami unavailable and USERNAME unset)`,
    );
  }
  // icacls 的输出是本地化的，只可信 exit code（非 0 时 execFileSync 会抛）。
  // windowsHide 不可省：否则在无控制台的宿主里又会长出一个控制台窗口。
  // `/inheritance:r /grant:r` 只处理**继承**来的 ACE 与"同一主体"的显式 ACE：目标上若有
  // 别人显式授予的条目（老版本留下的宽松权限正是如此），它会原地留着。实测对
  // `icacls <dir> /grant *S-1-5-32-545:(OI)(CI)R` 造宽过的目录，直接用本函数收紧后
  // `BUILTIN\Users` 仍留在 DACL 上；先 `/reset`（重置为从父继承）再收紧才彻底。
  try {
    execFileSync('icacls', [target, '/reset'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* 无法 reset（非 NTFS / 权限不足）时仍尝试下面的收紧；成败由它决定 */
  }
  // `*S-1-5-…` 是「按 SID 授权」的形式（icacls 语法）；名字形式不能带 `*`。
  const grantee = owner.form === 'sid' ? `*${owner.value}` : owner.value;
  execFileSync(
    'icacls',
    [
      target,
      '/inheritance:r',
      '/grant:r',
      kind === 'dir' ? `${grantee}:(OI)(CI)F` : `${grantee}:F`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

/**
 * 创建仅当前用户可访问的临时目录。
 *
 * 秘密文件应放这里而非直接平铺在共享 tmpdir：目录收紧后，其中新建文件自动继承安全
 * ACL，等于在创建时就消除了暴露窗口。
 *
 * @param prefix - 目录名前缀（便于诊断）
 * @returns 私有临时目录的绝对路径
 */
export function createPrivateTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    restrictToOwner(dir, 'dir');
  } catch (err) {
    // 建得出却收紧不了：该目录不能用来放秘密，清掉再抛（不留隐患目录）
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败是次要问题：主错误（无法收紧）才是调用方要看到的 */
    }
    throw err;
  }
  return dir;
}

/**
 * 同步写入秘密文件，并把权限真实收紧到仅当前用户。
 *
 * 与 `writeFileSync(..., {mode: 0o600})` 的区别：后者在 Windows 上不生效。
 *
 * 三步走（写 tmp → 收紧 tmp → rename）而不是直接写目标：目标可能已存在且是**有效**的
 * 旧秘密（例如上一轮签发的 setup token）。直接写再收紧的话，一旦收紧失败就得删文件，
 * 等于把旧秘密一起毁掉。这个顺序同时消除了「写完成 → 收紧完成」之间的暴露窗口；
 * 同卷 rename 不会重新继承 ACL（实测 Windows 上收紧后的 ACL 完整保留）。
 *
 * @param filePath - 目标路径（父目录应当已经是私有的，见 {@link createPrivateTempDir}）
 * @param data - 文件内容
 * @throws 当权限无法收紧时（此时目标文件保持原状，临时文件已删除）
 */
export function writeSecretFileSync(filePath: string, data: string): void {
  const staging = `${filePath}.staging`;
  writeFileSync(staging, data, { encoding: 'utf8', mode: 0o600 });
  try {
    restrictToOwner(staging, 'file');
  } catch (err) {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* 删不掉时仍要抛出收紧失败：调用方至少知道有一份未收紧的副本存在 */
    }
    throw err;
  }
  renameSync(staging, filePath);
}
