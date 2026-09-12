# Orchestration — 编排（experimental）

> Layer: Layer 2  
> 默认不进主路径；经 package 子路径 `octopi/harness/orchestration` 访问。

确定性多步骤作业：工作流、调度、规划、策略路由、输出质量、反思。

## 与 Session.tasks 的耦合约定

**规范（尚未实现适配层）**：长流水线若需用户可见进度，应在启动时经 `SessionTaskService.create` 登记一条任务，结束时 `complete`/`drop`。  
禁止 session-tasks 反向 import 本域；禁止 Workflow 状态机充当 SessionTask 状态机。

当前仓库中**没有**现成的 orchestration → SessionTaskService 适配实现，接入时请自行编写并保持单向。

## 目录

- workflow/ — WorkflowEngine
- scheduler/ — TaskScheduler
- planner/ — Rule / LLM / Hybrid planner
- strategy/ — 任务分类 + 策略路由
- quality/ — OutputQualityGate
- reflector/ — LLMReflector

## 依赖

- Core only（含 cognitive-loop / knowledge-store 契约）
- → SessionTaskService 仅单向可选适配（未内置）
