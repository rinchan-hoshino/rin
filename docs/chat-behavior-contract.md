# 聊天桥行为契约审计

核对日期：2026-09-07。本文是旧 Pi 版 release
`f370ddf80f515642513dec650bd0a0cc577d1ffe` 与其配套扩展
`3c3b14b3061c268b661cb14bf7735b5a0a5d418a` 的只读行为审计；旧运行时、旧身份库和
旧账号均不是新版依赖。结论只以旧源码和旧测试为基线，再逐项检查当前源码入口。

状态含义：**保留**表示当前实现和定向测试已覆盖可见契约；**遗漏**表示旧行为有可移植
实现证据而当前入口没有；**边界**表示已有证据显示 Codex 或平台 API 使旧机制不能原样成立；
**缩减**只在能追溯到原始用户指令、且该指令明确排除能力时使用。当前架构、实现缺口或测试
范围本身不是授权缩减的证据。替身测试不等于平台端到端验收。

## 输入与准入

| 契约 | 旧版证据 | 当前状态与入口 | 最小处理和验证 |
| --- | --- | --- | --- |
| 身份、私聊/群聊、机器人提及先于下载和执行 | `inbound-normalization.ts` 的 `directLike`、`mentionLike`、`buildChatInboxRouting`；`main.ts` 的 admission；旧扩展 `onebot-platform.ts` 的 `buildSession` | **当前差异，部分保留**。`policy.ts` 以 `allowUsers`、`dmOnly`、`requireMention` 判定；适配器在附件下载前调用 binding/admission。旧人物别名、信任层级和“主人在场”证明尚未迁入。显式白名单是当前实现，现有材料不能证明它是用户授权的能力缩减。 | 针对每适配器验证“拒绝者不下载、不入库、不执行”；另行把旧身份语义映射为可审计的新准入模型。 |
| 主人与机器人独处的群视同私聊 | 旧 `decision.ts:76-104,178-208,211-218,244-272` 要求 OWNER、完整成员证明，仅缓存否定结果；旧 Discord 未实现该证明接口 | **已恢复（Telegram、OneBot）**。显式 `ownerUsers` 与准入 `allowUsers` 分离；完整证明后放开提及门槛及私聊命令呈现，平台类型仍为 group。正结果每条重验，否定缓存十分钟。 | 不将白名单自动升级为主人；未配置主人或证明不完整时不放开。Discord 延续旧版未支持此证明的范围。 |
| 文本、@、富节点和附件的规范化 | `inbound-normalization.ts:36-160,273-343` 从节点渲染 Markdown，移除对本机器人提及，保留其他 @ 与富附件摘要 | **部分保留**。Discord/Telegram 去除本机器人提及；各适配器传纯文字和本地附件给 `ChatMessage`。新类型 `types.ts:3` 不再表达其他 @、贴纸、表情或富节点。 | 若 Codex 需要识别“@谁”或非可下载媒体，增加平台无关的 input part，而非回迁旧节点运行时；测试同一条 mixed-content 输入的可见提示词。 |
| 回复/引用既保留关系也给模型足够上下文 | `inbound-normalization.ts:202-220,295-343` 把 quote 写入规范元素和消息库；`chat-main-queue.test.ts:3209-3830` 覆盖 rich quote、引用本人/他人、引用 assistant 与不错误续接其 session | **部分保留（定向测试）**。`ReplyContext` 明确标记 quoted context；Telegram 使用可信 native reply，`ChatStore` 记录新入站索引，兼容旧 inbox ID，并从已发送 delivery 恢复 assistant 正文/附件。缺内容保留 ID/不可取，不把引用当作授权或新的消息正文。 | `chat-input-normalization.test.mjs` 覆盖上下文边界、缺正文、旧库 inbound 和 assistant delivery；尚无五个平台端到端验收。 |
| Telegram 编辑更新进入同一规范/去重流程 | `platform/telegram.ts:460-475` 请求 `edited_message` 和 `edited_channel_post`，:725+ 与 `main.ts:395-396` 按普通消息规范化；消息库更新路径在 `chat-helpers.ts` | **部分保留（定向测试）**。poll 请求 `edited_message`/`edited_channel_post`；未提交项目可替换。旧 `inbox.ts:453-460` 也只更新 pending 且 unclassified 项；已接受项目不重投，晚编辑仅刷新未来引用索引。 | `chat-input-normalization.test.mjs` 覆盖已接受后的索引更新；仍需 Telegram 实机验证编辑时序与重启。 |
| Telegram forum/topic 是独立对话键 | 旧 `inbound-normalization.ts:242-249,323-329` 保存 thread ID；`chat-main-queue.test.ts:547` 明确 topic command 使用 thread-scoped chat key | **部分保留（定向测试）**。`topicId` 是独立字段，进入 binding、route、inbox、输出 target 和 Telegram `message_thread_id`；无 topic 保留旧二元持久键，避免升级时重放。 | `chat-input-normalization.test.mjs` 覆盖 topic 不相等；仍需两 topic 交错、重启和真实 Telegram 发送验收。 |
| OneBot reply 与合并转发 | 旧扩展 `onebot-platform.ts:1152-1208` 调 `get_forward_msg` 并渲染作者/内容，:1295-1303 写入 canonical reply/forward 节点 | **部分保留（定向测试待补）**。allowUsers、policy 和 binding 通过后才调用 `get_forward_msg`；只接受同群可核验节点，限制深度、条数和字节，失败保留可见占位。 | 仍需 normal/failure/over-limit/reconnect 定向测试和真实 OneBot 接入。 |
| OneBot 音频、语音、视频、贴纸入站 | 旧扩展 `onebot-platform.ts:1262-1293` 将 record/voice→audio，并保留 video、sticker、face/mface | **部分保留（定向测试待补）**。image/file/video/record/audio/voice/sticker/face/mface 保留为附件或带能力限制的可见文本占位；下载仍有 20 MiB、超时和无凭证 URL 限制。 | 仍需混合顺序、20 MiB 拒绝及真实网关验收。 |
| 事件重复、入站游标、崩溃后恢复 | 旧 `inbox.ts`/`durable-admission.ts` 持久 claim；`chat-main-queue.test.ts:18,1868,2531-3049` 覆盖 once、重启、硬死、未验证 admission 与 terminal ownership | **大体保留，语义改变**。`store.ts:33-45` 用 `(adapter,chat,id)` durable admission；Telegram offset 在处理每个 update 后写 cursor；OneBot websocket 依赖 message ID 去重。`store.ts:11-23` 启动时把 submitting/sending 置 uncertain。 | 保持“不自动重放不确定提交/发送”。增加 adapter-level crash/reconnect suite：Telegram offset 仅在 durable admission 后推进、OneBot 重连重复、附件下载失败、DB 重开。 |

