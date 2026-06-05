# Octopi 开发指南

## 环境要求

- Node.js >= 20
- TypeScript >= 6.0

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

项目采用三层洋葱架构：

| 层 | 目录 | 职责 | 依赖 |
|---|---|---|---|
| Core | `src/core/` | 纯引擎 + 接口契约 | 无外部依赖 |
| Harness | `src/harness/` | 装具层 | 依赖 Core 接口 |
| Integration | `src/integration/` | 集成层 | 依赖 Core + Harness |

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

**当前测试分布：**

| 测试文件 | 覆盖范围 |
|---|---|
| `core-engine.test.ts` | AgentEngine 核心循环 |
| `harness.test.ts` | AgentBuilder + SessionAwareRunner |
| `security.test.ts` | SecurityGuard + CapabilityEnforcer |
| `task-stage.test.ts` | TaskStage ContextPipeline 集成 |
| `task-system.test.ts` | TaskTracker + TaskManager |
| `task-integration.test.ts` | Task 系统端到端 |
| `agent-loop.test.ts` | 旧 AgentLoop（deprecated） |
| `loop.test.ts` | 旧循环（deprecated） |
| `openclaw-compat.test.ts` | OpenClaw 兼容性 |
| `output-quality.test.ts` | 输出质量检测 |
| `output-quality-effect.test.ts` | 输出质量效果 |
| `skill-manager.test.ts` | Skill 管理器 |
| `legacy-runner.test.ts` | v0.1.x 兼容层 |
| `anthropic-provider.test.ts` | Anthropic Provider |

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
| 新增/修改核心类型 | `ARCHITECTURE.md` 对应章节 |
| 新增 Plugin hook | `ARCHITECTURE.md` + `plugin-system.md` |
| 新增内置工具 | `ARCHITECTURE.md` Tool System 章节 |
| 新增 LLM Provider | `ARCHITECTURE.md` Provider System 章节 |
| 修改 Agent Loop 流程 | `ARCHITECTURE.md` Agent Loop 章节 |
| 测试数量变化 | `README.md` + `CHANGELOG.md` |

### 文档更新检查清单

提交前确认：

- [ ] `ARCHITECTURE.md` 的模块实现状态是否准确
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
