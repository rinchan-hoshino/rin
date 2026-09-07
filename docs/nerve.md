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

`command` 用 argv 数组启动程序，向 stdin 写入 `{id,payload}`，不经过 shell。普通命令成功退出即表示投递完成；设置 `receipt: true` 时，stdout 必须是 `{accepted:true,...}`。明确未接收的程序可返回 `{accepted:false,retryable:true,error:"..."}`，此时才允许自动重试。命令超时、异常退出或无有效回执默认保留为 `uncertain`。

`http` 目标向固定 `url` POST 事件 payload，并带 `Idempotency-Key` 事件 ID；可用 `tokenEnv` 指定目的服务的 Bearer token 环境变量。HTTP 成功状态表示目的端接收成功。只有目的端保证幂等时才设置 `idempotent: true`，让失败按有界退避重试。`maxAttempts` 默认 3。

同一目标的投递串行，不同目标轮转取件，最多 16 个并发投递。进程意外停止时，原先的 `running` 记录变为 `uncertain`，避免重放可能已产生副作用的操作。

**`done` 只代表目的端的接收回执，不代表模型轮次或业务任务完成。** Nerve 不创建、运行、观察或恢复 Codex 任务。

## 用户脚本目录

配置 `scriptsDirectory` 后，服务启动目录顶层的每个 `.mjs` 文件，并在退出后按 2–60 秒退避重启。脚本继承环境，并获得本机 `NERVE_ENDPOINT`、`NERVE_TOKEN`。服务关闭时先通知脚本退出，最多等待 20 秒后终止。

脚本可自行使用官方平台 SDK、定时库或其他事件源。定时游标、平台消息记录和输出工具由脚本自己维护；同一平台账号只应有一个接收者。Nerve 不依赖这些脚本的业务结构。

`dist/nerve-emit.js` 导出 `emitEvent({id,target,payload,source?})`，使用上述环境变量提交事件并核对队列回执；直接运行时从 stdin 读取同样的 JSON。使用稳定事件 ID：同一 ID、目标和 payload 的重投返回已有记录；同一 ID 携带不同内容会被拒绝。

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

## HTTP 与 MCP

所有 HTTP 接口绑定 loopback，必须使用至少 24 字符随机 `NERVE_TOKEN`。`GET /health`、`GET /events`、`GET /events/:id` 用于检查；`POST /events` 提交 `{id,target,payload,source?}`；`POST /events/:id/retry` 显式重试 failed/uncertain 记录。输入上限 1 MiB，目的 target 必须预先配置。

安装器通过稳定入口注册五个 MCP 工具：`nerve_status`、`nerve_list_events`、`nerve_get_event`、`nerve_enqueue_event`、`nerve_retry_event`。已有连接需重连后载入新版工具。全新安装的 targets 为空，不复制任何私人脚本、账号或任务。

## 从旧版迁移

旧版 `triggers`、`attention`、`minecraft` 以及 `codex`／`codex-app` target 不再属于 Nerve 配置。启动前会明确拒绝旧字段，避免静默丢弃业务。先备份并迁移生产者状态，将规则和平台账号移入私有脚本，再改为 command/http 目标。切换时停止旧接收者，保留消息 ID、已读区间、定时游标和不确定发送状态；不能把旧 running 业务当成未执行而盲目重放。

安装器保留已有配置，不自动猜测个人业务如何迁移。平台专用的读写 MCP 如仍需使用，由对应私有服务单独提供。
