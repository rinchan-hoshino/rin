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
