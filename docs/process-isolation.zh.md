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

**牢笼根与网络（D4）**：`SandboxConfig.allowRoots`（缺省 cwd）在牢笼内 bind / 可写
（`--bind-try`）。网络姿态 `open | deny | allowlist`，**模式缺省**：
`host`/`project` → `open`；`workspace`/`untrusted` → `deny`（reduced 恒 `deny`）。
`allowlist` 仅接口，按 `deny` 执行并如实注记。

**macOS Seatbelt（D3）**：执行时生成覆盖 `allowRoots` 与网络姿态的 profile，
落盘后 `sandbox-exec -f <profile> -- …`。`OCTOPI_SB_PROFILE` 仅作宿主覆盖。
仅在 profile **实际生效**时才报 `write-jailed`。profile 同时放行 POSIX 标准 I/O
设备写（`/dev/null`、`/dev/zero`、`/dev/tty`、`/dev/std*`、`/dev/fd`）——git 以
O_RDWR 打开 `/dev/null`、shell 会重定向到它们，封死会瘫痪基础工具。jail 根同时
按词法与规范（`realpath`）两种形态输出，保证子路径规则能穿透符号链接别名
（macOS `/var` → `/private/var`、`/tmp` → `/private/tmp`）。

**exec 被拒会归因**：`execve` 的 `Operation not permitted` 有两个成因，调用方在牢笼内
无法分辨——Seatbelt 拒绝 exec 任何 **setuid** 二进制（OS 不变量：macOS 的 `ps`、`top`
是 setuid，因此进程列表在笼内必然失败，改 profile 也放不开）；生成的 profile 显式
拒绝**非** setuid 的特权助手（`chroot`、`dscl`）。Octopi 把首个可归因的拒绝写到两条
如实通道：`isolation.notes` 里一行事实、`diagnostics.hints` 里一条可执行建议
（`shell` 工具以 `hints` 字段透出）。写盘与网络拒绝措辞相同，**故意不归因**——
归到 `exec` 上会把调用方带错路。supervised 回落路径同样归因（此时是外层牢笼在拒绝、
并非本项目 profile 生效，因此不声明 deny 清单归因）。

**setuid 拒绝的绕法**：拒绝是永久的，正确做法是避开特权二进制而不是重试。Octopi 自身
原先经 `ps` 读进程状态的位置，现改用非 setuid 来源：CLI 在 macOS 上用
`lsof -a -d txt -Fn`（取首个 `txt` 条目）读取进程的可执行映像，使 `getProcessName` /
`identifyPortOccupant` 在牢笼内照常工作，而非静默降级为 `null`。其它可用的非 setuid
读取途径：`pgrep -fl`、`lsof`、`vm_stat`，以及 `libproc` 的
`proc_pidinfo` / `proc_pidpath`。

**Jail 搭建失败（D7）**：`requireJail`（effective untrusted、`jail: "require"` 或 `onJailUnavailable: "refuse"`）抛 `jail_required_unavailable`，禁止未沙箱执行；其它模式回落 supervised + `jail_setup_failed` + run 级 `securityDegraded`（归一码 `no_process_jail: …`，probe 期缺笼与运行时失笼可按同一前缀消费）。
后端选择与探测对齐（bwrap 冒烟测试 / Seatbelt `sandbox_apply` 冒烟测试）：
jail 完全无法生效时，mode 分叉发生在命令**运行之前**。wrapper 一旦运行过，
疑似建笼失败也**绝不重新执行用户命令**（杜绝双重副作用；伪造 wrapper 报错
换不来一次未沙箱执行）：`requireJail` 拒绝，其它模式如实上报 wrapper 结果
并降级隔离声明（`cwd-pin`）+ run 级 `securityDegraded` 注记。识别只认行首
wrapper 签名（`bwrap:` / `sandbox-exec:` / `newuidmap:` / `newgidmap:`），
绝不匹配裸 `operation not permitted`。

**特权（`dropped`）** 指牢笼**拒绝提权操作**（user namespace 和/或 Seatbelt
`process-exec` 拒绝 `sudo`/`su`/…）。它**不要求**切换 uid。注记区分 `userns`
与 `ops-denied; uid unchanged` 两种形态。

Seatbelt 的 deny 清单是**跨平台超集**，不是对运行主机的实测快照：每个提权助手都列出
它在各发行版下的全部拼写（`/bin/su` 与 `/usr/bin/su`；`chroot` 的 `sbin` 与 `bin`），
并覆盖现代提权面（`pkexec`、`doas`、`run0`、`sudoedit`）。SBPL 的 `literal` 是精确
匹配，漏一个拼写就是一扇门；而死条目零成本（不报错、无运行开销）。**禁止按单机现状
裁剪本表。** 该表刻意静态、不在启动时探测：profile 随主机变化会让同一份配置在不同
机器上行为不同，这种调试成本高于无害条目的噪音。

