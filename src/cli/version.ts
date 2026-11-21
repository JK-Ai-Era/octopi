/**
 * CLI 版本号读取
 *
 * 五个包 lockstep 共享同一版本（AGENTS.md → Version Numbering Rules），因此
 * 「套件版本」只有一个值：engine 包 package.json 的 version。取自 engine 而非
 * 根包，是因为运行期 CLI 与 WebUI「关于」页都从已安装的 engine 元数据读取，
 * 二者必须同源（serve-webui 的 webConfigScript 也用它）。
 */
import enginePackage from '@octopi-agent/engine/package.json' with { type: 'json' };

/**
 * 当前安装的 Octopi 套件版本
 *
 * @returns 形如 `0.121.16` 的版本串
 */
export function getSuiteVersion(): string {
  return enginePackage.version;
}
