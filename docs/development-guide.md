# Octopi 开发指南

## 架构文档同步规范

**核心原则：代码变更必须同步更新架构文档。**

### 何时更新文档

| 变更类型 | 需要更新的文档 |
|----------|---------------|
| 新增/修改核心类型 (`core/types.ts`) | `architecture.md` 对应章节 |
| 新增/修改模块接口 | `architecture.md` 对应模块章节 |
| 新增 Plugin hook | `architecture.md` Hook 目录 + `plugin-system.md` |
| 新增内置工具 | `architecture.md` Tool System 章节 |
| 新增 LLM Provider | `architecture.md` Provider System 章节 |
| 新增 Skill 相关 API | `architecture.md` Skill System 章节 |
| 修改 Agent Loop 流程 | `architecture.md` Agent Loop 章节 |
| 修改配置结构 | `architecture.md` 配置系统 + `config.ts` 注释 |
| 修改测试覆盖 | `architecture.md` 测试覆盖章节 |

### 文档更新检查清单

提交 PR 前确认：

- [ ] `architecture.md` 的模块实现状态表是否准确
- [ ] `architecture.md` 的源码结构是否反映实际文件
- [ ] 新增的接口/类型是否有文档说明
- [ ] 新增的 hook 是否在 Hook 目录中列出
- [ ] 测试数量是否更新

### 架构文档版本号

`architecture.md` 使用语义化版本号：

- **Major (v3 → v4)**: 整体架构调整、核心概念变更
- **Minor (v3.0 → v3.1)**: 新增模块、重要接口变更
- **Patch (v3.0.1 → v3.0.2)**: 勘误、细节补充、状态更新

每次更新时修改文档顶部的版本号和日期。

---

## 测试规范

```bash
# 运行所有测试
npx vitest run

# 运行单个测试文件
npx vitest run tests/agent-loop.test.ts

# 监听模式
npx vitest watch
```

新增功能必须附带测试。测试文件放在 `tests/` 目录，命名格式：`<module>.test.ts`。

---

## 代码规范

- TypeScript strict mode
- ESM（`"type": "module"`）
- 导入使用 `.js` 后缀（TypeScript ESM 要求）
- 注释使用 JSDoc 格式
