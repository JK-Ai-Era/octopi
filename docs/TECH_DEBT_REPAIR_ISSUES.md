# TECH_DEBT_REPAIR_PLAN 修复清单

本文档是 `TECH_DEBT_REPAIR_PLAN.md` 的可执行问题清单，面向内部研发阶段，不保留向后兼容。

## 1. 工具参数校验补齐
- **问题**：`ToolRegistry.execute()` 当前仅校验 `required`，缺少类型/枚举等校验。
- **范围**：`src/harness/plugin-ecosystem/tools/registry.ts`
- **修复要点**：按 `ToolParameter` 增加类型校验、`enum` 校验；优先覆盖安全风险。
- **验收**：在调用 handler 前捕获非法参数并抛出结构化错误；补单元测试。
- **状态**：✅ 已完成

## 2. ProviderPool 主动探活
- **问题**：slot 连续失败标记不健康后无主动恢复机制。
- **范围**：`src/harness/concurrency/provider-pool.ts`
- **修复要点**：增加定时探测、恢复策略、可配置间隔与超时；输出健康状态事件。
- **验收**：不健康 slot 能自动恢复，恢复正常路由；补充测试。
- **状态**：✅ 已完成

## 3. KnowledgeStage 接入 ContextEngine
- **问题**：`KnowledgeStage` 使用已移除的 Stage 接口，未接入 `ContextEngine`。
- **范围**：`src/harness/task-system/knowledge/*`、`src/harness/index.ts`、`tests/harness/knowledge.test.ts`
- **修复要点**：删除旧 `ContextStage/StageContext` 体系，新增 `KnowledgeContextEngine` 并直接接入 `ContextEngine`。
- **验收**：通过 `ContextEngine.assemble()` 注入知识；相关测试全部通过。
- **状态**：✅ 已完成

## 4. CLI 拆分
- **问题**：`src/cli.ts` 过大、职责过重。
- **范围**：`src/cli/*`、`package.json`、`package-lock.json`
- **修复要点**：拆分为 `src/cli/index.ts`、`args.ts`、`daemon.ts`、`helpers.ts`、`commands.ts`、`webui.ts`，并将 CLI 入口改为 `dist/cli/index.js`。
- **验收**：命令行功能保持一致；相关测试通过。
- **状态**：✅ 已完成

## 5. Web Runtime Store 清理 legacy 双模型
- **问题**：store 同时维护 `messages` 与 `conversation`，存在 legacy 状态。
- **范围**：`src/integration/web/runtime/store.ts`、`tests/web-runtime.test.ts`
- **修复要点**：删除遗留的 `messages` 双写状态，统一以 `conversation` 为唯一 source of truth。
- **验收**：store 状态单一来源；相关测试通过。
- **状态**：✅ 已完成

## 6. deprecated/re-export 清理
- **问题**：仓库存在明确 `@deprecated` 模块与 re-export。
- **范围**：`src/harness/memory/extraction/*`、`src/harness/concurrency/*`、`src/core/types.ts`、`src/harness/index.ts`
- **修复要点**：删除 deprecated re-export 封装文件；更新测试与导入路径，直接使用规范定义模块；清除残余 `@deprecated` 标记。
- **验收**：源码内不再存在 `@deprecated` 标记；测试通过。
- **状态**：✅ 已完成

## 7. 测试覆盖体系
- **问题**：缺少覆盖率配置和统一阈值。
- **范围**：`vitest.config.ts`、`package.json`、`.gitignore`
- **修复要点**：配置 `@vitest/coverage-v8`，新增 `npm run test:coverage`，忽略 coverage 目录。
- **验收**：`npm run test:coverage` 可产出覆盖率报告；测试通过。
- **状态**：✅ 已完成

## 8. Lint 配置补齐
- **问题**：存在 `eslint src/` 脚本但缺少配置文件，风格规则不可执行。
- **范围**：`eslint.config.js`、`package.json`
- **修复要点**：补齐 ESLint flat config，新增 devDependencies（eslint、typescript-eslint），调整 `npm run lint`。
- **验收**：`npm run lint` 稳定通过。
- **状态**：✅ 已完成

---

当前进展：1~8 全部修复并验证。