## 命令

| 契约 | 旧版证据 | 当前状态与入口 | 最小处理和验证 |
| --- | --- | --- | --- |
| 斜杠文本绝不落为普通 prompt；机器人后缀、未知命令、`/session` | `main.ts`、`decision.ts`、`support.ts`；`chat-main-queue.test.ts:1338-1795,4027` | **保留**。`commands.ts:9-24` 先解析所有 `/`；`bridge.ts:209-260` 静默 `/session`、未知私聊引用帮助、群聊静默、其他机器人后缀不执行。 | 已有 `chat-commands.test.mjs`。端到端验证各平台的文字命令与原生命令菜单不互相绕过。 |
| 已注册命令在群中不需 @，但仍先验身份 | 旧 `chat-main-queue.test.ts:1435-1646` | **保留（新身份模型）**。`policy.ts:39-50` 对 command 绕过普通群提及；`bridge.ts:215-246` 先 claim 再执行。 | 验证每个适配器群裸命令、@本机、@其他机器人、未授权者。 |
| native 菜单与文字命令同一注册目录 | 旧 `builtin-command-registry.test.ts`、`extension-command-adapter-owner.test.ts` | **部分保留/待映射**。新 `commands.ts` 和 `command-extensions.ts` 统一当前 `/help`、`/usage` 与私有目录扩展；旧动态目录的完整 catalog、身份类命令没有迁入。当前目录模型不构成用户授权放弃旧能力的证据。 | 测试启动后菜单回读、热更新必须 restart、菜单失败不阻塞收消息；为未映射旧命令逐项决定保留、替代或移除依据。 |
| `privateOnly` | 旧 command decision 在群拒绝/私聊可用 | **保留**。`bridge.ts:223` 返回“请在私聊中使用此命令”；`commands.ts:29-32` 群帮助隐藏。 | 追加扩展命令在群、私聊、重放中的一次性测试。 |

## 输出、工作状态与错误

