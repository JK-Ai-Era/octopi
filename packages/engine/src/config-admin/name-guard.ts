/**
 * 配置名安全守卫 — provider 名 / agent id 通用（router 与 ConfigApplyService 单一实现点）
 *
 * 拒：路径穿越（`.` / `..` / 点开头）、原型污染键、Windows 尾点/尾空格形态。
 *
 * @module
 */

/**
 * 断言配置名合法（路径段安全 + JSON 键安全）
 *
 * @param name - provider 名或 agent id
 * @throws 非法名抛错（调用方映射业务 400）
 */
export function assertSafeConfigName(name: string): void {
  const validShape =
    /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name) &&
    !name.endsWith('.') &&
    !name.endsWith(' ');
  if (
    !validShape ||
    name === '.' ||
    name === '..' ||
    ['__proto__', 'constructor', 'prototype'].includes(name)
  ) {
    throw new Error(`invalid config name: ${name}`);
  }
}