**Jail 可写挂载（2）**：`allowRoots` ∪ cwd ∪ `os.tmpdir()` 在所有模式下可写；
POSIX 下共享临时目录 `/tmp` 与 `/var/tmp`（各含词法与 `realpath` 规范两种形态）
同样可写——硬编码 `/tmp`、无视 `TMPDIR` 的工具在牢笼内必须能继续工作。
`$HOME` 仅 `project` / `host` 可写（`SandboxConfig.homeWrite`）。
**tmp 写入不进日记**（`notReversed`）；共享临时区对所有用户可写，
留在那里的一切应视为已暴露。系统树保持只读。

**untrusted egress** 恒为 `deny` —— `effectPolicy.network` 无法打开它
（产品承诺，与 `pathContainment` 同级）。

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
- `egress`（`http_request` / `web_search` / MCP·client 通道 / `package_install`）
- `send` / `dynamic-code`
- `runner`（`project_run`——执行 workspace 定义的脚本）

**不剥离**：`vcs`（本地 git porcelain：`git_status`/`git_diff`/`git_log`/
`git_show`/`git_commit`/`git_branch`/`git_restore`）。这些工具以固定 argv
allowlist 调用 `git`——不是 shell——因此 workspace / untrusted 下的 agent
仍可审查与提交，而不必开 `shell`。隔离手段：不存在的 `core.hooksPath`、
commit 带 `--no-verify`、命令行 `-c` 覆盖 `diff.external` / `gpg.program` /
`core.sshCommand` 等（命令行优先于仓库 `.git/config`），以及
`GIT_CONFIG_NOSYSTEM` + `GIT_CONFIG_GLOBAL/SYSTEM` 指向 `NUL`/`/dev/null`。
会把配置里发现的 `filter.*` 驱动钉成 `cat` 后再 `git add`/`commit`，恶意 `.gitattributes` 无法执行 clean/smudge/process。`shellEscape` 只闸 shell 工具，不拦 `vcs`/`runner` 效应类型。

reduced 面上 **未标注工具一律拒绝**（unknown-reject）；内置工具已全部标注。

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
    "jail": "auto",                   // auto | require | none（none 需 privilegedAck）
    "onJailUnavailable": "degrade",   // refuse | degrade（jail != none）
    "privilegedAck": "…",             // 显式无笼表态（jail=none 必填）
    "shellEscape": "deny",            // deny | confirm | allow
    "pathContainment": "strict",      // strict | soft | none
    "processLimits": true
  }
}
```

**Jail 意图（授权 ≠ 降级）**：`jail` 区分「主动选择无笼」与「被动失去牢笼」——
`auto` 有笼后端就上笼，无后端时按 `onJailUnavailable` 记 run 级 `no_process_jail`（绝不静默）；
`require` / `onJailUnavailable: "refuse"` 拿不到就拒绝运行（`jail_required_unavailable`）；
`none` 是**授权**无笼——必须配 `privilegedAck`，注记 `jail=disabled_by_config (privileged)`
且 `securityDegraded` 为空，`untrusted` 下禁止。矛盾组合在配置加载期直接拒绝：
`jail: none` 缺 `privilegedAck`、`jail: none` + `untrusted`、`jail: none` +
`onJailUnavailable: refuse`（死旋钮）、`network: deny|allowlist` + `jail: none`
（网络限制只由牢笼实施——无法兑现的承诺直接拒绝，解析出的网络姿势收敛为 `open`）、
（`jail: require` 或 `onJailUnavailable: refuse`）+ `untrustedAdmission: degrade`
（同条件反结局）。每个 run 记录 `ops.jail.state`（意图 × 实测后端 × `authorized`），
事后可分辨「授权无笼」与「故障无笼」。

已知边界：宿主侧**读**表面（WebUI git status 快照）只要探测到牢笼后端就保持上笼，
不受 `jail` 意图影响——比 run 更严，属有意设计。

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

> **配置级路径**（`agents[].workspace`、`agents[].home`、
> `agents[].skillDirectory`、`effectPolicy.transactionRoots`）语义略有
> 不同：必须是**绝对路径或 `~` 形态**（`~/…`、`~\…`、纯 `~`；不支持 `~user/…`）。
> `~` 在配置/策略/工具 cwd/builder 边界展开为用户主目录（trim → expand，幂等）。
> 相对路径加载即拒——`home` 决定 `persona/`、`skills/` 与 `agent.db` 的落点，
> 按进程 cwd 解析会让 agent 的记忆库随启动目录漂移。上方的会话
> 临时 root 仍然只收绝对路径。

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
