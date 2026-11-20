// @vitest-environment jsdom
/**
 * AccessKeyGate — 个人模式填钥页（凭据被拒后的重新录入入口）。
 *
 * 回归锚：提交必须把填写的密钥交给 onSubmit（trim 后），空密钥不提交。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AccessKeyGate } from './AccessKeyGate';

describe('AccessKeyGate', () => {
  beforeEach(() => {
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

  it('提交填写的访问密钥（trim 后交给 onSubmit）', () => {
    const onSubmit = vi.fn();
    render(<AccessKeyGate onSubmit={onSubmit} />);
    const input = screen.getByLabelText('访问密钥') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  pasted-key  ' } });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('pasted-key');
  });

  it('空密钥不提交', () => {
    const onSubmit = vi.fn();
    render(<AccessKeyGate onSubmit={onSubmit} />);
    const input = screen.getByLabelText('访问密钥') as HTMLInputElement;
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('「刚被拒」一次性提示：渲染错误行，输入后撤下，再挂载不再显示（m6）', () => {
    sessionStorage.setItem('octopi.console.keyRejected', '1');
    render(<AccessKeyGate onSubmit={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('上次填写的访问密钥被网关拒绝，请确认后重新输入。');
    // 输入即视为重新开始，错误行撤下
    fireEvent.change(screen.getByLabelText('访问密钥'), { target: { value: 'x' } });
    expect(screen.queryByRole('alert')).toBeNull();
    // 一次性消费：重新挂载不再显示
    cleanup();
    render(<AccessKeyGate onSubmit={() => {}} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('无「被拒」标记时不渲染错误行', () => {
    render(<AccessKeyGate onSubmit={() => {}} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