| 契约 | 旧版证据 | 当前状态与入口 | 最小处理和验证 |
| --- | --- | --- | --- |
| Markdown/HTML 回退、等待头、三段进度、Unicode 分块 | `rich-text.ts`、`platform/common.ts`、`delivery-policy.ts`；旧呈现比对见 `legacy-render-audit.md` | **保留**。`presentation.ts`、`working.ts` 和 `chat-presentation.test.mjs` 直接覆盖旧纯函数可见结果。 | Telegram 只在确定 entity parser 拒绝时 plain fallback；对超时或网络失败保持不重发。 |
| typing、可编辑 progress、问题与 final 的清理顺序 | 旧 `working-indicator-policy.ts`、`editable-text-message-group.ts`、`terminal-delivery.ts` | **大体保留**。`bridge.ts:349-402,416-500` 为可编辑平台维护 progress/questions/final；`typing()` 按能力轮询。 | `chat-bridge.test.mjs` 已覆盖 questions/restart/final。仍需真实 Discord/Telegram 断网、消息删除、编辑权限失效验证。 |
| 无编辑平台的完整快照、首条引用、媒体与文字原始顺序 | 旧 `delivery-presentation.ts`、`platform/common.ts`；扩展 `lark-platform.ts:1407-1494` | **保留（当前适配器范围）**。`bridge.ts:416-500` 按 output parts staging；`files.ts` 维持文字/媒体顺序；`chat-bridge.test.mjs:360-455` 覆盖 QQ/OneBot快照、引用冻结、重启。 | 实机验证各平台分块限制及被动回复窗口。 |
| final/error/取消只投递一次，且不把不确定远端发送重试成重复消息 | 旧 `outbox.ts`、`terminal-reconciler.ts`；`chat-main-queue.test.ts:2021,2928-3049` | **保留，且更保守**。`store.ts:50-83` 将重启中 sending 设 uncertain；`bridge.ts` 只对明确媒体拒绝进行 fallback；Codex submit catch 也写 uncertain。 | `chat-bridge.test.mjs` 覆盖媒体与提交不确定。补平台 HTTP timeout 后“服务端已收但客户端未回”的人工验收。 |
| App active turn 的 steer 展示归属 | 旧 `controller.ts` 的 pending→accepted adoption、delivery context 与 terminal ownership；`chat-controller.test.ts` 的 settling terminal 场景 | **新增实现，定向测试已验证**。App IPC receipt 的 `messageId` 与只读投影 `userMessage.clientId` 匹配后，以不可变 `rollout_ordinal` 建立展示边界；同一 physical `turnId` 的旧 item 保留旧引用，边界后的 item 使用新引用。`tests/chat-bridge.test.mjs` 覆盖 Discord、QQ 的同 turn/restart，`tests/chat-codex.test.mjs` 覆盖真实 SQLite 投影序号。 | 尚无真实 App→上述平台往返验收；native `codex queue` 只有排队回执，不能视为 steer accepted，也没有同 physical turn 的同等归属保证。 |
| 旧平台 reaction working indicator | 旧 `working-indicator-policy.ts` 选择 typing + 单一最高优先可见 indicator | **已恢复**。通用 adapter lifecycle 会保存 reaction handle；OneBot 使用其群聊 emoji endpoint。 | 仍须用真实平台权限验证 reaction 创建与撤销。 |
| todo/压缩/内部工具输出 | 旧 `delivery-presentation.ts`、`terminal-delivery.ts` 有 frontend-specific 结构 | **当前投影边界/待映射**。`codex.ts` 当前只读取 public agent、reasoning summary 和生成图片；工具输出和私有推理不外发。这说明当前实现的可见范围，不能单凭未实现认定为授权缩减或永久 API 限制。 | 保留公开 summary 和 questions；不要伪造旧 todo。若获得稳定公开 todo 字段或明确产品决定，再新增独立映射和验收。 |
| 图片和一般附件 | 旧平台按节点顺序发送；旧扩展分别处理 OneBot/Lark 上传 | **部分保留**。`files.ts` 只允许本地根目录真实文件；`bridge.ts:332-347` 仅转发当前 task 已完成生成图；Telegram/Discord/QQ/OneBot各有发送分支。 | 当前 20 MiB 上限及仅本地可达文件是安全边界。验证图片、音频、视频、普通文件、首条引用和显式拒绝后的 fallback；不以成功上传回执代替用户端可见验收。 |

## 生命周期、绑定与恢复

