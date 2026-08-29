# Task System — 任务与编排

> Layer: Layer 2

任务管理、规划、调度、工作流、策略路由、输出质量、反思、知识、监督。

**核心理念**：Task 系统让 Agent 从"单次对话"升级为"持续任务执行"。

## 职责

- TaskManager — LLM 驱动的任务管理
- TaskTracker — 任务状态追踪
- RulePlanner / LLMPlanner / HybridPlanner — 规划器
- TaskScheduler — 任务调度（once/interval/cron/at）
- WorkflowEngine — DAG 编排引擎
- StrategyRouter — 策略路由
- OutputQualityGate — 输出质量检测
- LLMReflector — 反思器
- KnowledgeStore — 知识存储
- DefaultTaskSupervisor — 智能监督

## 不做什么

- 不做安全检查
- 不做上下文压缩

## 依赖

- Core: interfaces/、types/、primitives/
- Harness: reliability

## 文件说明

- tasks/ — 任务管理
- planner/ — 规划器
- scheduler/ — 调度器
- workflow/ — 工作流引擎
- strategy/ — 策略路由
- quality/ — 输出质量
- reflector/ — 反思器
- knowledge/ — 知识存储
- supervisor/ — 智能监督
- tool-loop-detection-core.ts — 工具循环检测
- index.ts — 统一导出
