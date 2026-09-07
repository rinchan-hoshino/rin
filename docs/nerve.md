# Nerve：通用事件投递

Nerve 只负责持久队列、去重和投递回执。事件生产者决定何时产生事件，目标程序决定如何接收事件。定时规则、Discord 消息策略、游戏协议和个人资料都放在使用者自己的脚本中。

## 配置

```json
{
  "database": "events.sqlite",
  "port": 9761,
  "scriptsDirectory": "producers",
  "targets": {
    "inbox": {
      "type": "command",
      "argv": ["node", "/absolute/path/to/inbox.mjs"],
      "receipt": true,
      "timeoutMs": 30000
    }
  }
}
```

`command` 用 argv 数组启动程序，向 stdin 写入 `{id,payload}`，不经过 shell。启用任务路由后额外提供入队时固定的 `threadId` 元数据。普通命令成功退出即表示投递完成；设置 `receipt: true` 时，stdout 必须是 `{accepted:true,...}`。明确未接收的程序可返回 `{accepted:false,retryable:true,error:"..."}`，此时才允许自动重试。命令超时、异常退出或无有效回执默认保留为 `uncertain`。

`http` 目标向固定 `url` POST 事件 payload，并带 `Idempotency-Key` 事件 ID；可用 `tokenEnv` 指定目的服务的 Bearer token 环境变量。HTTP 成功状态表示目的端接收成功。只有目的端保证幂等时才设置 `idempotent: true`，让失败按有界退避重试。`maxAttempts` 默认 3。

同一目标的投递串行，不同目标轮转取件，最多 16 个并发投递。进程意外停止时，原先的 `running` 记录变为 `uncertain`，避免重放可能已产生副作用的操作。

**`done` 只代表目的端的接收回执，不代表模型轮次或业务任务完成。** Nerve 不管理模型执行生命周期。用户可以显式创建一个任务作为事件目的地；创建本身不运行模型轮次。

## 用户脚本目录

配置 `scriptsDirectory` 后，服务启动目录顶层的每个 `.mjs` 文件，并在退出后按 2–60 秒退避重启。脚本继承环境，并获得本机 `NERVE_ENDPOINT`、`NERVE_TOKEN`。服务关闭时先通知脚本退出，最多等待 20 秒后终止。

脚本可自行使用官方平台 SDK、定时库或其他事件源。定时游标、平台消息记录和输出工具由脚本自己维护；同一平台账号只应有一个接收者。Nerve 不依赖这些脚本的业务结构。

`dist/nerve-emit.js` 导出 `emitEvent({id,target,payload,source?})`，使用上述环境变量提交事件并核对队列回执；直接运行时从 stdin 读取同样的 JSON。使用稳定事件 ID：同一 ID、目标、source 和 payload 的重投返回已有记录；同一 ID 携带不同内容会被拒绝。

## Codex 输入适配命令

需要向已有 Codex 任务提交时，可以将目标设为：

```json
{
  "type": "command",
  "argv": ["node", "/absolute/rin/dist/codex-input-command.js", "existing-task-uuid"],
  "receipt": true,
  "timeoutMs": 60000
}
```

payload 提供 `prompt`。这个独立输入适配命令与聊天桥共用 app-server 客户端：连接共享服务（默认本机入口不存在时直接启动），恢复已有任务，再提交原生 `turn/start`。它不覆盖执行配置，收到含 turn ID 的提交回执后退出；模型继续由共享服务执行。回执不代表轮次完成，模型输出仍由聊天桥或独立业务处理。可在任务 UUID 后增加 endpoint 参数，选择与聊天桥相同的已有服务；`CODEX_HOME` 决定本机默认 socket 与配置目录。

## 默认任务与来源绑定

需要让不同触发器进入不同任务时，在已有 command target 上显式配置：

```json
{
  "type": "command",
  "argv": ["node", "/absolute/rin/dist/codex-input-command.js", "11111111-1111-4111-8111-111111111111"],
  "receipt": true,
  "taskRouting": {
    "defaultThreadId": "11111111-1111-4111-8111-111111111111"
  }
}
```