| 契约 | 旧版证据 | 当前状态与入口 | 最小处理和验证 |
| --- | --- | --- | --- |
| 先启动 transports，再恢复可执行 inbox | `chat-main-queue.test.ts:723`；旧 boot/main ownership tests | **保留**。`bridge.ts:109-145` 先建 adapters、watch、start adapters，才开启 timer/submit。 | 启动时注入 pending inbox，断言没有早于 adapter ready 的外发或 Codex submit。 |
| 正常 stop、硬死、积压、claim lease | 旧 `chat-main-queue.test.ts:2531-3049`，`inbox.ts` durable coordination | **部分保留**。`bridge.ts:570-580` 停接收、停 adapters/Codex、最多等待 15 秒；`store.ts` 用 uncertain 而不是 reclaim/retry active jobs。 | 这是安全优先的差异：积压 pending 会继续，已经 submitting/sending 必须人工 reconciliation。状态命令/文档需能列出 uncertain，测试 SIGTERM 中点与 restart。 |
| Codex terminal 可靠投影和 observer 恢复 | 旧 `terminal-reconciler.ts` 能为未确认 terminal 创建 detached controller；旧 terminal ownership tests | **边界/部分保留**。`codex.ts` 保存 high-water 与 active turns，重启续读；schema/version 不兼容时 `bridge.ts:319` 停观察并把 thread faulted。没有旧 Pi detached terminal reconciler 的等价物。 | Codex 只读历史投影无法证明遗漏的 terminal；保持停止外发比猜测 terminal 安全。提供可见 faulted/uncertain 状态并用 App 更新、DB busy、daemon crash 验证。 |
| 平台重连 | 旧 Discord/Telegram owner tests；OneBot 扩展默认指数/上限重连，Lark recovery | **部分保留**。Telegram poll 出错后 1 秒循环；OneBot close 后固定重连；Discord SDK 管理 reconnect。 | OneBot 固定间隔可接受但应加连续失败退避/stop fence；真实网络断开再恢复应验证无重复与 cursor 连续。 |
| 一任务多聊天镜像、多绑定 | 旧架构以 chat key/controller/frontend binding 为中心，`terminal-reconciler.ts` 有 detached frontend projection；这不足以证明旧版曾承诺公开的多聊天镜像 | **当前实现差异**。`policy.ts` 禁止同一 Codex thread 多个 binding；`bridge.ts` 的 presentation state 仍按 route 存储，技术上可演进，但 validate 直接拒绝。 | 不是平台 API 限制，也没有足够旧证据可把 detached projection外推为必须复刻的用户功能。若需要镜像，先定义每路独立 reply context、delivery ledger、发送不确定和退订语义，再放开 validation；测试两个 chat 同时输入、一个发送失败、重启和解绑。 |
| 首条消息自动建任务 | 当前产品新增能力，无旧 Pi 对等基准 | **保留为新版行为**。`bridge.ts:171-203` 持久 creating/bound/uncertain，创建不确定时不自动再建。 | `chat-auto-bind.test.mjs` 覆盖。实机验证 create 成功但响应丢失、重启后不重复建 task。 |

## 本轮交付与剩余范围

本轮已恢复引用上下文、Telegram topic/edit、OneBot 转发与混合媒体、视同私聊、工作表情和 App steer 展示归属。新增定向回归覆盖回执/输入/终止乱序、旧终止不清新状态、历史数据库键兼容及恢复 FIFO。

剩余范围须单独确认：旧人物身份及信任关系迁入、旧动态命令目录、公开 todo 投影与多聊天镜像。当前未实现不是用户授权取消的证据。native queue 不具备 App IPC 的同等 steer 接受关联。真实平台端到端验证仍未完成。

## 最小验收矩阵

- 每适配器：未授权/未提及消息不下载；同一事件重放只产生一个 durable admission；附件下载失败不推进可导致丢失的 cursor。
- 引用：接收原消息后重启，再引用；引用本方、他方和 assistant；正文、图片和未知引用均有稳定且不泄密的 prompt 表示。
- Telegram：普通消息、edited message、topic A/B 交错、长轮询断线后 offset 恢复。
- OneBot：reply、forward 正常/失败/超限，image/file/audio/video/voice/sticker 混合顺序，socket close 后重复 event。
- 输出：progress→question→commentary→final、失败、远端 edit 删除、发送超时、媒体格式拒绝、daemon stop 位于 submit/send 中点。
- 生命周期：未加载 App task、daemon restart、Codex schema 不兼容、observer busy、两条 binding 路由（如未来支持）和自动建任务响应不确定。
