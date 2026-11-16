/**
 * 关于（§5d 关于组）：版本 / 帮助与快捷指引 / 文档链接。
 * 顶栏帮助按钮直达本页（批 2-2 留尾的收口）。
 *
 * 版本号运行时下发（`__OCTOPI_WEB__.version`，源自 package.json——批 3-2），
 * 不硬编码在 bundle 里（版本随发布走，UI 不重编）。
 */

import { getProductVersion } from '../runtime-config';

/** 文档与源码链接（产品页文案；仓库搬家时随 package.json homepage 同步改） */
const LINKS = {
  repo: 'https://github.com/JK-Ai-Era/octopi',
  docs: 'https://github.com/JK-Ai-Era/octopi/tree/main/docs',
  changelog: 'https://github.com/JK-Ai-Era/octopi/blob/main/CHANGELOG.md',
} as const;

export function AboutPanel(): JSX.Element {
  const version = getProductVersion();
  return (
    <div className="panel" style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
      <h3 style={{ margin: 0 }}>关于 Octopi 🐙</h3>
      <div className="small">
        版本：<code>{version ? `v${version}` : '未知（服务端未下发）'}</code>
        {' · '}
        <a href={LINKS.docs} target="_blank" rel="noreferrer">
          文档
        </a>
        {' · '}
        <a href={LINKS.changelog} target="_blank" rel="noreferrer">
          更新日志
        </a>
        {' · '}
        <a href={LINKS.repo} target="_blank" rel="noreferrer">
          源码
        </a>
      </div>
      <div>
        <h4 style={{ margin: '8px 0 4px' }}>帮助与快捷指引</h4>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>顶栏「面板」：显示/隐藏右栏（概览 + 详情）；手柄拖宽，双击复位</li>
          <li>右栏概览按「工作进度 / 会话物料 / 环境」分组，点行进详情；专家模式显示「运行时透明」组</li>
          <li>输入框：Enter 发送，Shift+Enter 换行；「附件」按钮 / 拖拽 / 粘贴上传文件</li>
          <li>对话中输入 /stop 可停止当前运行；「停止」按钮同效</li>
          <li>设置 → 服务「连接」：远程部署手填 Gateway URL 与 API Key，可测试连接</li>
        </ul>
      </div>
    </div>
  );
}
