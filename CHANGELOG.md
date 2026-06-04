# Changelog

## v0.1.1 (2026-06-04)

### 重构

- **TaskTracker 异步化** — 所有 CRUD 方法改为 async，文件操作用 stat/readFile/appendFile 替代同步版本
- **applyDecision 去重** — 新建 `src/tasks/shared.ts` 提取共享函数
- **AgentLoop 命名区分** — 重命名为 AgentRunner，保留向后兼容别名
- **plugin.ts 迁移到迭代级 hook** — 从 OpenClaw per-message hook 改为 Octopi 迭代级 hook
- **advisor.ts deprecated 标记** — 标注迁移路径

### 测试

- 新增 JSON 解析边界 case 测试
- 新增并发 session 隔离压力测试
- 测试总数：145 → 150

### 文档

- 新增 `src/tasks/README.md` — Task 系统架构文档
- 新增 `docs/agent-loop-architecture.md` — Agent Loop 对比分析
- 新增 `docs/architecture-refactor-analysis.md` — 架构重构分析
- 更新架构文档 v3，同步实际代码状态

## v0.1.0 (2026-06-02)

### 核心功能

- Agent Loop（消息 → 上下文组装 → 模型推理 → 工具执行 → 回复）
- Session 管理（生命周期、持久化、并发控制）
- 多 Provider 支持（OpenAI / Anthropic）
- Plugin 系统（对齐 OpenClaw 架构）
- Skill 系统（Tool 之上的结构化经验层）
- Task 系统（任务追踪与管理）
- 内置工具（shell、file_read、file_write、file_list）
