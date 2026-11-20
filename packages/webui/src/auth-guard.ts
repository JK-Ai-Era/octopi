/**
 * auth-guard — 凭据失效的统一处置（SDK 鉴权失败事件的 webui 侧收口）。
 *
 * 背景：重新初始化（OCTOPI_HOME 删除重建）会换掉随机 apiKey / registry.db，而浏览器
 * localStorage 里缓存的旧凭据仍在生效（localStorage 优先于 serve-webui 本机自动下发），
 * 表现为 WS 死循环「连接已断开，正在重连…」或设置页裸 401（invalid X-Registry-Token）。
 * 此处统一处置：网关明确拒绝（WS 4001 / HTTP 401）→ 清掉被拒的陈旧凭据 →
 * 能自动恢复（本机有更新的自动下发钥）就整页重建；否则回登录页（②③模式）/ 填钥页（个人模式）。
 *
 * 安全口径：只处理「当前在用凭据被拒」的失败——用户在设置里试验新钥/新地址的
 * 失败不动全局态（那个失败属于输入框，不属于已存凭据）。
 */

import type { AuthFailureInfo } from '@octopi-agent/gateway/web/sdk/client.js';
import { setAuthFailureHandler } from '@octopi-agent/gateway/web/sdk/client.js';
import { getConsoleKey, setConsoleKey, getRegistryToken, setRegistryToken } from './console-key';
import { resolveDefaultBase } from './gateway-base';
import { requiresLogin } from './runtime-config';

/** 凭据闸形态：none=正常；login=回登录页（②③）；key=回填钥页（个人模式） */
export type CredentialGate = 'none' | 'login' | 'key';

/** 填钥页提交记录（sessionStorage：reload 后仍可判「刚提交的钥」） */
const PENDING_KEY_FLAG = 'octopi.console.pendingKey';
/** 「刚提交的钥被拒」一次性提示标记（handleAuthFailure 置位，填钥页消费） */
const KEY_REJECTED_FLAG = 'octopi.console.keyRejected';

let gate: CredentialGate = 'none';
const gateListeners = new Set<(g: CredentialGate) => void>();

/**
 * 读当前凭据闸形态。
 *
 * @returns 当前闸形态
 */
export function getCredentialGate(): CredentialGate {
  return gate;
}

/**
 * 订阅凭据闸变化。
 *
 * @param listener - 变化回调
 * @returns 退订函数
 */
export function onCredentialGateChange(listener: (g: CredentialGate) => void): () => void {
  gateListeners.add(listener);
  return () => {
    gateListeners.delete(listener);
  };
}

/** 切闸（幂等；变化才通知） */
function setGate(next: CredentialGate): void {
  if (gate === next) return;
  gate = next;
  for (const listener of [...gateListeners]) listener(next);
}

/** 登录成功 / 无需闸时复位（LoginPage onLoggedIn 调用） */
export function resetCredentialGate(): void {
  setGate('none');
}

/**
 * 填钥页提交（AccessKeyGate 调用）：存新钥后整页重建。
 * 整页重建顺带清掉各面板 client 实例里揣着的旧凭据快照（一处清不干净的都清掉）。
 * 提交前打一次性标记：若这把钥随后被拒，填钥页能明说「上次的钥被拒」而非重播原标题。
 *
 * @param key - 用户填写的访问密钥
 */
export function submitConsoleKey(key: string): void {
  const trimmed = key.trim();
  setConsoleKey(trimmed);
  try {
    window.sessionStorage.setItem(PENDING_KEY_FLAG, trimmed);
  } catch {
    // 存储不可用：退化为无「刚被拒」提示，不阻塞提交
  }
  window.location.reload();
}

/**
 * 消费「上次填写的钥刚被网关拒绝」提示（AccessKeyGate 挂载时调用，一次性）。
 *
 * @returns true = 刚有提交的钥被拒
 */
export function consumePendingKeyRejected(): boolean {
  try {
    if (window.sessionStorage.getItem(KEY_REJECTED_FLAG) === null) return false;
    window.sessionStorage.removeItem(KEY_REJECTED_FLAG);
    return true;
  } catch {
    return false;
  }
}

/** 刚提交的钥被拒 → 置一次性提示标记（与提交记录对账，不误报陈旧钥场景） */
function markPendingKeyRejected(failedKey: string): void {
  try {
    if (window.sessionStorage.getItem(PENDING_KEY_FLAG) === failedKey) {
      window.sessionStorage.removeItem(PENDING_KEY_FLAG);
      window.sessionStorage.setItem(KEY_REJECTED_FLAG, '1');
    }
  } catch {
    // 存储不可用：退化为无「刚被拒」提示
  }
}

/**
 * 鉴权失败处置（installAuthFailureHandler 注册后由 SDK 自动调用）。
 *
 * 处置链：比对失败凭据是否「当前在用」→ 清陈旧凭据 → 自动恢复（更新的下发钥可用）
 * 或切闸（login / key）。
 *
 * @param info - 鉴权失败负载（含失败连接携带的凭据）
 */
export function handleAuthFailure(info: AuthFailureInfo): void {
  const failedKey = info.failedApiKey ?? '';
  const failedToken = info.failedRegistryToken ?? '';

  // 归因收敛：无法归因的 HTTP 401（反代/其它鉴权面/未来端点文案）不动任何凭据；
  // WS 4001 按协议只会是鉴权拒绝，而 webui 的 WS auth 帧只带 apiKey——保守归为 apiKey 失效
  const reason =
    info.reason === 'unknown' && info.source === 'ws' ? ('apiKey' as const) : info.reason;
  if (reason === 'unknown') return;

  // 只认「当前在用凭据被拒」：揣着旧凭据的残留实例/试验中的新钥失败不动作。
  // 比对只看被拒的那一种凭据——失败客户端未必携带另一层凭据（如 WS 连接只带 apiKey），
  // 把没携带的也算进不匹配会把真实失效漏成「不动作」。
  if (reason === 'apiKey') {
    if (failedKey !== getConsoleKey()) return;
  } else if (failedToken !== getRegistryToken()) {
    return;
  }

  // 目标地址归因：只处置「当前配置的网关」拒掉的凭据。手填地址切到另一台网关后，
  // 旧 client 实例揣着在用的钥撞 401——那是地址没切完，不是钥失效，不许清钥
  if (info.baseUrl.replace(/\/+$/, '') !== resolveDefaultBase().replace(/\/+$/, '')) return;

  if (requiresLogin()) {
    // ②③模式：身份（registryToken）或访问密钥失效都回登录页重新登录；
    // 两个都清掉——登录页缺钥时会展开「访问密钥」输入框（本机自动下发的会重新填入）
    setRegistryToken('');
    setConsoleKey('');
    setGate('login');
    return;
  }

  if (reason === 'registryToken') {
    // 个人模式的陈旧租户 token：清掉即回宿主面语义（无 token = host），整页重建刷新实例
    setRegistryToken('');
    window.location.reload();
    return;
  }

  // apiKey 失效：清掉存储的钥；本机自动下发的新钥（serve-webui 注入）
  // 与被拒的不同 → 无感恢复；否则切到填钥页让用户重新录入
  markPendingKeyRejected(failedKey);
  setConsoleKey('');
  const freshKey = getConsoleKey();
  if (freshKey && freshKey !== failedKey) {
    window.location.reload();
  } else {
    setGate('key');
  }
}

/**
 * 安装全局鉴权失败处理器（App 启动调用一次）。
 *
 * @returns 卸载函数
 */
export function installAuthFailureHandler(): () => void {
  return setAuthFailureHandler(handleAuthFailure);
}
