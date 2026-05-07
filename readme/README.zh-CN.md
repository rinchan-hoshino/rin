[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [更多语言](README.md)

# Rin

> **住在你电脑里的个人 AI 助手。**<br>
> Rin 会记住重要信息，帮你处理真实任务，并在使用中变得更懂你。

Rin 是一个本地运行的通用 AI 助手，内置记忆、工具、定时任务、界面入口和聊天桥接。Rin 也由 Rin 自己参与构建：这个项目使用自己的助手来规划、编辑、审阅、翻译和维护仓库。

> [!WARNING]
> Rin 还很年轻。日常使用请先按实验性软件看待：你可能会遇到粗糙边缘、文档缺口、不稳定行为、token/API 成本或偶发破坏性变更。

## 安装

> [!TIP]
> 大多数用户应从下面的稳定版安装命令开始。预发布和 git 通道放在折叠区里。

### Linux 和 macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

<details>
<summary>其他发布通道</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

从 PowerShell 或 Windows Terminal 安装。请先确保 Node.js 和 npm 可用。

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

<details>
<summary>其他发布通道</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

在 Windows 上，交互式安装器默认打开 GUI 安装器。安装完成后，`rin` 默认打开桌面 GUI；Rin 也会写入 GUI 启动器，以及当前用户范围的后台运行时开机启动入口。

## 基础用法

```bash
rin            # 打开 Rin
rin -p "..."   # 运行一次性助手回合
rin doctor     # 检查健康状态和配置
```

## 能做什么

Rin 面向日常助手工作，而不只是写代码：

- 记住长期事实、偏好、项目和常用要求
- 总结、改写和整理文档
- 搜索最新网页信息
- 检查和管理文件
- 创建提醒和定时任务
- 从重复工作中保存长期笔记
- 协助代码和仓库工作
- 在你监督下操作本地命令或已连接服务
- 通过终端、桌面应用、自动化或已连接的聊天应用，以同一个助手身份回应

## 关键特性

| 特性             | 含义                                               |
| ---------------- | -------------------------------------------------- |
| 全局记忆         | 有用事实和经验可以留在单次聊天之外。               |
| 从重复使用中学习 | 纠正和成功流程可以变成紧凑的指令和技能。           |
| 本地后台运行时   | 不同界面连接到同一个助手状态，而不是孤立窗口。     |
| 开箱可用产品     | 内置记忆、定时任务、工具、聊天桥接和界面入口。     |
| 自举式开发       | Rin 用来构建 Rin，仓库本身就是助手流程的实时测试。 |

## 安全和成本

Rin 可以保留上下文、写入记忆、运行定时任务、搜索网页并反复调用模型。这可能比一次性聊天消耗更多模型 token、API 配额或订阅容量。

重要操作请保持监督。除非你理解风险并能审阅或回滚结果，否则不要让 Rin 执行不可逆或敏感操作。

<details>
<summary>技术方向</summary>

Rin 构建在 Pi 之上，并保留 Pi 的 KISS 优先精神：

- 保持核心小而可理解
- 把真实工具和上下文展示给模型
- 当这是最简单可靠的设计时，让模型自己决策
- 避免依赖特定模型的小技巧和过度调参的提示词
- 优先选择透明的本地状态，而不是远程平台锁定

Rin 不想成为沉重的 agent 框架。它想成为一个实用的日常助手：能记住、能行动、能改进，同时仍然可检查。

</details>

## 文档

这份 README 是公开用户概览。翻译文件位于 `readme/README.*.md`，应当和英文版本保持一致。

如果你要修改 Rin 本身，请从 [`docs/developer/README.md`](../docs/developer/README.md) 开始。面向 agent 的运行时指南和安装后的文档与这份公开 README 分开维护。
