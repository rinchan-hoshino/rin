[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [更多语言](README.md)

# Rin

> 说明：这是便于阅读的翻译版本，规范内容以英文 README（`../README.md`）为准，且英文版可能更新更快。

一个终端优先的本地 AI 助手：能聊天、改文件、记事情、联网搜索，还能跑定时任务。

## Rin 是什么

Rin 不是那种只适合一次性对话的 coding agent。

它更像一个可以长期放在终端里陪你做事的本地助手：

- 用自然语言直接提需求
- 查看和修改文件
- 保留有用的长期记忆
- 设置提醒和周期任务
- 查询最新网页信息
- 通过聊天桥把同一个助手接到聊天平台

目标很简单：让 agent 更像真正能长期使用的工具，而不只是模型外面套的一层壳。

## 为什么用 Rin

Rin 主要抓这几件事：

- 终端优先
- 不只是无状态聊天，还内建记忆
- 内建定时任务
- 对时效性问题内建 Web 搜索
- 内建聊天桥支持
- 围绕 `rin` 这个产品入口使用

如果你想要的是一个能长期帮忙的助手，Rin 就是按这个方向做的。

## 快速开始

单命令安装，不需要先 clone 仓库：

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
```

如果你已经把仓库拉到本地，也可以直接执行仓库内的 `install.sh` 包装脚本：

```bash
./install.sh
```

然后打开 Rin：

```bash
rin
```

需要时检查运行状态：

```bash
rin doctor
rin status --watch  # 实时查看 worker 和定时任务活动
```

安装器会提醒你安全边界，以及可能出现的额外 token 开销。这些开销可能来自初始化、记忆处理、总结压缩、subagent、定时任务和 Web 搜索等流程。

### 部署场景

安装器目前仍然是本地安装器，但下面这些安装形态已经可以围绕同一套 Linux/macOS/Windows 入口实现。目标环境仍需满足 Rin 的常规前置条件，包括 Node.js 和 npm：

| 场景             | 可行性                              | 说明                                                                                                             |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 本机或跨用户安装 | 当前已支持                          | 交互式安装器可以选择当前账号或另一个本机用户，并写入对应用户的启动器和 daemon 服务。                             |
| SSH 安装         | 当前可行                            | 通过 SSH 在远端主机执行 bootstrap 命令即可。后续可以补一个专用的 `rin install --ssh` 包装器来改善探测和报错。    |
| 容器化安装       | 在无头 Linux 镜像中可行             | 用持久卷保存 Rin home/安装目录，并在容器内运行 daemon 或 CLI。GUI 启动器和宿主机用户服务不适用于容器内部。       |
| 虚拟机安装       | 通过普通系统安装路径支持            | 在 guest OS 内像物理机一样安装 Rin。虚拟机快照便于回滚，但 Rin 仍只管理 guest 环境。                             |
| NAS 安装         | NAS 能运行 Node.js 或容器时可行     | 开放式 NAS 优先使用普通 Linux 路径；家电式 NAS 优先使用容器形态。厂商包管理器和受限 shell 可能需要设备专用说明。 |
| 云主机安装       | 通过 SSH 或 cloud-init 风格引导支持 | 把云 VM 当成远端 Linux 主机处理。`.rin` 数据应放在持久磁盘上，并按宿主 OS 配置 daemon 自启动。                   |

这些是部署场景，不是独立发布通道。stable、beta、nightly 和 git 仍沿用上面的同一套安装/更新契约。

## 你可以直接这样让 Rin 做事

打开 Rin 后，直接像聊天一样说就行。

比如：

- `帮我看看这个目录里什么最重要。`
- `把这个 README 重写一下。`
- `整理一下这个配置文件。`
- `记住我喜欢简短回答。`
- `明天下午提醒我检查日志。`
- `帮我查一下这个工具最新的官方文档。`
- `每小时看看这个目录有没有变化。`

## 核心命令

```bash
rin            # 打开 Rin
rin doctor     # 检查状态和配置
rin status     # 查看 worker 和定时任务活动
rin start      # 启动 daemon
rin stop       # 停止 daemon
rin restart    # 重启 daemon
rin update     # 更新 Rin
```

## 默认内建能力

Rin 默认就接好了这些能力：

- 长期记忆
- 定时任务和提醒
- 实时 Web 搜索
- 覆盖 Telegram、OneBot、Discord、Kook、QQ、Lark、Mail、WeChat Official、WeCom、DingTalk、Matrix、WhatsApp、LINE、Slack、Zulip 等聊天桥适配器
- 用于委托工作的 subagent

## 什么时候用 `rin --std`

正常情况下直接用 `rin`。

`rin --std` 主要是默认 RPC 模式出问题时的排障后备入口，用来前台恢复或调试，不是平时的默认打开方式。

## 文档

这份 README 是用户文档。翻译版位于 `readme/README.*.md`，必须始终跟随英文版；用户可见内容变化时，翻译也要在同一次变更中更新。

内部文档已分开存放：

- 给 agent 的运行时指导在 `docs/agent/`，安装后位于 `agentDir/docs/rin/`。
- 给开发人员的技术文档在 `docs/developer/`。
- 供 `/changelog` 和发布流程使用的发布说明元数据在 `docs/release/CHANGELOG.md`。

## 一句话总结

装好它，运行 `rin`，然后直接说你要它做什么。

这就是 Rin。
