/**
 * 平台能力探测：哪些 POSIX 语义在当前平台上真的成立。
 *
 * 为什么需要一个共享常量：`statSync(path).mode & 0o777` 在 Windows 上恒报 `0o666`
 * 形态（与 `writeFile` 的 `mode`、`chmodSync` 都无关），因此在 Windows 上
 * 「权限位是否过宽」的判定只能得到假阳性——`plugin doctor` 曾因此对每个 state 目录
 * 都报 warn。这类判定必须集中在同一处，否则生产代码与测试会各自写一份平台判断并漂移。
 *
 * Windows 的真实保护面是 NTFS ACL（用户 profile 目录默认私有），`stat` 看不到它；
 * 那里只能断言"写入方请求了 0600"这一意图，不能断言结果。
 */

/**
 * 当前平台是否支持 POSIX 文件权限位（Windows 不支持）。
 *
 * 注意这是**平台能力**而非"平台名"：判断放在这里而不是散落 `process.platform === 'win32'`，
 * 是为了让生产侧（`plugin doctor`）与测试侧（文件权限断言）用同一个口径。
 */
export const POSIX_FILE_MODE: boolean = process.platform !== 'win32';
