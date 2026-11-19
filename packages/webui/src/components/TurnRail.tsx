import { useState } from 'react';
import { useT } from '../i18n/react';
import type { TurnMarker } from './turn-rail';

/**
 * 会话 turn 定位轨：贴中栏左缘的悬浮列，每个 turn 首一个标识。
 * 常态半透明不挡阅读，悬浮全显并弹出该轮用户输入预览；点击跳转
 * （未加载的 turn 由调用方先向前分页加载再定位）。
 */
export function TurnRail({
  markers,
  activeKey,
  busyKey,
  onJump,
}: {
  markers: TurnMarker[];
  /** 当前视口所处 turn 的 key（滚动追踪） */
  activeKey: string | null;
  /** 正在加载定位的 marker key */
  busyKey: string | null;
  onJump: (marker: TurnMarker) => void;
}) {
  const t = useT();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  if (markers.length === 0) return null;
  return (
    <nav className="turn-rail" aria-label={t('chatWorkspace.turnRailLabel')}>
      {markers.map((m) => {
        const busy = m.key === busyKey;
        return (
          <div
            key={m.key}
            className="turn-rail-row"
            onMouseEnter={() => setHoverKey(m.key)}
            onMouseLeave={() => setHoverKey((k) => (k === m.key ? null : k))}
          >
            <button
              type="button"
              className={`turn-rail-item${m.key === activeKey ? ' active' : ''}${busy ? ' busy' : ''}`}
              aria-label={m.text.slice(0, 80) || t('chatWorkspace.turnJumpHint')}
              aria-current={m.key === activeKey ? 'true' : undefined}
              onFocus={() => setHoverKey(m.key)}
              onBlur={() => setHoverKey((k) => (k === m.key ? null : k))}
              onClick={() => onJump(m)}
            >
              <span className="turn-rail-tick" />
            </button>
            {hoverKey === m.key && (
              <div className="turn-rail-tip" role="tooltip">
                <div className="turn-rail-tip-time">{new Date(m.createdAt).toLocaleString()}</div>
                <div className="turn-rail-tip-text">{m.text}</div>
                {(busy || !m.loaded) && (
                  <div className="turn-rail-tip-hint">
                    {busy ? t('chatWorkspace.turnRailLoading') : t('chatWorkspace.turnLoadJumpHint')}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