`taskRouting` 只适用于 command target。可选 `codexHome` 和 `endpoint` 指定显式创建与绑定检查使用的 Codex 实例；它们必须与输入命令使用的实例一致。已有任务检查读取本机 `codexHome/state_5.sqlite`，因此 endpoint 必须对应同一份本机状态，不支持校验另一台机器上独立存储的任务。未配置该字段的旧目标继续使用原 argv 默认任务。自定义输入命令需要读取 stdin 顶层 `threadId`，不能从 payload 选择任务。

生产者在 `source` 提供固定的触发器 ID 或其他稳定来源标识；例如 `{id:"daily-review:2026-09-08",target:"inbox",source:"daily-review",payload:{prompt:"Review pending work."}}`。来源由可信生产者决定，不能把聊天正文、网页内容或事件 payload 中的字段当成来源或路由指令。Nerve 不维护来源的定时规则和业务内容。

- `nerve_list_task_bindings({})`：查看每个目标的默认任务和显式绑定。
- `nerve_bind_task({target:"inbox",source:"daily-review",threadId:"existing-task-uuid"})`：绑定已有、未归档的任务。省略 `threadId` 恢复该 target 的默认任务。
- `nerve_create_task({id:"daily-review-task-v1",target:"inbox",source:"daily-review",cwd:"/absolute/workspace",name:"Daily review"})`：显式创建一个原生任务，持久化一条中性说明，再绑定。使用已有共享 Codex 服务，不启动模型轮次，不建立第二套执行运行时。
- `nerve_get_task_creation({id:"daily-review-task-v1"})`：读取创建回执。相同创建 ID 不重复创建；参数改变会冲突。`pending` 或 `uncertain` 必须先检查已知任务 ID 和原生任务列表，确认后可以用绑定工具完成恢复。不要删除用户原有任务，也不要换 ID 盲目重放。

绑定以 `(target,source)` 联合保存。入队事务同时读取绑定并将 `threadId` 固定到事件独立列；没有绑定时使用配置默认任务。改绑、恢复默认、改变默认配置都只影响之后的新事件。同 ID 重投、自动退避和 `failed/uncertain` 手动重试均不改变已有目的地，payload 中的 `threadId` 不参与路由。

旧事件没有该元数据时继续原输入命令行为。若从外部适配层迁移已有任务绑定或排队快照，应先备份，在明确目标后有界迁移元数据；不要根据新的默认任务重新解析旧事件，也不要重建事件 ID。

## HTTP 与 MCP

所有 HTTP 接口绑定 loopback，必须使用至少 24 字符随机 `NERVE_TOKEN`。`GET /health`、`GET /events`、`GET /events/:id` 用于检查；`POST /events` 提交 `{id,target,payload,source?}`；`POST /events/:id/retry` 显式重试 failed/uncertain 记录。任务路由使用 `GET /task-bindings`、`POST /task-bindings`、`POST /task-bindings/create` 和 `GET /task-creations/:id`，请求字段与上述 MCP 工具一致。输入上限 1 MiB，目的 target 必须预先配置。事件提交不接受顶层 threadId 覆盖。

安装器通过稳定入口注册上述事件检查/投递与任务绑定工具。已有连接需重连后载入新版工具。全新安装的 targets 为空，不复制任何私人脚本、账号或任务。

## 从旧版迁移

旧版 `triggers`、`attention`、`minecraft` 以及 `codex`／`codex-app` target 不再属于 Nerve 配置。启动前会明确拒绝旧字段，避免静默丢弃业务。先备份并迁移生产者状态，将规则和平台账号移入私有脚本，再改为 command/http 目标。切换时停止旧接收者，保留消息 ID、已读区间、定时游标和不确定发送状态；不能把旧 running 业务当成未执行而盲目重放。

安装器保留已有配置，不自动猜测个人业务如何迁移。平台专用的读写 MCP 如仍需使用，由对应私有服务单独提供。
