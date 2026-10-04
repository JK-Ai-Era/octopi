/**
 * 索引操作反馈条 — 点击后立刻回执，避免「有没有生效」黑盒
 */
import { useCallback, useState } from 'react';

export type OpTone = 'info' | 'ok' | 'warn';

export interface OpFeedbackState {
  tone: OpTone;
  text: string;
  at: number;
}

export function OpFeedback({ op }: { op: OpFeedbackState | null }) {
  if (!op) return null;
  return (
    <div className={`kn-op-feedback small ${op.tone}`} role="status" aria-live="polite">
      {op.text}
    </div>
  );
}

/** 操作回执 + 按钮忙态 */
export function useOpFeedback() {
  const [op, setOp] = useState<OpFeedbackState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const show = useCallback((text: string, tone: OpTone = 'ok') => {
    setOp({ tone, text, at: Date.now() });
  }, []);

  const run = useCallback(
    async <T,>(
      key: string,
      fn: () => Promise<T>,
      onOk?: (result: T) => void | Promise<void>,
      timeoutMs = 15_000,
    ): Promise<void> => {
      if (busy) return;
      setBusy(key);
      show('处理中…', 'info');
      try {
        const result = await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    timeoutMs >= 1000
                      ? `请求超时（${Math.round(timeoutMs / 1000)}s）：服务可能正忙于解析/向量回填，请稍后看统计条是否变化`
                      : '请求超时',
                  ),
                ),
              timeoutMs,
            ),
          ),
        ]);
        await onOk?.(result);
      } catch (err) {
        show(err instanceof Error ? err.message : String(err), 'warn');
      } finally {
        setBusy(null);
      }
    },
    [busy, show],
  );

  return { op, busy, show, run, clearOp: () => setOp(null) };
}
