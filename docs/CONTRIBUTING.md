# Octopi 贡献指南

> 本文档面向 Octopi 项目的开发者和贡献者。
> 如果你是集成开发者（选用 Octopi 作为 Agent 底座），请参考 [ARCHITECTURE.md](./ARCHITECTURE.md) 中的公共 API 示例。

# Octopi 贡献指南

## 环境要求

- Node.js >= 20
- TypeScript >= 5.0

## 开发命令

```bash
# 构建
npm run build          # tsc 编译

# 测试
npm test               # 运行所有测试（node --experimental-vm-modules）
npx vitest run         # 等效命令
npx vitest watch       # 监听模式

# 开发
npm run dev            # tsc --watch
```

## 架构分层

项目采用四层洋葱架构 + DDD 领域组织：

| 层 | 目录 | 职责 | 依赖 |
|---|---|---|---|
| Loop | `src/loop/` | 纯执行循环 | 仅依赖 Core 类型 |
| Core | `src/core/` | 机制原语 + 接口契约 + 核心类型 | 无外部依赖 |
| Harness | `src/harness/` | 11 个自包含领域 | 依赖 Core + Loop |
| Integration | `src/integration/` | 外部系统适配 | 依赖 Core + Loop + Harness |

详细架构见 [arch/overview.md](../arch/overview.md)

**依赖方向：外 → 内。修改内层时必须确认不影响外层。**

## 测试规范

```bash
# 运行全部测试
npm test

# 运行单个测试文件
npx vitest run tests/core-engine.test.ts

# 运行匹配的测试
npx vitest run --grep "SecurityGuard"
```

**测试文件命名：** `tests/<module>.test.ts`

**当前测试分布：** 64 个测试文件，1022 个测试用例

| 测试领域 | 覆盖范围 |
|---|---|
| Core 循环 | AgentLoop 纯函数、Agent 类、callModel、错误分类 |
| Harness 组装 | AgentBuilder、SessionAwareRunner、可靠性包装 |
| 安全 | SecurityGuard、RiskEvaluator、DefaultRiskPolicy、ShellParser |
| 上下文管理 | ContextEngine、SmartRouter、MessageSelector、Compressor |
| 任务系统 | TaskTracker、TaskManager、TaskDecisionProvider |
| Plugin 系统 | PluginManager、HookRegistry、CapabilityRegistry |
| Skill 管理 | SkillManager 两阶段加载 |
| 工具系统 | ToolRegistry、工具版本管理 |
| 分布式智能体 | AgentRuntime、TriggerEngine、OutputPolicy |
| 多智能体 | AgentSwarm、OrchestrationStrategy |
| 并发控制 | ProviderPool、SessionGate、RateLimiter |
| 输出质量 | OutputQualityGate |
| 可观测性 | TraceCollector、MetricsAggregator、ObserverBridge |
| 集成 | OpenAI/Anthropic Provider、MCP Client |
| 录制回放 | RecordingProvider、ReplayProvider、ChaosProvider |

## 代码规范

- TypeScript strict mode
- ESM（`"type": "module"`）
- 导入使用 `.js` 后缀（TypeScript ESM 要求）
- 注释使用 JSDoc 格式
- 文件头部必须有模块说明注释

## 文档同步规范

**核心原则：代码变更必须同步更新文档。**

| 变更类型 | 需要更新的文档 |
|----------|---------------|
| 新增/修改核心接口 | `arch/overview.md` + `arch/dependency-map.md` |
| 新增 Plugin hook | `docs/plugin-system.md` + `arch/overview.md` |
| 新增模块 | `arch/overview.md` 对应领域章节 + `arch/dependency-map.md` |
| 修改层间依赖 | `arch/dependency-map.md` + `arch/layer-rules.md` |
| 修改架构不变量 | `arch/invariants.md` |
| 测试数量变化 | `README.md` + `CHANGELOG.md` |

### 文档更新检查清单

提交前确认：

- [ ] 运行 `bash ~/.openclaw/workspace-octopi/arch/check-sync.sh`
- [ ] `arch/overview.md` 中对应领域章节是否更新
- [ ] `arch/dependency-map.md` 中依赖关系是否更新
- [ ] 新增的接口/类型是否有文档说明
- [ ] 测试数量是否更新
- [ ] `CHANGELOG.md` 是否记录变更

### 架构文档版本号

`ARCHITECTURE.md` 使用语义化版本号：

- **Major (v2 → v3)**: 整体架构调整、核心概念变更
- **Minor (v2.0 → v2.1)**: 新增模块、重要接口变更
- **Patch (v2.0.1 → v2.0.2)**: 勘误、细节补充

## 新增模块检查清单

新增一个模块时：

1. 确定它属于哪一层（Core / Harness / Integration）
2. 在对应层的 `index.ts` 中导出
3. 在 `src/index.ts` 中添加导出（如果是公共 API）
4. 编写测试文件 `tests/<module>.test.ts`
5. 更新 `ARCHITECTURE.md` 对应章节
6. 更新 `CHANGELOG.md`

## Plugin 开发

Plugin 目录结构：
```
my-plugin/
├── octopi.plugin.json   ← manifest
└── index.ts             ← 入口（definePluginEntry）
```

详见 [Plugin 系统文档](plugin-system.md)。

## 文档同步铁律

### 1. 架构文档同步

修改涉及架构调整时（接口变更、新增模块、依赖方向变化），同步更新 `arch/` 相关文档。
完成后运行 `bash arch/check-sync.sh` 验证。

### 2. 模块 README 同步

修改任何模块时，同步更新该模块目录下的 `README.md`：

- **职责变化** — 更新"职责"和"不做什么"部分
- **新增/删除文件** — 更新"文件说明"部分
- **依赖变化** — 更新"依赖"部分
- **新增模块** — 创建对应的 `README.md`

检查清单：
- [ ] 我已更新被修改模块的 `README.md`
- [ ] 我已运行 `bash arch/check-sync.sh`
