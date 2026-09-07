# Rin 聊天桥

独立 Node.js 24 进程，包含五个适配器，无旧 Rin/Pi/cc-connect 运行依赖。

```sh
npm ci
npm run build
node src/rin.mjs check /absolute/path/to/private/chat.json
node src/rin.mjs serve /absolute/path/to/private/chat.json
node src/rin.mjs status /absolute/path/to/private/chat.json
```

配置从 [examples/chat.json](../examples/chat.json) 复制到私有目录。平台凭证直接填写在私有聊天配置中；该配置与数据库不应提交到仓库。Nerve 接口令牌的配置另见 Nerve 文档。

## 会话与准入

所有直接入口要求 `allowUsers` 匹配平台提供的用户 ID。Discord 默认仅私聊；其他平台的群消息默认要求提及机器人。先准入与检查绑定，再下载附件。

`ownerUsers` 是可选的旧身份迁移字段，不能从 `allowUsers` 推导，也不会给命令或普通消息增加准入权限。它只允许适配器在每条群消息上取得完整成员证明后，把“唯一非机器人成员正是该显式 owner”的群按私聊规则处理；传输类型仍为群。成功结果不缓存，失败、接口缺失或成员不完整都按普通群，失败结果最多缓存十分钟。Telegram 使用 `getChatMemberCount = 2` 加上 bot 与发件人的在群证明；OneBot 使用完整 `get_group_member_list`（且必须含本机 bot）；飞书逐页读取全部成员并核对用户/机器人总数。Discord 当前缓存、线程已加入成员和频道可见成员都不能证明完整成员集合，QQ 官方没有完整群成员 API，所以两者安全地保持群规则。

直接路由由私有 `bindings` 配置提供，一个任务只能绑定一个聊天。`mirror:true` 表示该任务之后所有公开输出都会同步，包括在 App 中直接开展工作的输出；不会回放已有历史。

QQ 官方平台使用 OpenID，不能把普通 QQ 数字号或 OneBot 用户 ID 当成它。平台开发体验资格与本地白名单是独立门槛。Discord 的 Nerve 注意力模式则停用直接绑定入口，见 [Nerve](nerve.md)。

## 输入、公开输出与附件

输入通过持久收件箱投递到共享 app-server。已有任务通过 `thread/resume` 加载或重连，再调用 `turn/start`；Codex 原生决定开始新轮次或向运行中的轮次追加输入。Rin 不覆盖模型、工作目录、沙箱和审批设置。默认入口不存在时启动原生 app-server，Rin 关闭时只断开客户端。`codex.endpoint` 可指定已有的同机共享入口；旧 `appSteering`/`appWake` 字段已无作用，可删除。详见 [共享服务](codex-app-steering.md)。

观察器只读 `state_5.sqlite` 与 `thread_history_1.sqlite`，只接受已核对的 0.153.x / paginated 结构。提取公开文字、公开摘要和完成的 `imageGeneration.savedPath`，不提取图片结果中的提示词/base64、工具输出或私有推理；不修改 Codex 数据库。不兼容时停止该任务观察与新提交。

本地 Markdown 附件链接必须指向 `attachmentRoots` 内的真实普通文件，大小不超过 20 MiB；代码块中的链接不作为附件。当前任务自己的 `generated_images/<threadId>` 目录也可用，跨任务路径与越界符号链接会被拒绝。文本与媒体保持原始顺序，各自单独投递；不自动下载远程输出链接。

## 平台能力

| 适配器 | 接入 | 编辑 | typing | 媒体 |
|---|---|---|---|---|
| Discord | Gateway | 有，共享进度槽与最终清理 | 有 | 文本与文件 |
| Telegram | getUpdates | 有，共享进度槽与最终清理 | 有 | 图片与文件 |
| QQ 官方 | 官方 SDK WebSocket | 无，发送完整消息快照 | 仅 C2C | SDK 图片/语音/视频/文件接口 |
| OneBot v11 | 正向 WebSocket，可选 HTTP action | 无；可删除 | 无标准能力 | base64 媒体；普通文件依赖扩展 action |
| 飞书 | 官方 SDK 长连接 | 无，发送完整消息快照 | 无 | post、图片与文件 |

QQ 官方回复受被动消息时限和额度限制，不能随意去掉 msg_id 改为主动群消息。OneBot 不绑定 NapCat；其普通文件上传 action 并非所有 v11 实现都支持。完整实测边界见 [能力审计](chat-parity-audit.md)，不能用连接成功替代端到端验收。

## 恢复与运行

SQLite 保存入站去重、平台游标、队列回执、公开消息缓冲、引用上下文和发件箱。支持编辑的平台会对已知远端 ID 退避重试；首次发送或入站提交若结果不确定，记录 `uncertain`，需要核对外部效果后再处理。重启恢复观察游标及未结束文字缓冲，不盲目重放。

QQ 诊断只记录网关事件类型和准入失败的账号/聊天标识，不写消息正文；日志仍属私人运行数据。源码变更不等于部署。按平台逐项验证入站、附件、模型执行、typing 清理、进度顺序、最终发送、断网重连与重启恢复。

## Unified chat commands

The authoritative catalog contains `/help`, `/usage`, and locally installed command extensions. The same catalog drives text invocation, execution, help, and platform registration. Existing `bindings` remain message routes and are independent of command discovery.

