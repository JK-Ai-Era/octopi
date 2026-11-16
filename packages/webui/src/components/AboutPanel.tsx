/**
 * 关于（§5d 关于组）：版本 / 帮助与快捷指引 / 文档链接。
 * 顶栏帮助按钮直达本页（批 2-2 留尾的收口）。
 */

export function AboutPanel(): JSX.Element {
  return (
    <div className="panel" style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
      <h3 style={{ margin: 0 }}>关于 Octopi 🐙</h3>
      <div className="small muted">
        版本信息见 <code>package.json</code> / 启动日志；文档与源码见仓库。
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
