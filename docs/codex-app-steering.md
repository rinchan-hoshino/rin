# Codex 共享 app-server 接入

聊天桥和通用事件输入命令连接同一个 Codex app-server。Rin 仅是协议客户端，不创建另一套智能体循环，不管理模型执行进程的 PID、重启或轮次生命周期。

## 连接与启动

macOS/Linux 默认使用 `unix://`，对应 `$CODEX_HOME/app-server-control/app-server-control.sock`；未设置 `CODEX_HOME` 时使用 `~/.codex`。Windows 默认使用 `ws://127.0.0.1:4500`。

启动 Rin 时先连接并完成 app-server 握手，成功后才报告就绪；只有 Nerve 的安装也执行这个检查。只有默认入口明确不存在或拒绝连接时，才在后台直接运行 `codex app-server --listen <endpoint>`，继承用户的 Codex 配置与登录，不指定模型、审批或沙箱参数。启动诊断追加到 `$CODEX_HOME/app-server-control/rin-start.log`。Codex 本身负责监听地址独占；同时启动的其他实例会退出，客户端接入成功占用地址的实例。Rin 停止时只断开自己的客户端连接，已接收的工作继续执行。

`rin restart` 只重启 Rin。需要同时重启共享 app-server 时，在独立终端执行 `rin restart --app-server`；这会中断该服务器上的活动任务。命令先通过握手核对 Codex 主目录，再从系统监听表确认当前用户的确切进程，停止 Rin，正常终止该进程，重新连接成功后启动 Rin。macOS 使用 `netstat`，Linux 使用 `ss`，Windows 使用 PowerShell 的 TCP 监听信息；不保存 PID 记录、不按名称批量结束进程，也不强制杀死停止超时的服务器。无法确认目标、目标发生变化或命令正在目标 app-server 内执行时，拒绝停止。该选项只处理默认本机入口，自定义服务由其宿主管理。

可通过 `codex.command` 选择可执行命令，通过 `codex.endpoint` 选择一个已存在的同机入口。自定义入口失败不会自动另起服务；连接或输入回执不确定时不会换路径重投。聊天输出观察要求服务与 Rin 共享同一台主机及同一 `CODEX_HOME`。旧 `appSteering` / `appWake` 配置不再参与选择路径，可以移除。

这里不使用 `codex app-server daemon start`：该命令在当前版本要求官方 standalone 安装，不能假设 npm 安装也满足。直接 `app-server --listen` 已用本机 npm Codex 0.153.4 验证。Windows 的默认 TCP 入口需要在 Windows 实机另外验收。

## 输入与原生行为

- `initialize` 后只调用官方 app-server 协议。
- 通过 `thread/resume` 加载已有任务或加入已运行任务，不覆盖其模型、cwd、沙箱、审批、推理强度或指令。
- 通过 `turn/start` 提交；由服务端原子地开始新轮次或追加到当前轮次，避免客户端读取忙闲状态后的竞态。
- 文本原样提供，本地图片使用 `localImage`；其他附件继续提供明确的本地文件路径。
- 提交前持久记录客户端消息 ID。只有收到 turn ID 才报告已接收；超时、丢失连接或缺少回执不自动重投。
- 自动绑定新任务也使用同一个服务。仅提供明确配置的 cwd/model/name，并保留原有防止重复外发的路由指令；不开始额外模型轮次。
- Rin 不代替用户回答原生审批或动态工具请求。需要交互时由连接同一任务的 App/TUI 处理；自定义客户端工具仍需其实际提供方在线。

Nerve 只记录目标是否接收，不等待模型完成；聊天桥自行管理持久收件箱和输出投递。

## 公开输出

为了保留重启续传、消息关联、编辑和附件去重，本次保留原有只读输出观察器，锁定 Codex 0.153.x / paginated 历史结构。只读取公开文字、公开摘要、用户消息关联及完成的生成图片路径，不转发工具输出、原始推理或图片内部提示词。该观察器不决定模型如何执行，也不写 Codex 数据库。协议客户端和投递观察可以独立演进。

## App 与 TUI

**App 可以操作这些服务：通过 Settings → Connections 添加同一主机的 SSH 连接，打开该主机的项目/任务。** 官方远程 App 本身就通过该默认 Unix 入口运行；Rin 复用它时不会另建一份任务运行实例。这里不要求同机桌面 App 的默认本地 stdio 服务自动合并。

```sh
# macOS/Linux：选择或进入共享服务上的任务
codex resume --remote unix:// --all
codex resume --remote unix:// TASK_UUID

# Windows 默认入口，或已配置的本机 TCP 服务
codex resume --remote ws://127.0.0.1:4500 --all
```

App 的 SSH 模式与同机桌面模式可能有宿主工具差异；复用远程服务不会额外创建一个简化的智能体。Rin 提交时不冒充 App 客户端，也不复制 App 私有运行环境。

## 验证边界

本机 0.153.4 已验证：默认 Unix 共享连接、第二个原生服务拒绝抢占、无服务时启动与客户端断开后再次接入、聊天和 Nerve 命令真实轮次完成、触发器进程退出后原生 shell 工具继续执行、运行中输入追加到同一 turn、TUI 列出任务。另已用隔离的真实服务验证 macOS 监听进程识别、正常停止、重新启动与再次握手；Linux 和 Windows 重启分支仍需实机验收。平台 SDK 收发、编辑、附件及持久输出语义由回归测试覆盖；本次未把无真实入站消息窗口的 QQ 平台测试写成端到端验收。

官方参考：[app-server](https://learn.chatgpt.com/docs/app-server)、[SSH 连接](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host)。