Command permission uses the same explicit `allowUsers` admission on every adapter, with no owner role or channel allowlist. `ownerUsers` can only participate in the separately proven private-like presentation rule; it does not authorize a command. Registered commands bypass `dmOnly` and the group-mention requirement; native slash interactions also address the bot directly. A slash-like text is classified before catalog lookup: `/name@this_bot` is accepted as `name`, `/name@another_bot` is never executed locally, and `/session` remains silently ignored for compatibility. After admission, an unregistered slash command replies `Unknown command. Send /help to see available commands.` in a direct or proven private-like chat and stays silent in an ordinary group. `privateOnly` restricts where an extension result may be shown; built-in `/help` and `/usage` are available in groups. Recognized Discord controls do not enter the model path.

Command IDs are claimed durably before execution, so platform replay cannot invoke a handler twice. Interrupted commands are not automatically replayed. Discord private response handles exist only in memory: after restart or expiry, a reply fails closed instead of posting publicly.

### Private command directory

Put one `.mjs` module per command in `dataDir/commands`, or set `commands.directory` in the private chat configuration (relative paths resolve under `dataDir`). Rin creates the directory privately, loads modules at startup, and registers the resulting catalog. Run `rin restart` after adding, editing, or removing a module. These are trusted local Node.js modules, independent of Pi; they can import the user's own helpers.

```js
export default {
  name: 'hello',
  description: 'Say hello',
  argument: 'Optional name',
  privateOnly: false,
  async run({ args, message, dataDir }) {
    return { text: `Hello, ${args || 'there'}!` };
  },
};
```

`name` starts with a lowercase letter and contains 1–13 lowercase letters, digits, or underscores. `description` is 1–100 characters. `argument` is an optional 1–100 character description; `privateOnly` is an optional boolean. `run` receives `args`, `dataDir`, and the admitted message's adapter, ID, chat ID, user ID, kind, and text. A resolved handler completes the command, whether built in or loaded locally; it never falls through to another handler or the model. It may return nothing (`undefined` or `null`), an empty output object, or `{text, files?}`. No `silent` flag is required. Discord clears the deferred private response when there is no output; files use `{path, name?, mimeType?}`. Results go through the existing text/file delivery path; extensions cannot redirect a result by returning a different target.

Only regular `.mjs` files are loaded, in filename order. Invalid definitions and import failures are skipped with a fixed warning. Extensions cannot replace a built-in name; if extensions share a name, all conflicting definitions are rejected. Unrelated valid extensions still load. No model turn or extra approval role is introduced by the command layer.

Platform command APIs are reconciled to the complete catalog. Discord updates the global application catalog and clears overrides in the bot's actual guilds so they cannot shadow that catalog. Telegram clears the known legacy private/group/admin scopes before maintaining its default catalog. QQ command panels are reconciled across supported scopes; unrelated non-command menu content is preserved. Failed or unavailable API operations produce a warning without holding daemon readiness indefinitely. Actual readback is needed to establish whether old commands were removed.

### Usage

`/usage` and `/usage card` return a PNG combining native account quota and daily token activity. `/usage weekly` and `/usage cumulative` select the other native activity views. `/usage text` (or `--text` with a view) returns text; image results carry text only as a delivery-failure fallback. `/usage --help` lists arguments. The provider calls the local Codex app-server's read-only `account/read`, `account/rateLimits/read`, and `account/usage/read` methods. Every returned limit bucket is included. Missing metrics stay unavailable; lifetime, peak, streak and longest-task summary values come directly from Codex. Daily cloud buckets use Sunday-based weeks for the weekly and cumulative views. No purchase or usage-reset operation is implemented.

Only rendered PNG artifacts are written under private `dataDir/usage/cards`, retaining the latest 24 native cards. There is no local quota history, rollout indexing, or token-price estimation. Old statistics are neither read nor merged.


### Working text

The working indicator is plain display text. Put optional settings in the private chat configuration:

```json
{
  "display": {
    "working": {
      "text": "处理中...",
      "frames": ["处理中...", "正在推进..."],
      "intervalMs": 30000
    }
  }
}
```

Nonempty `frames` take priority over `text`. If neither is supplied, Rin uses one `Working...` frame. Editable platforms rotate configured frames while preserving existing summaries and commentary. Final output, completion, failure, observer errors, and shutdown stop rotation. Platforms with reaction support create one working reaction for the accepted reply and remove it at the same lifecycle boundary; if the platform rejects that reaction, they fall back to one quoted working marker. Other platforms without editing receive one working marker. This setting does not select a language or change other chat text.

QQ official [command panels](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/) fill the chat input box. Message admission and passive-reply rules still apply; this API is unrelated to OneBot v11.


## 首条消息自动建立任务

适配器可配置 `autoBind`，无需逐个频道预建 Codex 任务：

```json
"autoBind": {
  "cwd": "/absolute/path/to/chat-workspace",
  "excludedChatIds": ["channel-to-leave-unbound"]
}
```

`cwd` 为新任务的工作目录；可选 `model` 指定模型，省略则使用当前 Codex 配置。现有显式绑定优先。未绑定聊天在第一条通过用户白名单、群提及要求的普通消息（包括有附件的消息）到达时建立独立任务；命令不会创建任务。结果存入聊天桥状态库，后续消息及重启复用它。创建结果不确定时保留标记并停止自动重建，需核对后处理，避免出现重复任务。如果同一平台账号由私有消息服务接收，请不要再在聊天桥中启动该账号。自动绑定只从实际收到的聊天建立，不枚举频道或预建空任务。
