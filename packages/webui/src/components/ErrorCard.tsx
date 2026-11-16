/**
 * 对话流错误卡（§5d 错误三级分类）：渲染组件。
 * 纯分类逻辑在 error-classify.ts（单源，测试不碰 .tsx）。
 */

import { useState } from 'react';
import type { FlowErrorItem } from './error-classify';

export * from './error-classify';

/** 对话流错误卡（时间线节点） */
export function ErrorCard({ item }: { item: FlowErrorItem }): JSX.Element {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyDiag = (): void => {
    if (!item.diagnosticId) return;
    void navigator.clipboard.writeText(item.diagnosticId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={`error-card error-card-${item.level}`} role="alert">
      <div className="error-card-title">
        {item.level === 'support' ? '⚠' : '⚠'} {item.title}
      </div>
      {item.detail && <div className="error-card-detail">{item.detail}</div>}
      <div className="error-card-actions">
        {item.action && (
          <button type="button" className="btn-secondary small" onClick={item.action.run}>
            {item.action.label}
          </button>
        )}
        {item.diagnosticId && (
          <button type="button" className="btn-ghost small" onClick={copyDiag} title="复制诊断 ID">
            {copied ? '已复制' : `诊断 ID：${item.diagnosticId}`}
          </button>
        )}
        {item.raw && (
          <button type="button" className="btn-ghost small" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? '收起技术细节' : '技术细节'}
          </button>
        )}
      </div>
      {showRaw && item.raw && <pre className="error-card-raw">{item.raw}</pre>}
    </div>
  );
}
