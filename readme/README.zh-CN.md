[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [更多语言](README.md)

# Rin

Rin 是一个可以留在你自己电脑上的 AI 助手。

如果你已经会用 ChatGPT 或 OpenAI 订阅，Rin 面向的是下一步：一个能跨对话记住有用信息、逐渐学会你做事习惯、并且能帮你处理真实任务的助手，而不是每次都从零开始的新聊天。

Rin 不只是想法或演示。这个仓库就是通过 Rin 自己开发的：Rin 被作为长期运行的助手，用来规划、编辑、审查、翻译和维护 Rin。

## 为什么需要 Rin

大多数 AI 聊天很容易开始，也很容易丢失。

你解释自己的偏好、项目、工具和习惯。然后你打开一个新聊天，又要重新解释一遍。Rin 想让这种关系不要那么一次性。

Rin 围绕一个简单承诺构建：

- 跨会话保留同一个助手
- 全局记住有用的长期事实
- 从重复使用中改进，而不是要求你维护完美提示词
- 连接本地文件、网页信息、日程和聊天入口
- 保持足够简单，让你能检查和控制它

## 你可以用 Rin 做什么

你用自然语言和 Rin 说话。Rin 会使用你机器上和已配置账号中的可用工具。

例子：

- 记住偏好、名字、项目和常用要求
- 总结或改写文档
- 检查和整理文件
- 搜索网页上的最新信息
- 创建提醒和周期任务
- 从重复工作中保存有用经验
- 在监督下帮你操作电脑或服务
- 从终端、GUI 或已连接的聊天入口回答，同时仍然是同一个助手

Rin 的目标是全能助手，不只是写代码工具。写代码和仓库维护只是它能帮助的一类任务。

## Rin 有什么不同

### 开箱即用

Rin 被打包成一个产品，入口就是 `rin`。目标不是让用户自己组装框架、记忆系统、调度器和聊天桥。

### 全局记忆

Rin 可以把长期事实和可复用经验保存在单次对话之外。新会话可以带着更多真正重要的上下文开始。

### 隐式自改进

Rin 可以把重复实践沉淀成可复用的指令和技能。你不应该为了让助手学会你的做事方式而先成为提示词工程师。

### 长期运行的本地助手

Rin 有后台运行时，所以助手不绑定在某一个一次性窗口里。不同入口可以访问同一个底层助手状态。

### 自举式开发

Rin 正在用 Rin 维护。这个项目是它自身设计的实践测试：产品提供的助手，也被用来构建、审查、翻译和改进这个产品。

## Rin 的技术理念

Rin 继承 Pi 式设计价值：

- 让系统尽可能简单
- 清晰地暴露工具和上下文
- 在模型可以合理判断的地方，把决策交给模型
- 避免只为弥补提示词薄弱而写死的工作流
- 避免把产品依赖建立在某个特定模型的调优技巧上
- 优先选择本地、可检查的状态，而不是远程平台锁定

给技术读者：Rin 不想做集成市场优先的 agent 平台，也不想做研究优先的自训练实验室。它是一个实用助手产品：保持运行时小而清晰，给模型有用的工具和记忆，并专注长期日常可用性。

## 快速开始

### Linux 和 macOS

单命令安装，不需要 clone 仓库：

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

其他发布通道：

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

### Windows

在已安装 Node.js 和 npm 的 PowerShell 或 Windows Terminal 中安装，不需要 clone 仓库：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

其他发布通道：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

在 Windows 上，交互式安装器默认打开 GUI 安装器。它会依次处理语言、目标用户、安装目录、提供商/模型/认证、计划确认和最终应用。如果受保护写入需要确认，GUI 会显示一行终端交接命令，而不是在窗口内索要提权凭据。

安装后，Windows 默认是 GUI 优先：默认 `rin` 启动桌面 GUI，安装器会写入直接 GUI 启动器，以及用户级开机启动的后台运行时启动器。如果想从终端显式打开 GUI，可以使用 `rin gui`；如果需要终端安装器，可以使用 `rin-install --tui` / `rin-install --no-gui`。

### 从已有仓库安装

如果你已经把仓库拉到本地，仓库内的安装包装脚本会走同一套发布选择流程：

```bash
./install.sh              # stable release（默认）
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

打开 Rin：

```bash
rin
```

需要时检查健康状态：

```bash
rin doctor
rin status --watch  # 实时查看 worker 和定时任务活动
```

## 当前状态、安全和成本

Rin 正在积极开发，仍处于早期阶段。你应该预期会遇到粗糙边缘、不稳定行为、文档缺失和偶尔的破坏性变更。

因为 Rin 可以保留上下文、写入记忆、运行定时任务、搜索网页并重复调用模型，所以它可能比普通的一次性聊天消耗更多 token、API 配额或订阅容量。

重要工作请保持监督。除非你理解风险，并且能检查或回滚结果，否则不要让 Rin 执行不可逆、敏感或生产关键操作。

## 部署场景

安装器目前仍然是本地安装器，但下面这些安装形态已经可以围绕同一套 Linux/macOS/Windows 入口实现。目标环境仍需满足 Rin 的常规前置条件，包括 Node.js 和 npm：

| 场景             | 可行性                              | 说明                                                                                                             |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 本机或跨用户安装 | 当前已支持                          | 交互式安装器可以选择当前账号或另一个本机用户，并写入对应用户的启动器和后台服务。                                 |
| SSH 安装         | 当前可行                            | 通过 SSH 在远端主机执行 bootstrap 命令即可。后续可以补一个专用的 `rin install --ssh` 包装器来改善探测和报错。    |
| 容器化安装       | 在无头 Linux 镜像中可行             | 用持久卷保存 Rin home/安装目录，并在容器内运行后台运行时或 CLI。GUI 启动器和宿主机用户服务不适用于容器内部。     |
| 虚拟机安装       | 通过普通系统安装路径支持            | 在 guest OS 内像物理机一样安装 Rin。虚拟机快照便于回滚，但 Rin 仍只管理 guest 环境。                             |
| NAS 安装         | NAS 能运行 Node.js 或容器时可行     | 开放式 NAS 优先使用普通 Linux 路径；家电式 NAS 优先使用容器形态。厂商包管理器和受限 shell 可能需要设备专用说明。 |
| 云主机安装       | 通过 SSH 或 cloud-init 风格引导支持 | 把云 VM 当成远端 Linux 主机处理。`.rin` 数据应放在持久磁盘上，并按宿主 OS 配置后台启动。                         |

这些是部署场景，不是独立发布通道。stable、beta、nightly 和 git 仍沿用上面的同一套安装/更新契约。

## 当前内建能力

Rin 默认包含一套聚焦的能力：

- 长期记忆
- 定时任务和提醒
- 实时网页搜索
- 文件和 shell 工具
- 聊天桥支持
- GUI、TUI、CLI 和 RPC 风格访问路径
- 用于委托或脚本化助手回合的非交互 `rin -p` / `rin --mode json`

## 更新 Rin

正常更新已安装的 Rin：

```bash
rin update              # stable release（默认）
rin update --beta       # 当前每周 beta 候选
rin update --nightly    # 当前 nightly 构建
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

如果确认当前账号缺少 `rin`，应把它视为“当前账号不是启动器归属用户”。通过已安装元数据找回真正目标安装：

- `<targetHome>/.rin/installer.json`
- Linux: `~/.config/systemd/user/rin-daemon*.service`
- macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

然后直接调用稳定的已安装运行时入口：

```bash
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

这是已安装运行时的规范更新路径。它会刷新核心运行时和已安装文档，不会替换用户级 CLI 启动器或安装器。

重要发布通道规则：

- stable 是安装和更新的默认值
- `--beta` 表示当前每周 beta 候选
- `--nightly` 表示来自 `main` 的当前 nightly 构建
- 没有后缀的 `--git` 表示 `main`

不要把 `git pull`、临时重建或重新运行 `install.sh` 这样的仓库本地流程，当作更新已安装 Rin 的默认方式。

## 核心命令

```bash
rin            # 打开 Rin
rin doctor     # 检查健康状态和配置
rin status     # 查看 worker 和定时任务活动
rin target     # 查看和选择部署目标
rin --target x # 在已配置的目标环境中运行 Rin
rin start      # 启动后台运行时
rin stop       # 停止后台运行时
rin restart    # 重启后台运行时
rin update     # 更新已安装的 Rin 核心运行时
```

正常情况下直接使用 `rin`。`rin --std` 是默认 RPC 路径出问题时，用于前台恢复或调试的排障后备入口。

## 文档

这份 README 是用户文档。翻译版位于 `readme/README.*.md`，必须始终跟随英文版；用户可见内容变化时，翻译也要在同一次变更中更新。

内部文档已刻意分开：

- 给 agent 的运行时指导在 `docs/agent/`，安装后位于 `agentDir/docs/rin/`。
- 给开发人员的技术文档在 `docs/developer/`。
- 供 `/changelog` 和发布流程使用的发布说明元数据在 `docs/release/CHANGELOG.md`。

如果你要修改 Rin 本身，请从 [`docs/developer/README.md`](../docs/developer/README.md) 开始。

## 项目状态

Rin 正在向更干净的核心、更可靠的运行、更好的安装/更新流程，以及更有用的日常助手体验推进。

它仍然很早期。如果你想要的是完成度很高、界面完全稳定的产品，Rin 还没到那个阶段。如果你想尝试一个本地 AI 助手：它会记忆、会改进，并且已经在被用来构建它自己——这就是 Rin 正在努力成为的东西。
