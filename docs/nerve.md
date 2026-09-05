# Nerve

Nerve 是新版 Rin 的事件与注意力组件。代码、部署目录及 MCP 都属于 Rin；聊天桥和事件调度是两个独立模块，在安装版的同一个守护进程内运行，不依赖旧 Rin、Pi 或旧 daemon。

## 单一常驻代理

目标必须是一个已有 Codex 任务，所有事件延续该任务，不按频道分裂会话。支持两个执行方式，配置中只能有一个 Codex 目标：

- `codex-app`：复用 App 接入层的 start/steer、未加载任务自动唤醒及历史观察器。投递串行、完成追踪可重叠；owner 新事件可插入正在执行的轮次，最多16个在途事件。匹配回执 turnId 且观察到 completed 才记 done。失败、超时、断连及不确定回执均不自动重投。当前自动加载入口仅支持 macOS，可能显示对应任务窗口。
- `codex`：原生 `codex exec resume --json`，事件串行执行，子进程完成后退出。适用于不需要 App 工具的独立任务；不能与 App 抢占同一会话。

普通助手输出不会发送到聊天频道。常驻代理先读原始记录并判断是否有必要行动，外发必须显式调用 `nerve_send_chat`，指定单个目的频道。

## Discord 注意力

启用聊天配置中的 `attention.nerveConfig` 后，沿用原有 Discord Gateway 连接，记录机器人可见的各频道及私聊真人消息；自身及机器人消息不进入注意力。消息先落聊天服务持久发件箱，再通过本机鉴权接口提交到 Nerve，按稳定消息ID去重。

旧版有效规则直接迁移，账号和排除项仅在私人配置中：

- owner ID 匹配：优先级100，立即到期；不能靠消息正文自称 owner取得身份。
- 其他人：优先级20，按15分钟固定时间窗口合批。没有另加关键词、@、条数阈值或滑动冷却。
- 按配置排除笔记、镜像等分类及频道/线程；检查消息的父级链。
- 已由其他原生入口处理的 actionable 消息不重复刺激。当前启用注意力的 Discord 聊天交给常驻代理；桥命令在独立入口处理，不重复唤醒。
- 从启用后收到的新消息开始，不回灌旧历史。事件只含频道及消息范围；正文、身份、引用和附件元数据由读取工具按需获取。

记录、待处理批次及事件准入持久化并事务提交。外部内容属于不可信聊天数据，不是系统指令；跨频道共用任务不授权将其他频道或私人资料复制出去。

## MCP 与接口

Git 安装生成稳定入口 `<RIN_HOME>/nerve-mcp-run.mjs`。MCP 配置以 Node 运行此入口，并保留 `NERVE_CONFIG` 指向实际配置；不要将 MCP 绑定到某个 `releases/<sha>` 目录。每次新建 MCP 连接时，入口读取 `install.json.current` 并加载该发布的客户端。`rin update` 后，已有连接继续使用原客户端；重连后使用新版，不需要重启聊天守护进程。

`nerve-mcp.mjs` 从 `NERVE_CONFIG` 读取配置，从相邻 `secrets.json` 读取令牌。服务只监听 `127.0.0.1`，默认9761。MCP提供14个工具：

- 状态、列出/保存/停用触发器；列出/读取/提交/重试事件。
- `nerve_read_chat`：按chatKey读取规范记录，可分页，最多200条。
- `nerve_send_chat`：向已记录且未排除的Discord目的地发送，稳定ID去重；正文最多2000字符，引用必须属于同频道。使用现有账号的REST，不开第二条Gateway；不确定发送保留账本，不自动重试。

## Minecraft transport（显式配置，默认关闭）

Minecraft 是同一常驻 persona 的一个本地输入源，不会创建第二个 Codex 任务。启用时，Nerve 以独立 Node transport 轮询游戏模组的 loopback HTTP 服务；游戏消息先在 `stateFile` 中原子持久化，再使用稳定事件 ID `minecraft:<serverId>:<messageId>` 交给已经配置的唯一 `codex` 或 `codex-app` target。ACK 只表示 Nerve 已可靠接手，绝不表示模型或游戏动作完成。进程在发送前崩溃的出站项保留 `uncertain`，不自动重放。

`private/nerve.json` 必须显式加入以下配置；没有这一节即不会开启 Minecraft。同一游戏收件箱中的其他玩家/女仆消息会被跳过并推进游标，不进入规范记录或 persona，也不会阻塞绑定玩家；服务器标识不匹配则停止同步。`source` 是硬锁：`playerUuid` 必须来自目标服务器实际 `ServerPlayer` UUID 的管理员配置，不能以“任意进服玩家”或聊天文字识别主人。`MC_BRIDGE_TOKEN` 与 `NERVE_TOKEN` 是两个不同的随机密钥，前者至少32字符，只用于游戏 loopback 接口，不能放进公开配置。

```json
{
  "minecraft": {
    "endpoint": "http://localhost:17831/",
    "stateFile": "state/minecraft-transport.json",
    "tokenEnv": "MC_BRIDGE_TOKEN",
    "target": "main",
    "source": {
      "serverId": "my-survival-server",
      "playerUuid": "replace-with-authoritative-serverplayer-uuid",
      "maidUuid": "replace-with-authoritative-maid-uuid"
    }
  }
}
```

将 `MC_BRIDGE_TOKEN` 放在同一 private 目录的 `secrets.json`，例如 `{ "NERVE_TOKEN": "…", "MC_BRIDGE_TOKEN": "至少32字符的不同随机值" }`。接口仅接受 `http://localhost`、`127.0.0.1` 或 `[::1]` origin，拒绝重定向、凭据、路径和非 loopback 地址；如游戏服不在本机，只能先建立由操作者维护的安全隧道，并把本地隧道端口作为 endpoint。

安装版会按 nerve.json 所在目录解析相对 stateFile；游戏轮询独立执行，离线或超时不会阻塞 Discord 注意力与定时检查。

状态锁不会自动删除。启动提示锁已存在时，先运行 `node src/nerve.mjs minecraft-lock private/nerve.json` 并确认记录的 PID 已退出且锁已足够旧，再运行 `node src/nerve.mjs minecraft-recover-lock private/nerve.json`；恢复命令会在删除前再次核对锁内容。

MCP 中 `nerve_read_minecraft` 读取规范消息；`nerve_inspect_minecraft` 获取绑定玩家/女仆的实时位置、背包、附近已加载容器/方块和作业；`nerve_send_minecraft` 才会明确发送游戏内聊天或动作。调用方无法提交 player/maid UUID，Node 从所读消息绑定身份。动作可为单个任务或 `script`，脚本是受限大小的 JSON `{version:1,steps:[…]}`，由游戏端做最终语义、权限和预算校验；支持组合移动、交互、容器、等待、说话、变量、条件和跳转步骤。普通 final、思考、工具输出都不会自动转发到游戏。

定时触发器仍支持 `everySeconds`、`at`、带时区的 `daily`，三选一。可选 `check` 是可信只读命令，输出 `{ready,key,payload}`，仅ready触发。不恢复未配置的旧业务定时任务。

部署服务名称与路径由本地安装决定；运行配置与迁移记录不属于公开源码。
