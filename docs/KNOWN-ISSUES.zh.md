# 已知问题

> **语言说明**：英文版见 [KNOWN-ISSUES.md](./KNOWN-ISSUES.md)。本文为中文对译，变更须双语同步。
> 最后更新：2026-11-19。本文件只列**使用者/集成开发者实际会踩到的确定问题与陷阱**；工作原理归 `docs/`，变更史归 `CHANGELOG`。

## Session / ACL

- **Windows 上没有物理隔离兜底**：写入限制是 best-effort（ACL），且暂无 Job Object / 受限令牌 helper——不要把 `untrusted` / jail 配置当沙箱。
- **工具输出评为 high/critical 直接拦、无确认路径**：输出扫描没有事前确认语义——即使调用本身已获批准，run 仍可能被工具输出打断。
- **暂无分布式 Session Lease**（实现即将落地）：在它发布前，不要让多个网关进程指向同一个 `OCTOPI_HOME`——进程内锁不跨进程。

## Knowledge 外源出站

- **内嵌凭证的源 URL 即能力**：skill 级 `sources[]` 应按不可信输入对待。
- **`credential_bindings` 为空时默认放行**（兼容语义）：需要 fail-closed 请设 `credentials.requireBindings: true`（或以 `effectPolicy.mode=untrusted` 运行）。
- **没有真·IP 钉扎**：network-guard 只在 connect/lookup 时再校验地址；极高威胁模型需自备钉扎（注入 `lookup` / `filterAddresses`）。
- **出站 SSRF 防护只覆盖 `http_request` / Knowledge**：shell 里的 `curl` / `wget` 无出站门，除非 L4 jail 设 `network: deny`。
- **无内建 OAuth 流程与续期**：`oauth2_client` 仅在已换取 access token 后按 bearer 发送——续期自理，token 过期即下次调用 401。

## Knowledge 索引 / 向量

- **Office 超大表可能被跳过**：抽取带可取消超时——超大表格可能以 `parse_timeout` 跳过（有意为之，不无限重试）。
- **file-watch 可能漏事件**：reconcile 扫描（约 60s）兜底补缺口——新文件可能延迟约一分钟才进索引。
- **因密钥跳过的 embed 留墓碑**：`dimensions=0` 的分块不会自动重嵌——`octopi doctor` 会报告（KN009）；修复 embed 凭证/策略后对受影响源跑 reprocess。

## 浏览器工具

- **浏览器没有网络层出口限制**：`browser.network` 在拦截层把关每个请求（含重定向），但浏览器进程本身是开放的网络通道（代理/白名单出口为后续增强）。
- **浏览器 DNS 不在 connect 时复验**：`assertUrlAllowed` 只校验解析期地址——浏览器引擎内没有 DNS rebinding TOCTOU 闭合（与 network-guard 同一注记）。
- **写闸按 method+origin 会话级去重**：`browser.confirm` 三档开关——`"strict"` 所有非 GET 过闸（含页内 fetch/XHR）；`"standard"`（缺省）仅文档级过闸（表单/上传/密码）；`"off"` 全放开。闸开时对 `POST https://x` 批过一次，同会话内该源的后续写入不再询问（关会话即撤销）。
- **attach 会话只管自己的页**：`cdp-attach` 模式下请求策略/确认闸只覆盖会话页面（其弹窗是即关不辖）；用户真实浏览器里的其他标签页不受管辖、不设闸。
- **弹窗按单页契约即开即关**：`target="_blank"` / `window.open` 的新窗口不在会话请求策略覆盖内（CDP 拦截按 page target 挂）；会立即关闭+记账，但弹窗首个请求存在与关闭的竞态窗口（出生即接管为后续增强）。
- **持久 profile 按 OCTOPI_HOME 共享**：`browser.profiles.defaultProfile` 让同一运行时下所有 agent 共享一份登录态；租户/agent 级 profile 归属是开放问题（`arch/browser-capability.md` §5）。会话内对某 `method+origin` 批过一次写闸后，同形状的后续写入（含表单批准后的页内脚本写）不再询问。
- **截图落盘为文件，不是内联图像**：工具结果在 LLM 边界是纯文本——`browser_screenshot` 返回文件路径，模型「看不到」图像。
- **stealth 是缓释不是免疫**：`rebrowser` 补自动化泄漏（Runtime.enable、navigator.webdriver、栈指纹），但其文档明示不覆盖 `HeadlessChrome` UA 标记与指纹面（canvas/WebGL/字体）——该轴由 `camoufox`（异构引擎/指纹）或 `cdp-attach`（真实浏览器）覆盖。CAPTCHA 级评分还计入 IP 信誉；`stealth.humanize` 只对行为/时序轴起作用。
- **camoufox 后端残余边界**：不经 `context.route` 的请求（WebSocket、ServiceWorker fetch）绕过逐跳重定向走查；`camoufox-js` 是实验性移植版（Apify）且 peer 钉 `playwright-core <1.63`——故走隔离 provider 目录（`browser-providers/camoufox`），版本钉与原生依赖不入宿主依赖树。
