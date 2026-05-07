[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [更多语言](README.md)

# Rin

> **住在你电脑里的个人 AI 助手。**<br>
> Rin 会记住重要信息，帮你处理真实任务，并在日常使用中变得更懂你。

Rin 不是又一个普通聊天窗口。它是一个可以长期陪伴的助手：本地运行、可检查，在你允许时连接你的工具，并能在不同会话之间保留有用记忆。

> [!NOTE]
> Rin 也由 Rin 自己参与构建。这个项目一直使用 Rin 来规划、编辑、审阅、翻译和维护仓库，所以自我改进是在产品自身里被验证的能力。

## ✨ 为什么试试 Rin

| 你想要……           | Rin 会努力做到……                         |
| ------------------ | ---------------------------------------- |
| 少重复解释         | 记住长期事实、偏好、项目和常用要求       |
| 越用越懂你的助手   | 把反复纠正和成功流程变成记忆与技能       |
| 不用自己搭一套系统 | 自带记忆、定时任务、工具、聊天桥接和界面 |
| 清楚知道它动了什么 | 本地运行，并展示它使用的工具、文件和配置 |
| 一个助手，多处入口 | 连接终端、桌面应用、自动化和聊天应用     |

## 🧰 Rin 可以做什么

Rin 是通用助手。根据你的配置，它可以：

- 总结、改写和整理文档
- 搜索最新网页信息
- 检查和管理文件
- 创建提醒和定时任务
- 从重复工作中保存长期笔记
- 协助代码和仓库工作
- 在你监督下操作本地命令或已连接服务
- 通过终端、桌面应用、自动化或已连接的聊天应用，以同一个助手身份回应

## 🌱 Rin 有什么不同

### 全局记忆

普通聊天很容易遗忘上下文。Rin 可以把长期事实和可复用经验放在单次对话之外，并在需要时重新带回来。

### 自动学习与进步

你不应该为了教会助手而先成为提示词专家。Rin 可以把反复纠正和成功流程整理成紧凑的指令和技能。

### 常驻后台的本地助手

Rin 不是一个用完就关掉的标签页。后台进程让不同界面可以连接到同一个助手状态。

### Rin 参与开发自己

Rin 用 Rin 维护。这个仓库本身就是一个实时示范：助手可以帮助改进助手自己。

## ⚠️ 当前状态

> [!WARNING]
> Rin 还很年轻。日常使用请先按实验性软件看待：你可能会遇到粗糙边缘、文档缺口、不稳定行为或偶发破坏性变更。

因为 Rin 可以保留上下文、写入记忆、运行定时任务、搜索网页并反复调用模型，它可能比一次性聊天消耗更多模型 token、API 配额或订阅容量。

重要操作请保持监督。除非你理解风险并能审阅或回滚结果，否则不要让 Rin 执行不可逆或敏感操作。

## 🚀 安装

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

### 已有仓库检出

```bash
./install.sh              # 稳定版（默认）
./install.sh --beta       # 当前每周 beta 候选
./install.sh --nightly    # 当前 nightly 构建
./install.sh --git        # main
./install.sh --git main
./install.sh --git deadbeef
```

```powershell
.\install.ps1
.\install.ps1 --beta
.\install.ps1 --nightly
.\install.ps1 --git
.\install.ps1 --git main
.\install.ps1 --git deadbeef
```

## ⌨️ 基础命令

```bash
rin            # 打开 Rin
rin doctor     # 检查健康状态和配置
rin status     # 查看实时 worker 和定时任务活动
rin start      # 启动后台运行时
rin stop       # 停止后台运行时
rin restart    # 重启后台运行时
rin update     # 更新已安装的 Rin 运行时
rin -p "..."   # 运行一次非交互助手回合
```

<details>
<summary>🧭 给技术读者</summary>

Rin 构建在 Pi 之上，并保留 Pi 的 KISS 优先精神：

- 保持核心小而可理解
- 把真实工具和上下文展示给模型
- 当这是最简单可靠的设计时，让模型自己决策
- 避免依赖特定模型的小技巧和过度调参的提示词
- 优先选择透明的本地状态，而不是远程平台锁定

Rin 不想成为沉重的 agent 框架。它想成为一个实用的日常助手：能记住、能行动、能改进，同时仍然可检查。

</details>

## 🔄 更新

普通已安装 Rin 的更新使用：

```bash
rin update              # 稳定版（默认）
rin update --beta       # 当前每周 beta 候选
rin update --nightly    # 当前 nightly 构建
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

安装和更新默认使用 stable。`--beta` 选择当前每周 beta 候选，`--nightly` 选择来自 `main` 的当前 nightly 构建，不带后缀的 `--git` 选择 `main`。

不要把仓库内的 `git pull`、临时重建或重新运行 `install.sh` 当成更新已安装 Rin 的默认方式。

## 📚 文档

这份 README 是公开用户概览。翻译文件位于 `readme/README.*.md`，应当和英文版本保持一致。

如果你要修改 Rin 本身，请从 [`docs/developer/README.md`](../docs/developer/README.md) 开始。面向 agent 的运行时指南和安装后的文档与这份公开 README 分开维护。
