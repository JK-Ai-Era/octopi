// @vitest-environment jsdom
/**
 * auth-guard — 凭据失效统一处置（新机部署/重新初始化后旧凭据被拒的回归锚）。
 *
 * 锚定行为：
 * 1. 「当前在用凭据被拒」→ 清陈旧凭据；本机有更新的自动下发钥 → 自动恢复（整页重建，reload 有断言）。
 * 2. 无可恢复钥 → 个人模式切填钥闸（key）；②③模式清双凭据切登录闸（login）。
 * 3. 不动作面：非当前凭据（残留实例/试验新钥）、非当前网关地址（试验新地址）、
 *    无法归因的 HTTP 401（反代/其它鉴权面）——一律不动全局态。
 * 4. 刚提交的钥被拒 → 一次性「被拒」提示标记（与提交记录对账，陈旧钥不误报）。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  consumePendingKeyRejected,
  getCredentialGate,
  handleAuthFailure,
  onCredentialGateChange,
  resetCredentialGate,
  submitConsoleKey,
} from './auth-guard';
import { getConsoleKey, getRegistryToken, setConsoleKey, setRegistryToken } from './console-key';
import { resolveDefaultBase } from './gateway-base';
import type { AuthFailureInfo } from '@octopi-agent/gateway/web/sdk/client.js';

/** 注入的本机自动下发钥（serve-webui `/octopi-config.js` 通道） */
function setInjectedKey(key: string | undefined): void {
  (window as unknown as { __OCTOPI_GATEWAY__?: { apiKey?: string } }).__OCTOPI_GATEWAY__ = key
    ? { apiKey: key }
    : undefined;
}

/** 部署模式注入（runtime-config 读 __OCTOPI_WEB__） */
function setDeploymentMode(mode: string | undefined): void {
  (window as unknown as { __OCTOPI_WEB__?: { deploymentMode?: string } }).__OCTOPI_WEB__ = mode
    ? { deploymentMode: mode }
    : undefined;
}

/** stub window.location.reload（jsdom 的 Unforgeable location 只能整对象替换） */
function stubReload(): { reload: ReturnType<typeof vi.fn> } {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    value: { reload },
    configurable: true,
    writable: true,
  });
  return { reload };
}

function failure(over: Partial<AuthFailureInfo> = {}): AuthFailureInfo {
  return {
    reason: 'unknown',
    source: 'ws',
    baseUrl: resolveDefaultBase(),
    message: 'Unauthorized',
    ...over,
  };
}

