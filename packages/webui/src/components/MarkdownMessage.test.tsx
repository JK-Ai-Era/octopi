// @vitest-environment jsdom
/**
 * MarkdownMessage CopyButton — 真机回归锚（2026-11-28 报告：点复制没效果）。
 *
 * 根因：navigator.clipboard 仅存在于安全上下文（HTTPS/localhost）；经
 * http + 局域网 IP 访问 webui 时为 undefined，原实现空 catch 静默吞错。
 * 锁三点：
 * 1. Clipboard API 可用时走它，且提取的文本与代码块内容一致；
 * 2. 不可用时兜底 textarea + execCommand('copy')；
 * 3. 两路皆败时按钮显式显示失败反馈（不再静默）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MarkdownMessage } from './MarkdownMessage';

const CODE_BLOCK = '```js\nconst a = 1;\n```';

interface ClipboardMock {
  writeText: ReturnType<typeof vi.fn>;
}

function setClipboard(value: ClipboardMock | undefined): void {
  Object.defineProperty(navigator, 'clipboard', {
    value,
    configurable: true,
  });
}

describe('MarkdownMessage CopyButton', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  afterEach(() => {
    cleanup();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      setClipboard(undefined);
    }
    vi.restoreAllMocks();
  });

  it('copies via Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    render(<MarkdownMessage content={CODE_BLOCK} />);
    const button = screen.getByRole('button', { name: /复制代码|Copy code/i });
    fireEvent.click(button);

    await waitFor(() => expect(button.textContent).toMatch(/已复制|Copied/));
    expect(writeText).toHaveBeenCalledWith('const a = 1;\n');
  });

  it('falls back to execCommand when Clipboard API is unavailable', async () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand as unknown as typeof document.execCommand;

    render(<MarkdownMessage content={CODE_BLOCK} />);
    const button = screen.getByRole('button', { name: /复制代码|Copy code/i });
    fireEvent.click(button);

    await waitFor(() => expect(button.textContent).toMatch(/已复制|Copied/));
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('shows explicit failure feedback when both paths fail', async () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(false);
    document.execCommand = execCommand as unknown as typeof document.execCommand;

    render(<MarkdownMessage content={CODE_BLOCK} />);
    const button = screen.getByRole('button', { name: /复制代码|Copy code/i });
    fireEvent.click(button);

    await waitFor(() => expect(button.textContent).toMatch(/复制失败|Copy failed/));
    expect(execCommand).toHaveBeenCalledWith('copy');
  });
});
