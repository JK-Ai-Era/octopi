/**
 * 关于（§5d 关于组）：版本 / 帮助与快捷指引 / 文档链接。
 *
 * 版本号运行时下发（`__OCTOPI_WEB__.version`，源自 package.json——批 3-2），
 * 不硬编码在 bundle 里（版本随发布走，UI 不重编）。
 * 快捷指引单源在此（原右栏 help 组与顶栏帮助按钮入口已收编——UI 打磨批）。
 */

import { getProductVersion } from '../runtime-config';
import { useT } from '../i18n/react';
import type { MessageKey } from '../i18n/core';

/** 文档与源码链接（产品页文案；仓库搬家时随 package.json homepage 同步改） */
const LINKS = {
  repo: 'https://github.com/JK-Ai-Era/octopi',
  docs: 'https://github.com/JK-Ai-Era/octopi/tree/main/docs',
  changelog: 'https://github.com/JK-Ai-Era/octopi/blob/main/CHANGELOG.md',
} as const;

/** 快捷键表：`keys` 为键面原文（技术标识不译），`keysKey` 为需要本地化的键面文字 */
const SHORTCUTS: Array<{ keys?: string; keysKey?: MessageKey; desc: MessageKey }> = [
  { keys: 'Enter', desc: 'aboutPanel.shortcutEnter' },
  { keys: 'Shift+Enter', desc: 'aboutPanel.shortcutNewline' },
  { keys: '/stop', desc: 'aboutPanel.shortcutStop' },
  { keys: '/', desc: 'aboutPanel.shortcutSlash' },
  { keys: 'Esc', desc: 'aboutPanel.shortcutEsc' },
  { keysKey: 'aboutPanel.shortcutAttachKeys', desc: 'aboutPanel.shortcutAttach' },
];

export function AboutPanel(): JSX.Element {
  const t = useT();
  const version = getProductVersion();
  return (
    <div className="about-page">
      <div className="about-hero panel">
        <div className="about-hero-mark" aria-hidden>🐙</div>
        <div>
          <h3 className="about-hero-title">Octopi Web</h3>
          <div className="small muted">{t('aboutPanel.tagline')}</div>
          <div className="small" style={{ marginTop: 6 }}>
            {t('aboutPanel.versionLabel')}{' '}
            <code>{version ? `v${version}` : t('aboutPanel.versionUnknown')}</code>
          </div>
        </div>
      </div>

      <div className="about-grid">
        <div className="panel about-card">
          <h4 className="about-card-title">{t('aboutPanel.shortcutsTitle')}</h4>
          <table className="about-shortcuts">
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.keys ?? s.keysKey}>
                  <td><kbd>{s.keysKey ? t(s.keysKey) : s.keys}</kbd></td>
                  <td>{t(s.desc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel about-card">
          <h4 className="about-card-title">{t('aboutPanel.layoutTitle')}</h4>
          <ul className="small about-list">
            <li><b>{t('aboutPanel.layoutLeftLabel')}</b>{t('aboutPanel.layoutLeftDesc')}</li>
            <li><b>{t('aboutPanel.layoutCenterLabel')}</b>{t('aboutPanel.layoutCenterDesc')}</li>
            <li><b>{t('aboutPanel.layoutRightLabel')}</b>{t('aboutPanel.layoutRightDesc')}</li>
            <li>
              {t('aboutPanel.layoutResizePrefix')}<b>{t('aboutPanel.layoutResizeDrag')}</b>
              {t('aboutPanel.layoutResizeMiddle')}<b>{t('aboutPanel.layoutResizeReset')}</b>
            </li>
            <li>{t('aboutPanel.layoutPanelToggle')}</li>
            <li>{t('aboutPanel.layoutServices')}</li>
          </ul>
        </div>

        <div className="panel about-card about-card-wide">
          <h4 className="about-card-title">{t('aboutPanel.conventionsTitle')}</h4>
          <ul className="small about-list">
            <li>{t('aboutPanel.convModelOverride')}</li>
            <li>{t('aboutPanel.convContext')}</li>
            <li>{t('aboutPanel.convAttachments')}</li>
            <li>
              {t('aboutPanel.convGitPrefix')}<code>web.gitStatusPollSeconds</code>
              {t('aboutPanel.convGitSuffix')}
            </li>
            <li>{t('aboutPanel.convContextLayers')}</li>
          </ul>
        </div>

        <div className="panel about-card about-card-wide">
          <h4 className="about-card-title">{t('aboutPanel.linksTitle')}</h4>
          <div className="about-links">
            <a href={LINKS.docs} target="_blank" rel="noreferrer">{t('aboutPanel.linkDocs')}</a>
            <a href={LINKS.changelog} target="_blank" rel="noreferrer">{t('aboutPanel.linkChangelog')}</a>
            <a href={LINKS.repo} target="_blank" rel="noreferrer">{t('aboutPanel.linkSource')}</a>
          </div>
        </div>
      </div>
    </div>
  );
}
