# Agent Harness

一个可嵌入其他应用的 Agent 底座框架。

## 设计原则

1. **薄协议** — 定义清晰的接口面，不绑死实现
2. **厚工具** — 工具运行时动态注册，声明式定义
3. **可插拔记忆** — 短期/中期/长期分层，按需组合
4. **诚实错误处理** — 静默失败是最大敌人

## 架构

```
Application Layer (你的应用)
        │
   Protocol Layer (JSON-RPC / HTTP)
        │
   ┌────▼─────────────────────────┐
   │    Agent Harness Core        │
   │  ┌────────┐  ┌────────────┐  │
   │  │Prompt  │  │ Context    │  │
   │  │Manager │  │ Manager    │  │
   │  └────┬───┘  └─────┬──────┘  │
   │       └──────┬─────┘         │
   │        LLM Router            │
   │  ┌────────┐  ┌────────────┐  │
   │  │Tool    │  │ Memory     │  │
   │  │Registry│  │ System     │  │
   │  └────────┘  └────────────┘  │
   └───────────────────────────────┘
```

## 项目结构

```
agent-harness/
├── src/
│   ├── core/           # 核心抽象：Agent, Session, Turn
│   ├── protocol/       # 通信协议层
│   ├── memory/         # 记忆系统
│   ├── tools/          # 工具注册与执行
│   ├── orchestration/  # 编排：单循环/多Agent/状态机
│   └── providers/      # LLM Provider 适配
├── config/             # 配置
├── docs/               # 设计文档
└── tests/              # 测试
```

## 状态

🚧 架构搭建中...
