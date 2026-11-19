// @vitest-environment jsdom
/**
 * LoginPage — 两层凭证的登录面（m4）。
 *
 * 回归锚：apiKey 闸 401 不是密码错（第三错误态），且缺钥匙时登录页必须有
 * 获取/输入访问密钥的通道（否则远程/局域网用户鸡生蛋：无钥匙登不进去、
 * 登不进去无处填钥匙）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { LoginPage } from './LoginPage';
import { setConsoleKey } from '../console-key';

const registryLogin = vi.fn();
vi.mock('@octopi-agent/gateway/web/sdk/client.js', () => ({
  OctopiClient: class {
    registryLogin = registryLogin;
  },
}));

/** 字段输入框（htmlFor/id 关联的 label） */
function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe('LoginPage', () => {
  beforeEach(() => {
    registryLogin.mockReset();
    setConsoleKey(''); // console-key 有模块级内存缓存：先清，再清 localStorage（测试隔离）
    localStorage.clear();
    // jsdom 无 matchMedia（ThemeToggle 的 system 跟随）：最小桩
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
  });

  it('缺访问密钥时补一条密钥输入（远程/局域网入口）', () => {
    render(<LoginPage onLoggedIn={() => {}} />);
    expect(screen.getByText('访问密钥')).toBeTruthy();
  });

  it('本机已自动下发密钥时不打扰（不渲染密钥输入）', () => {
    localStorage.setItem('octopi.console.apiKey', 'injected-key');
    render(<LoginPage onLoggedIn={() => {}} />);
    expect(screen.queryByText('访问密钥')).toBeNull();
  });

  it('填入密钥后登录：密钥持久化、凭据按 (name, password) 提交', async () => {
    registryLogin.mockResolvedValue('token-1');
    const onLoggedIn = vi.fn();
    render(<LoginPage onLoggedIn={onLoggedIn} />);
    fireEvent.change(field('访问密钥'), { target: { value: 'the-access-key' } });
    fireEvent.change(field('用户名'), { target: { value: 'admin' } });
    fireEvent.change(field('密码'), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '登录' }));
    });
    expect(onLoggedIn).toHaveBeenCalled();
    expect(localStorage.getItem('octopi.console.apiKey')).toBe('the-access-key');
    expect(registryLogin).toHaveBeenCalledWith({ name: 'admin', password: 'pw' });
  });

  it('apiKey 闸拒绝 = 第三错误态（不是密码错），并展开密钥输入', async () => {
    localStorage.setItem('octopi.console.apiKey', 'wrong-key');
    registryLogin.mockRejectedValue(new Error('Unauthorized: invalid or missing API key'));
    render(<LoginPage onLoggedIn={() => {}} />);
    fireEvent.change(field('用户名'), { target: { value: 'admin' } });
    fireEvent.change(field('密码'), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '登录' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('访问密钥缺失或不正确');
    expect(screen.queryByText('用户名或密码不正确')).toBeNull();
    expect(screen.getByText('访问密钥')).toBeTruthy();
  });

  it('密码错维持防枚举文案（不冒充服务故障）', async () => {
    localStorage.setItem('octopi.console.apiKey', 'injected-key');
    registryLogin.mockRejectedValue(new Error('invalid_credentials'));
    render(<LoginPage onLoggedIn={() => {}} />);
    fireEvent.change(field('用户名'), { target: { value: 'admin' } });
    fireEvent.change(field('密码'), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '登录' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('用户名或密码不正确');
    expect(screen.queryByText('访问密钥')).toBeNull();
  });

  it('陈旧密钥在密钥框空提交时清除（不再拿错钥匙打转）', async () => {
    localStorage.setItem('octopi.console.apiKey', 'wrong-key');
    registryLogin
      .mockRejectedValueOnce(new Error('Unauthorized: invalid or missing API key'))
      .mockResolvedValue('t');
    const onLoggedIn = vi.fn();
    render(<LoginPage onLoggedIn={onLoggedIn} />);
    fireEvent.change(field('用户名'), { target: { value: 'admin' } });
    fireEvent.change(field('密码'), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '登录' }));
    });
    expect(field('访问密钥')).toBeTruthy(); // 首败展开密钥框
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '登录' }));
    });
    expect(localStorage.getItem('octopi.console.apiKey')).toBeNull(); // 空提交清掉陈旧缓存
    expect(onLoggedIn).toHaveBeenCalled();
    expect(registryLogin).toHaveBeenLastCalledWith({ name: 'admin', password: 'pw' });
  });
});
