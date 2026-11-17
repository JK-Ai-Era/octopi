# 已知问题

> **语言说明**：英文版见 [KNOWN-ISSUES.md](./KNOWN-ISSUES.md)。本文为中文对译，变更须双语同步。
> 最后更新：2026-11-18。本文件只列**使用者/集成开发者实际会踩到的确定问题与陷阱**；工作原理归 `docs/`，变更史归 `CHANGELOG`。

## Session / ACL

- **Windows 上没有物理隔离兜底**：写入限制是 best-effort（ACL），且暂无 Job Object / 受限令牌 helper——不要把 `untrusted` / jail 配置当沙箱。
- **工具输出评为 high/critical 直接拦、无确认路径**：输出扫描没有事前确认语义——即使调用本身已获批准，run 仍可能被工具输出打断。
- **无分布式 Session Lease**：不要让多个网关进程指向同一个 `OCTOPI_HOME`——进程内锁不跨进程。

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