describe('auth-guard 凭据失效处置', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setConsoleKey('');
    setRegistryToken('');
    setInjectedKey(undefined);
    setDeploymentMode(undefined);
    resetCredentialGate();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('个人模式：陈旧 apiKey 被拒且无下发钥 → 清钥并切填钥闸', () => {
    setConsoleKey('stale-key');
    handleAuthFailure(failure({ reason: 'apiKey', failedApiKey: 'stale-key' }));
    expect(getConsoleKey()).toBe('');
    expect(getCredentialGate()).toBe('key');
  });

  it('个人模式：陈旧 apiKey 被拒但本机有更新下发钥 → 清钥并整页重建自动恢复（不切闸）', () => {
    const { reload } = stubReload();
    setConsoleKey('stale-key');
    setInjectedKey('fresh-key');
    handleAuthFailure(failure({ reason: 'apiKey', failedApiKey: 'stale-key' }));
    expect(getConsoleKey()).toBe('fresh-key');
    expect(getCredentialGate()).toBe('none');
    expect(reload).toHaveBeenCalledTimes(1); // 恢复必须真的整页重建（m4：不得假绿）
  });

  it('个人模式：陈旧 registryToken 被拒 → 清 token 并整页重建（回宿主面语义）', () => {
    const { reload } = stubReload();
    setConsoleKey('k');
    setRegistryToken('stale-token');
    handleAuthFailure(
      failure({ reason: 'registryToken', failedApiKey: 'k', failedRegistryToken: 'stale-token' }),
    );
    expect(getRegistryToken()).toBe('');
    expect(getConsoleKey()).toBe('k'); // 访问密钥未被拒：不动
    expect(getCredentialGate()).toBe('none');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('②③模式：凭据被拒 → 清双凭据并切登录闸', () => {
    setDeploymentMode('organization');
    setConsoleKey('k');
    setRegistryToken('stale-token');
    handleAuthFailure(
      failure({ reason: 'registryToken', failedApiKey: 'k', failedRegistryToken: 'stale-token' }),
    );
    expect(getConsoleKey()).toBe('');
    expect(getRegistryToken()).toBe('');
    expect(getCredentialGate()).toBe('login');
  });

  it('apiKey 被拒的客户端未携带 registryToken（如 WS 连接）→ 仍处置不失漏', () => {
    setDeploymentMode('organization');
    setConsoleKey('stale-key');
    setRegistryToken('tok');
    handleAuthFailure(failure({ reason: 'apiKey', failedApiKey: 'stale-key' }));
    expect(getConsoleKey()).toBe('');
    expect(getRegistryToken()).toBe('');
    expect(getCredentialGate()).toBe('login');
  });

  it('非当前凭据的失败（残留实例/试验新钥）→ 不动全局态', () => {
    setConsoleKey('current-key');
    handleAuthFailure(failure({ reason: 'apiKey', failedApiKey: 'experimental-key' }));
    expect(getConsoleKey()).toBe('current-key');
    expect(getCredentialGate()).toBe('none');
  });

  it('非当前网关地址的失败（试验新地址）→ 不动全局态（m3）', () => {
    setConsoleKey('current-key');
    handleAuthFailure(
      failure({ reason: 'apiKey', failedApiKey: 'current-key', baseUrl: 'http://other-gw:18180' }),
    );
    expect(getConsoleKey()).toBe('current-key');
    expect(getCredentialGate()).toBe('none');
  });

  it('无法归因的 HTTP 401（反代/其它鉴权面）→ 不清任何凭据（M2）', () => {
    setConsoleKey('current-key');
    setRegistryToken('tok');
    handleAuthFailure(
      failure({
        reason: 'unknown',
        source: 'http',
        failedApiKey: 'current-key',
        failedRegistryToken: 'tok',
        message: 'HTTP 401: unauthorized: something else entirely',
      }),
    );
    expect(getConsoleKey()).toBe('current-key');
    expect(getRegistryToken()).toBe('tok');
    expect(getCredentialGate()).toBe('none');
  });

  it('WS 无法归因的 4001 → 保守归 apiKey 失效处置（webui 的 WS auth 帧只带钥）', () => {
    setConsoleKey('stale-key');
    handleAuthFailure(failure({ reason: 'unknown', source: 'ws', failedApiKey: 'stale-key' }));
    expect(getConsoleKey()).toBe('');
    expect(getCredentialGate()).toBe('key');
  });

  it('刚提交的钥被拒 → 一次性「被拒」提示；陈旧钥场景不误报（m6）', () => {
    const { reload } = stubReload();
    // 场景 A：填钥页提交 → 整页重建后这把钥被拒 → 标记可消费一次
    submitConsoleKey('typed-key');
    expect(reload).toHaveBeenCalledTimes(1);
    handleAuthFailure(failure({ reason: 'apiKey', failedApiKey: 'typed-key' }));
    expect(getCredentialGate()).toBe('key');
    expect(consumePendingKeyRejected()).toBe(true);
    expect(consumePendingKeyRejected()).toBe(false); // 一次性

    // 场景 B：从未提交过的陈旧钥被拒 → 无「刚被拒」提示
    resetCredentialGate();
    setConsoleKey('old-stale');
    handleAuthFailure(failure({ reason: 'apiKey', failedApiKey: 'old-stale' }));
    expect(getCredentialGate()).toBe('key');
    expect(consumePendingKeyRejected()).toBe(false);
  });

  it('闸变化通知订阅者；resetCredentialGate 复位', () => {
    const seen: string[] = [];
    const off = onCredentialGateChange((g) => seen.push(g));
    setConsoleKey('stale-key');
    handleAuthFailure(failure({ reason: 'apiKey', failedApiKey: 'stale-key' }));
    resetCredentialGate();
    off();
    expect(seen).toEqual(['key', 'none']);
    expect(getCredentialGate()).toBe('none');
  });

  it('submitConsoleKey：持久化新钥（trim）后整页重建', () => {
    const { reload } = stubReload();
    submitConsoleKey('  typed-key  ');
    expect(getConsoleKey()).toBe('typed-key');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
