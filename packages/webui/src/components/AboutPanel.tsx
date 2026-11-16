/**
 * 关于（§5d 关于组）：版本 / 帮助与快捷指引 / 文档链接。
 *
 * 版本号运行时下发（`__OCTOPI_WEB__.version`，源自 package.json——批 3-2），
 * 不硬编码在 bundle 里（版本随发布走，UI 不重编）。
 * 快捷指引单源在此（原右栏 help 组与顶栏帮助按钮入口已收编——UI 打磨批）。
 */

import { getProductVersion } from '../runtime-config';

/** 文档与源码链接（产品页文案；仓库搬家时随 package.json homepage 同步改） */
const LINKS = {
  repo: 'https://github.com/JK-Ai-Era/octopi',
  docs: 'https://github.com/JK-Ai-Era/octopi/tree/main/docs',
  changelog: 'https://github.com/JK-Ai-Era/octopi/blob/main/CHANGELOG.md',
} as const;

const SHORTCUTS: Array<[string, string]> = [
  ['Enter', '发送消息'],
  ['Shift+Enter', '换行'],
  ['/stop', '停止当前运行（「中止」按钮同效）'],
  ['/', '打开命令补全'],
  ['Esc', '关闭详情浮层'],
  ['拖拽 / 粘贴', '上传附件（「附件」按钮同效）'],
];

export function AboutPanel(): JSX.Element {
  const version = getProductVersion();
  return (
    <div className="about-page">
      <div className="about-hero panel">
        <div className="about-hero-mark" aria-hidden>🐙</div>
        <div>
          <h3 className="about-hero-title">Octopi Web</h3>
          <div className="small muted">Embeddable agent engine · 你的 AI 工作台</div>
          <div className="small" style={{ marginTop: 6 }}>
            版本 <code>{version ? `v${version}` : '未知（服务端未下发）'}</code>
          </div>
        </div>
      </div>

      <div className="about-grid">
        <div className="panel about-card">
          <h4 className="about-card-title">快捷键</h4>
          <table className="about-shortcuts">
            <tbody>
              {SHORTCUTS.map(([key, desc]) => (
                <tr key={key}>
                  <td><kbd>{key}</kbd></td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel about-card">
          <h4 className="about-card-title">布局导览</h4>
          <ul className="small about-list">
            <li><b>左栏</b>：连接状态、选 Agent、开/开会话</li>
            <li><b>中栏</b>：主对话；输入框下方切模型、看上下文、手动压缩</li>
            <li><b>右栏</b>：工作进度 / 会话物料 / 环境，点行进详情浮层；专家模式加「运行时透明」组</li>
            <li>右栏与输入区都可<b>拖拽手柄</b>调整大小，<b>双击复位</b></li>
            <li>顶栏「面板」：显示/隐藏右栏</li>
            <li>设置 → 服务：远程部署手填 Gateway URL 与 API Key，可测试连接</li>
          </ul>
        </div>

        <div className="panel about-card about-card-wide">
          <h4 className="about-card-title">口径（速查）</h4>
          <ul className="small about-list">
            <li>会话级模型覆盖只影响该会话，不改 Agent 默认；新建会话时作为预选</li>
            <li>上下文显示「上次实测 / 模型窗口」；窗口仅认配置，未配置显示「未知」</li>
            <li>附件默认仅本会话；卡片「…」可归入项目或删除；右栏「文件」= send_file 发送的文本，图片/音视频在对话中展示</li>
            <li>右栏「Git」按 <code>web.gitStatusPollSeconds</code> 轮询（默认 5s，0=不自动轮询），切换目录即刷新</li>
            <li>右栏「上下文」八层口径：System 契约层 L1–L7（含 Runtime）+ Information L8（消息窗口，不进 System 装配栈）</li>
          </ul>
        </div>

        <div className="panel about-card about-card-wide">
          <h4 className="about-card-title">链接</h4>
          <div className="about-links">
            <a href={LINKS.docs} target="_blank" rel="noreferrer">📖 文档</a>
            <a href={LINKS.changelog} target="_blank" rel="noreferrer">📜 更新日志</a>
            <a href={LINKS.repo} target="_blank" rel="noreferrer">🐙 源码</a>
          </div>
        </div>
      </div>
    </div>
  );
}
