[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **住在你电脑里的个人 AI 助手。**<br>
> Rin 会记住重要的事，帮你处理真实任务，并在使用中变得更懂你。

Rin 是一个本地运行的通用 AI 助手，内置记忆、工具、定时任务、界面入口和聊天桥接。它可以协助文档、网页调研、文件、提醒、代码、连接服务和重复流程，并让终端、桌面应用、自动化与聊天入口共享同一个助手状态。

| 重点             | Rin 提供什么                                               |
| ---------------- | ---------------------------------------------------------- |
| 全局记忆         | 有用的事实、偏好和经验可以跨越单次聊天保留下来。           |
| 从重复使用中学习 | 纠正和成功流程可以沉淀为简短指令与技能。                   |
| 本地后台运行时   | 多个入口连接到同一个助手，而不是彼此孤立的聊天窗口。       |
| 开箱即用的产品   | 记忆、定时、工具、聊天桥接和 UI 路径已经内置。             |
| 自举式开发       | Rin 被用于开发 Rin，这个仓库本身就是助手能力的真实测试场。 |

> [!WARNING]
> Rin 仍然很年轻。请把日常使用视为实验性体验：你可能遇到粗糙边缘、文档缺失、不稳定行为、token/API 成本，或偶发的破坏性变更。

## 支持 Rin

如果 Rin 为你节省了时间，可以通过 [Ko-fi](https://ko-fi.com/THE_cattail) 自愿支持维护。赞助用于支持持续维护成本，不购买功能优先级，也不构成私人支持承诺。

## 安装

> [!TIP]
> 大多数用户应从下面的 stable 安装命令开始。直接使用这些安装命令即可；安装器会装好 `rin` 命令。预发布和 git 通道放在折叠区域中。

Rin 在所有平台上都需要 Node.js 22.19.0 或更新版本，以及 npm。

### Linux 和 macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh
```

<details>
<summary>其他发布通道</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

从 PowerShell 或 Windows Terminal 安装。

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1)))
```

<details>
<summary>其他发布通道</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

安装后，所有平台都使用同一个命令：

```bash
rin
```

Windows 安装器会写入 `rin` 命令启动器，并在可行时把 Rin 的用户启动器目录加入用户 `PATH`。如果当前终端没有立刻识别 `rin`，请重新打开一个终端。

## 安全与成本

Rin 可以保留上下文、写入记忆、运行定时任务、搜索网页，并反复调用模型。这可能比一次性聊天消耗更多模型 token、API 配额或订阅容量。

重要操作请保持监督。除非你理解风险，并且能够检查或回滚结果，否则不要让 Rin 执行不可逆或敏感操作。

## 技术方向

Rin 构建在 Pi 之上，并保留 Pi 以 KISS 为先的精神：

- 保持核心小而易懂
- 把真实工具和上下文展示给模型
- 当这是最简单可靠的设计时，让模型自己判断
- 避免依赖模型专属技巧和过度调校的提示词
- 优先选择透明的本地状态，而不是远程平台锁定

Rin 不想成为沉重的 agent 框架。它想成为一个实用的日常助手：能记忆、能行动、能改进，同时仍然可检查。

## 文档

这份 README 是面向公开用户的概览。翻译位于 `readme/README.*.md`，应与英文版本保持一致。

如果你要修改 Rin 本身，请从 [`docs/developer/README.md`](../docs/developer/README.md) 开始。面向 agent 的运行时指南和已安装文档与这份公开 README 分开维护。
