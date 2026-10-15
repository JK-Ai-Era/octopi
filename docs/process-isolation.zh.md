# 进程隔离与 `untrusted`

> 进程级沙箱（L4 process）与 `untrusted` 效应模式的对外契约。关联：ToolEffectPolicy
> 与不变量 I5 见 [`north-star.zh.md`](./north-star.zh.md)，运行模式见
> [`architecture.zh.md`](./architecture.zh.md)。

Octopi 把 **约束（Containment：能碰什么）** 与 **可撤销（Recoverability：坏了能否回）**
拆成两根正交的轴。本文只描述 **进程执行** 的约束半边，以及缺少进程牢笼时
`untrusted` 如何准入。

---

## 1. 这里的「进程沙箱」指什么

进程牢笼是一份 **能力剖面（capability profile）**，不是某个单一 OS API。
每次执行都会报告 **实际生效** 的隔离能力——**禁止**用类名冒充沙箱。

| 能力位 | 含义 |
|--------|------|
| `processTree` | `supervised` / `killable` / `contained` — 进程树能否作为整体杀掉 |
| `filesystem` | `none` / `cwd-pin` / `write-jailed` / `write-jailed-best-effort` / `root-jailed` |
| `resources` | `none` / `best-effort` / `os-enforced`（时间 / 输出 / 内存） |
| `network` | `open` / `deny` / `allowlist`（**不**计入 L4 门槛） |
| `privilege` | `same` / `dropped` |
| `envHygiene` | `inherit` / `scrubbed` |

**L4 process 最低门槛**（五条须同时满足，才可称「进程牢笼」）：

1. `processTree` 为 `killable` 或 `contained`
2. `filesystem` 为 `write-jailed` / `write-jailed-best-effort` / `root-jailed`
3. `resources` 为 `best-effort` 或 `os-enforced`
4. `envHygiene` 为 `scrubbed`
5. `privilege` 为 `dropped`

Windows 的写限制允许 `write-jailed-best-effort`（Job Object + 受限令牌 + 目录 ACL）
计入门槛；Linux/macOS 在能力具备时提供更严的牢笼。

---

## 2. 后端与探测

运行时探测宿主并选择后端。**没有**静默升级，**没有**假牢笼。

| 宿主条件 | 后端 | 典型剖面 |
|----------|------|----------|
| Linux 且 PATH 上有 `bwrap` | `linux-bwrap` | root-jailed / contained / 网络默认 deny / env scrub |
| Linux 无 `bwrap` | `supervised-spawn` | 可杀树 + cwd-pin + env scrub |
| macOS 且有 `sandbox-exec` | `mac-seatbelt` | 写牢笼（执行时生成 Seatbelt profile） |
| macOS 无 Seatbelt | `supervised-spawn` | 同 Linux 降级 |
| Windows（未附带 Job helper） | `supervised-spawn` | `taskkill /T` 树杀 + env scrub |
| 未知 / 嵌入式 | `supervised-spawn` | 同基线 |

`SandboxResult.isolation` **始终**携带该次命令实际使用的剖面。

内置 `shell` 工具 **始终**经 `ProcessSandbox` 执行（探测到 jail backend 则包牢笼，
否则 supervised spawn），不存在第二条 spawn 路径。

**牢笼根与网络（D4）**：`SandboxConfig.allowRoots`（缺省 cwd）在牢笼内 bind / 可写；
网络姿态 `open | deny | allowlist`，**缺省 `deny`**。`allowlist` 本版仅留接口，
按 `deny` 执行并如实注记。probe 与 execute 保持一致。

**网络缺省（D4）**：`host`/`project` → `open`；`workspace`/`untrusted` → `deny`（reduced 恒 deny）。
`allowlist` 仅接口，按 deny 执行并注记。

**Jail 搭建失败（D7）**：`requireJail`（effective untrusted）抛 `untrusted_jail_failed`，禁止未沙箱执行；其它模式回落 supervised + `jail_setup_failed` + run 级 `securityDegraded`。

**macOS Seatbelt（D3）**：执行时生成覆盖 `allowRoots` 与网络姿态的 profile，
落盘后 `sandbox-exec -f <profile> -- …`。`OCTOPI_SB_PROFILE` 仅作宿主覆盖。
仅在 profile **实际生效**时才报 `write-jailed`。

**环境变量 deny-by-default**：所有后端只透传白名单（`PATH`、`HOME`、`TMP`、
locale、shell/OS 基础项）。宿主密钥（`*_API_KEY`、`*_TOKEN` 等）**不会**
通过 `process.env` 泄进子进程。

---

## 3. `untrusted` 承诺什么

`untrusted` 是 **产品承诺**，不是配置旋钮名：

> 宿主愿意审阅这段代码的产出，但**不信任**其意图与供应链。运行时保证：
> 碰不到承诺外的世界、掏不走宿主密钥、弄坏了可撤销。

三问必须同时成立：

1. **约束** — 不能改动事务 root 外（L2 + shell 策略）
2. **防外传** — 不能外联或滥用宿主凭证（工具面 + env scrub）
3. **可撤销** — 效应可回滚（L3 turn undo + `onClose: discard`）

