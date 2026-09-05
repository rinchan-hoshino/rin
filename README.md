# Rin

以 Codex 为执行核心的轻量聊天桥与事件服务。

`main` 维护 Codex 版本；旧 Pi 版本及完整历史保留在 [`legacy/pi`](https://github.com/rinchan-hoshino/rin/tree/legacy/pi)。新版不加载旧 Rin、Pi、旧 daemon 或旧扩展运行时。安装和更新只提供 Git 版，不发布 npm 包。旧版用户及协助迁移的代理先读[迁移指南](docs/legacy-migration.md)。

## 安装与使用

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.ps1 | iex
```

安装器仅使用英文：检查旧版、选择 Codex CLI / ChatGPT App、询问推荐配置意愿、填写全局 AGENTS，再准备产品、服务与可选原文检索。推荐配置尚未定稿，本版不改变已有 Codex 设置；用户填写的 AGENTS 只在本机保存，已有内容默认保留。

```sh
rin                    # Codex
rin exec "explain this" # Codex 参数原样透传
rin update             # 更新 Rin Git 版本
rin start              # 启用并启动已配置的后台服务
rin stop               # 停止并禁用自动启动
rin restart
rin -- update          # 强制把 update 交给 Codex
```

只有四个精确的首参数由 Rin 管理；其他命令不是旧 Rin 管理接口，而是 Codex 的输入。只用 CLI 不需要启动守护进程。安装默认留下空的 `private/daemon.json`；配置聊天或 Nerve 后才需要 `rin start`。平台安装方法、目录、升级恢复和已验证范围见 [安装说明](docs/installation.md)。

## 组件

- **一个 Rin 守护进程**：在同一个 Node 进程中组合聊天桥和 Nerve。两者按需启用，保留各自模块及状态库；不再用子进程常驻监管这两个职责。
- **聊天桥模块**：Discord、Telegram、QQ 官方、独立 OneBot v11、飞书适配器。将准入后的消息投递到已有 Codex 任务，转发公开文字、明确附件与生成图片；按平台能力编辑进度或发送消息快照。
- **Nerve 模块**：条件、定时、webhook 与 Discord 注意力事件，持久去重。可复用一个常驻 Codex App 任务，也可用独立的 `codex exec resume` 目标；记录真实完成，不自动重放结果不确定的事件。
- **本地状态**：SQLite 收件箱、发件箱与游标。账号、密钥、身份映射、人格资料及部署记录放在忽略的 `private/` 中。

QQ 官方机器人与 OneBot v11 是两种独立协议，必须分别配置、分别验收；OneBot 不绑定特定服务实现。

## 运行

需要 Node.js 24、已安装的 Codex，以及目标平台的机器人账号。先复制示例到私有配置目录并填写自己的账号和任务标识；示例中所有适配器默认关闭。

```sh
npm ci
npm test
node src/rin.mjs check /absolute/path/to/private/chat.json
node src/daemon.mjs /absolute/path/to/private/daemon.json
```

Codex App 路径依赖已核对的内部 IPC 与只读历史投影，目前锁定 0.153.x / paginated 模式。`appSteering` 和 `appWake` 为显式开关；自动唤醒目前仅支持 macOS。默认 CLI queue 的成功回执只代表排队，不保证未加载任务立即执行。版本升级或协议变化需要重新验证。

## 能力边界

Discord 的直接桥接和注意力模式、QQ 官方群文字与图片入站已有实际运行证据；其余能力的验证程度不同。独立生成图片结果的转发已经实现，但最近一次 QQ 补发因被动回复窗口过期被拒，最终到群仍需新的有效窗口验收。适配器存在和单测通过都不等于平台端到端可用。

- [架构决定与后续工作](docs/next-rin.md)
- [聊天桥配置、收发与恢复](docs/chat-bridge.md)
- [旧版能力差距与验证边界](docs/chat-parity-audit.md)
- [保留的呈现行为与来源](docs/legacy-render-audit.md)
- [Nerve 配置与 MCP](docs/nerve.md)
- [实验性 Codex App 接入](docs/codex-app-steering.md)

源码与运行部署分开；提交代码不会自动替换正在运行的服务。GPL-3.0，见 [LICENSE](LICENSE)。
