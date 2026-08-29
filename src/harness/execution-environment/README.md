# Execution Environment — 执行环境

> Layer: Layer 2

沙箱管理、工作区生命周期、文件操作、资源限制。

**核心理念**：Agent 执行代码需要隔离环境，防止对宿主系统造成不可逆影响。

## 职责

- ProcessSandbox — 进程级沙箱（spawn + 资源限制）
- FileWorkspace — 工作区管理（git 集成、search、glob、diff、snapshot）

## 不做什么

- 不做安全评估（那是 security 的事，但会接收安全策略的结果来决定隔离级别）
- 不做工具注册

## 依赖

- Core: interfaces/execution-environment

## 文件说明

- sandbox.ts — ProcessSandbox
- workspace.ts — FileWorkspace
- index.ts — 统一导出
