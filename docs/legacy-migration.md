# 给 Agent 的 Rin 迁移手册

用户把[本手册原文](https://raw.githubusercontent.com/rinchan-hoshino/rin/main/docs/legacy-migration.md)交给你并要求迁移时，按下面步骤直接执行。先列出要保留的内容，再在已授权范围内迁移；只有缺少必要信息时才询问用户。

## 新旧 Rin 与源码

- **新 Rin**：本仓库 `main`，以 Codex 为执行核心，提供安装器、聊天桥和 Nerve。
- **旧 Rin**：同仓库 `legacy/pi`，是原来的 Pi harness、daemon 和扩展。只读它的源码与私人资料，按需重建有价值的功能；新版不依赖旧 runtime。

在工作目录执行以下命令，取得两代源码（macOS、Linux、PowerShell 通用）：

```sh
git clone --branch main https://github.com/rinchan-hoshino/rin.git rin-current
git clone --branch legacy/pi https://github.com/rinchan-hoshino/rin.git rin-legacy
```

这两个目录是读代码和开发用的源码目录，安装目录见下表。已有同名源码目录时直接复用，不覆盖用户改动。

先读 `rin-current/AGENTS.md`、[架构说明](next-rin.md)和[安装说明](installation.md)，再按需要查源码：

| 内容 | 新版 `rin-current/` | 旧版 `rin-legacy/` |
|---|---|---|
| 安装 | `src/install/` | `src/core/rin-install/` |
| 聊天 | `src/chat/`、`docs/chat-bridge.md` | `src/core/chat/`、`docs/agent/docs/chat-bridge.md` |
| 事件与定时任务 | `src/nerve*.ts`、`docs/nerve.md` | `docs/agent/docs/nerve-runtime.md`、`scheduled-tasks.md` |
| 记忆与私人能力 | 用户当前 Codex 指令和技能 | `docs/agent/docs/memory-layering.md`、`extensions.md` |

旧文档中并列的文件名都在 `docs/agent/docs/` 下。用 `rg` 查相关代码和记录，不运行旧程序。

## 默认目录

| 用途 | macOS / Linux | Windows |
|---|---|---|
| 旧 Rin 安装及资料 | `~/.rin/` | `%USERPROFILE%\.rin\` |
| 新 Rin 安装 | `~/.local/share/rin/` | `%LOCALAPPDATA%\Rin\` |
| 新 Rin 私人配置 | `~/.local/share/rin/private/` | `%LOCALAPPDATA%\Rin\private\` |
| Codex 配置、任务与技能 | `~/.codex/` | `%USERPROFILE%\.codex\` |

旧目录中的 `memory/`、`self_improve/`、`routines/`、`sessions/`、`data/` 是主要迁移资料；`settings.json` 是旧配置，`app/current/` 是旧程序。新版的 `private/daemon.json` 指定聊天桥和 Nerve 配置，`releases/` 存放安装版本。私人数据和源码分开放置。

## 执行步骤

1. **盘点并备份。** 阅读旧资料，列出实际要保留的身份、人格、记忆、技能、聊天命令、事件规则和资产。逐项说明“独有需重建 / 已有替代需验证 / 无需保留 / 只读存档”，先把清单展示给用户，再实施已授权事项。保留原文件；备份放私人目录，敏感文件仅当前用户可读。原图和附件保留原始字节与来源，迁移前后核对 SHA-256；SQLite 用一致性备份，不能只复制正在写入的主库而漏掉 WAL。
2. **安装新版。** 在 `rin-current` 中执行 `./install.sh`（macOS/Linux）或 `./install.ps1`（PowerShell），按[安装说明](installation.md)选择需要的产品。FFF 和 Nerve MCP 随 Rin 安装，聊天默认不启用。安装器确认替换旧版时会停用已识别的旧入口，所以提前完成备份，并从不依赖旧服务的终端执行。
3. **重建保留项。** 把仍有效的私人行为整理为当前指令、技能和配置，不整份复制旧配置或批量灌入历史。聊天从 [examples/chat.json](../examples/chat.json) 建私有配置，设置账号、当前 `allowUsers` 和任务绑定，具体见[聊天桥](chat-bridge.md)。事件按 [Nerve 文档](nerve.md)配置私有生产者和目标，只恢复选定的规则。密钥、人格与真实账号资料不进入公开仓库。
4. **启用并验收。** 旧接收者停止后再 `rin start`，同一机器人只保留一个接收者。逐个平台验证真实消息进入指定 Codex 任务、实际执行和外发回执，并检查附件、命令、过程输出、最终输出及一次重启后的去重。外发使用已授权目的地。MCP 注册后让 Codex 客户端重连，确认工具出现；连接成功或队列成功不等于端到端通过。
5. **交付结果。** 列出保留项的新去向、备份位置、已验证功能和剩余缺口。失败时停止新版服务、保留证据后修复重试，不自动启动旧 runtime，不合并新旧数据库。原始资料不擅自删除。

需要改新版源码时，遵循：验证并提交 → 推送远端 `main` → `rin update`。不要直接修改安装 release 或手改安装记录。

非默认安装时，把本文路径替换成你的实际路径即可。