**不存在「降级版 untrusted」标签。** 无进程牢笼时，系统要么拒绝，要么
**改写有效 mode** 并 **削减能力**。

---

## 4. 准入：`refuse` 与 `degrade`

```jsonc
{
  "effectPolicy": {
    "mode": "untrusted",
    "untrustedAdmission": "refuse"   // 或 "degrade"
  }
}
```

| 准入 | 缺少 L4 process 时 |
|------|-------------------|
| `refuse`（缺省） | 启动/run **失败**（`untrusted_refused`，并列出缺失能力） |
| `degrade` | 仅允许按 **更弱策略** 运行（见下） |

### degrade 语义（降能力，不降墙）

| 字段 | 值 |
|------|-----|
| `requestedMode` | `untrusted`（审计留痕） |
| `mode`（effective） | `workspace` |
| `toolSurface` | `reduced` |
| `securityDegraded` | 如 `["no_process_jail", …]` |
| UI / Observer | 一律展示 **effective** mode，不展示请求名 |

`toolSurface: reduced` 保留 L2 内的内容工具，并按 **能力标签**（`ToolDefinition.capabilities`）
**剥离**（不看显示名）：

- `exec`（shell 及任意执行器；并强制 `shellEscape: deny`）
- `egress`（`http_request` / `web_search` / MCP·client 通道）
- `send` / `dynamic-code`

reduced 面上 **未标注工具一律拒绝**（unknown-reject）；内置工具已全部标注。

旧版按工具名剥离的列表如下（已由能力标签取代）：

- `shell` / 执行类工具（并强制 `shellEscape: deny`）
- `http_request` 与 web/fetch 类
- MCP / client tools / `send_file`

`onClose: discard` 作为 untrusted 意图残留予以保留。

---

## 5. 平台说明

| 平台 | 说明 |
|------|------|
| **Linux** | 最强路径：`bwrap`（user namespace）真 root 牢笼；否则仅 supervised spawn。 |
| **macOS** | 有 Seatbelt（`sandbox-exec`）则提供写牢笼；执行时按 `allowRoots` 生成 profile（可用 `OCTOPI_SB_PROFILE` 覆盖）。 |
| **Windows** | 纯 Node 无 mount namespace；树杀用 `taskkill /T`；写限制为 best-effort（ACL）。原生 Job Object helper 为后续增强。 |
| **嵌入式** | 以探测结果为准。无牢笼时，第三方代码用 `refuse`。 |

---

## 6. 配置参考

```jsonc
{
  "effectPolicy": {
    "mode": "untrusted",              // workspace | project | host | untrusted
    "untrustedAdmission": "refuse",   // refuse | degrade（仅 untrusted）
    "shellEscape": "deny",            // deny | confirm | allow
    "pathContainment": "strict",      // strict | soft | none
    "processLimits": true
  }
}
```

仍然成立的关联语义：

- 专用文件工具遵守 L2 `pathContainment` 与事务 root。
- Turn undo（L3）与是否具备牢笼无关。
- `host` **不是**沙箱：shell 全开、无路径牢笼。

---

## 6a. 引擎缺省 vs 脚手架

| 层 | 省略 `mode` 时 | 目的 |
|----|----------------|------|
| **引擎 / 库** | **`workspace`**（secure-by-default） | 嵌入方漏配也不会全盘放开 |
| **`octopi init` / `octopi.example.json`** | 显式 `"mode": "host"` | 评估 / 本机自动化开箱即全能力 |

`project` 是 **编码模式，不是隔离模式**：文件 L2 严格，但 shell 在进程牢笼就绪前仍可能碰到 root 外路径。

Gateway `/health` 与 channel health 暴露 `effectPolicy`（`configuredMode` / `effectiveMode` / `engineDefaultMode` / `warnings`）。Web UI + `mode: host` 会在启动时打警告。

---

## 6b. 会话级临时 transactionRoots

宿主可为 **当前会话** 追加允许根（UI / REST）。语义：

| 规则 | 行为 |
|------|------|
| 范围 | 仅该 session；随 session 删除（metadata） |
| 可变性 | **追加 / 删除单个路径**；不替换 agent 的 `transactionRoots` |
| 权限 | **不能放宽** `pathContainment` / `shellEscape` / mode |
| 路径 | 必须是 **绝对路径**；规范化并去重 |

```http
GET    /api/v1/sessions/:id/effect-roots
POST   /api/v1/sessions/:id/effect-roots          { "path": "/data/scratch" }
DELETE /api/v1/sessions/:id/effect-roots?path=...
```

运行时 `allowRoots` = `agent.workspace` + `effectPolicy.transactionRoots` + `session.temporaryRoots`。

---

## 7. 我们不宣称什么

- **不是**容器运行时；容器隔离仍是 opt-in 槽位。
- **不以** syscall 过滤（seccomp）作为产品门槛。
- **不以**网络隔离作为 L4 process 门槛（`network: open` 常见）。
- **不把** supervised spawn 说成进程牢笼——它不是。
- **不宣称** `untrusted` 在所有宿主可用——需要 L4，或显式 degrade。

面向第三方 skill / 插件市场，建议 `untrustedAdmission: refuse`。
