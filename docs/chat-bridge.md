# Rin 聊天桥

独立 Node.js 24 进程，包含五个适配器，无旧 Rin/Pi/cc-connect 运行依赖。

```sh
npm ci
node src/rin.mjs check /absolute/path/to/private/chat.json
node src/rin.mjs serve /absolute/path/to/private/chat.json
node src/rin.mjs status /absolute/path/to/private/chat.json
```

配置从 [examples/chat.json](../examples/chat.json) 复制到私有目录。平台凭证直接填写在私有聊天配置中；该配置与数据库不应提交到仓库。Nerve 接口令牌的配置另见 Nerve 文档。

## 会话与准入

所有直接入口要求 `allowUsers` 匹配平台提供的用户 ID。Discord 默认仅私聊；其他平台的群消息默认要求提及机器人。先准入与检查绑定，再下载附件。

`/bind <已有任务 UUID>`、`/status`、`/unbind` 管理直接绑定。一个任务只能绑定一个聊天；`mirror:true` 表示该任务之后所有公开输出都会同步，包括在 App 中直接开展工作的输出。初次绑定不回放历史，动态绑定持久化后优先于初始配置。

QQ 官方平台使用 OpenID，不能把普通 QQ 数字号或 OneBot 用户 ID 当成它。平台开发体验资格与本地白名单是独立门槛。Discord 的 Nerve 注意力模式则停用直接绑定入口，见 [Nerve](nerve.md)。

## 输入、公开输出与附件

输入通过持久收件箱投递。默认原生 `codex queue` 只保证排队；显式开启 `codex.appSteering` 后可通过 App IPC start/steer，`appWake` 可加载未打开任务。目前自动加载仅支持 macOS，且可能显示目标任务窗口。

观察器只读 `state_5.sqlite` 与 `thread_history_1.sqlite`，只接受已核对的 0.153.x / paginated 结构。提取公开文字、公开摘要和完成的 `imageGeneration.savedPath`，不提取图片结果中的提示词/base64、工具输出或私有推理；不修改 Codex 数据库。不兼容时停止该任务观察与新提交。

本地 Markdown 附件链接必须指向 `attachmentRoots` 内的真实普通文件，大小不超过 20 MiB；代码块中的链接不作为附件。当前任务自己的 `generated_images/<threadId>` 目录也可用，跨任务路径与越界符号链接会被拒绝。文本与媒体保持原始顺序，各自单独投递；不自动下载远程输出链接。

## 平台能力

| 适配器 | 接入 | 编辑 | typing | 媒体 |
|---|---|---|---|---|
| Discord | Gateway | 有，共享进度槽与最终清理 | 有 | 文本与文件 |
| Telegram | getUpdates | 有，共享进度槽与最终清理 | 有 | 图片与文件 |
| QQ 官方 | 官方 SDK WebSocket | 无，发送完整消息快照 | 仅 C2C | SDK 图片/语音/视频/文件接口 |
| OneBot v11 | 正向 WebSocket，可选 HTTP action | 无；可删除 | 无标准能力 | base64 媒体；普通文件依赖扩展 action |
| 飞书 | 官方 SDK 长连接 | 有 | 无 | post、图片与文件 |

QQ 官方回复受被动消息时限和额度限制，不能随意去掉 msg_id 改为主动群消息。OneBot 不绑定 NapCat；其普通文件上传 action 并非所有 v11 实现都支持。完整实测边界见 [能力审计](chat-parity-audit.md)，不能用连接成功替代端到端验收。

## 恢复与运行

SQLite 保存入站去重、平台游标、队列回执、公开消息缓冲、引用上下文和发件箱。已知远端 ID 的编辑可以退避重试；首次发送或入站提交若结果不确定，记录 `uncertain`，需要核对外部效果后再处理。重启恢复观察游标及未结束文字缓冲，不盲目重放。

QQ 诊断只记录网关事件类型和准入失败的账号/聊天标识，不写消息正文；日志仍属私人运行数据。源码变更不等于部署。按平台逐项验证入站、附件、模型执行、typing 清理、进度顺序、最终发送、断网重连与重启恢复。

## Unified chat commands

The shared command registry provides `/help`, `/usage`, `/bind <task UUID>`, `/status`, and `/unbind`. Text commands and platform menus use the same admission rules. Commands do not create a model turn. `/new`, `/abort`, model selection, and other remote administration commands are not registered.

`allowUsers` admits messages. Set each adapter's `ownerUsers` to the platform IDs allowed to use `/usage`, `/bind`, and `/unbind`. A single-entry `allowUsers` list defaults to that one owner; a multi-entry list grants no command administration until `ownerUsers` is configured. Account usage is available only in a private chat, including when a group interaction supports ephemeral responses. Group replies contain no account, model, task ID, or filesystem details. Normal group messages still require a mention.

Command IDs are claimed durably before execution, so platform replays cannot repeat binding changes or usage reads. Interrupted commands are not automatically replayed. Discord interaction handles exist only in memory; after restart or expiry, Rin cannot recover the private response and will never fall back to a public channel.

Discord reconciles its application command menu at startup; Telegram reconciles the default bot command scope. Failed registration emits a warning without stopping message delivery. Telegram commands addressed to another bot are ignored. Old Telegram menus with narrower scopes can override the default menu; Rin does not silently delete those scopes.

### Usage

`/usage` and `/usage card` return a current quota card with the full text result. `/usage current` and `/usage text` return text. `/usage history --days 14` reads newly recorded local snapshots; `/usage history --json` exports them. `/usage --help` lists supported arguments. The provider reads the local Codex app-server's account rate-limit API, including every returned limit bucket and both windows, with used/remaining percentages and reset times. Unknown fields stay unknown. API spending is not presented as subscription quota. No purchase or usage-reset operation is implemented.

Snapshots and cards live under the configured private `dataDir/usage`. Old Rin databases are not imported. History begins with the first new successful read and is not a complete record of account activity.

### Working text

Only the generic working indicator is localized. Put optional settings in the private chat configuration:

```json
{
  "display": {
    "working": {
      "language": "zh-CN",
      "frames": ["处理中...", "正在推进..."],
      "intervalMs": 30000
    }
  }
}
```

Built-in languages are `en`, `zh-CN`, and `ja`; English is the fallback. Nonempty custom frames override the preset. Editable platforms rotate the generic heading while preserving existing summaries and commentary. Final output, completion, failure, observer errors, and shutdown stop rotation. Platforms without editing receive one working marker. Installer text and other chat text are outside this localization setting.

QQ official bots also have a [command panel OpenAPI](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/). Rin reconciles only panels with its ownership remark `Rin commands`: five commands in C2C, and `/help` plus `/status` in groups. It does not change other panels or the global custom menu. Duplicate ownership markers, incomplete lists, incompatible target scopes, and missing permissions produce a warning instead of a blind overwrite. A command panel fills the input box; message admission and QQ passive-reply rules still apply. These APIs are unrelated to OneBot v11.
