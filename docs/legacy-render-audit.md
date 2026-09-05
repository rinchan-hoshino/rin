# 旧 Rin 呈现行为核对

核对日期：2026-09-05。基准为旧部署 release `f370ddf80f51`，不是对照新实现自写期望。

## 来源与范围

已取得主仓库 `rinchan-hoshino/rin` 的原始 TypeScript，私有审计副本在 `private/legacy-source`。将 `src/core/chat/rich-text.ts`、`platform/common.ts`、`delivery-policy.ts` 和 `LICENSE` 与 `git show f370ddf80f51:<path>` 逐字节比较，全部相等。完整 commit 为 `f370ddf80f515642513dec650bd0a0cc577d1ffe`。原仓库 LICENSE 为 GNU GPL v3，副本保留原许可。旧部署 JS 的纯函数也已与新版执行比较。

新 `src/chat/presentation.mjs` 从下面纯函数直接剥离，运行时不读取旧安装，也不携带 Pi、节点协议或私人配置：

| 旧部署 JS 相对源码 | 函数或位置 | 新版用途 |
| --- | --- | --- |
| `rich-text.js:71` | `stripHtmlFormatting` | Telegram HTML 失败后普通文本回退 |
| `rich-text.js:85` | `stripMarkdownFormatting` | 保留旧 plain 回退行为 |
| `rich-text.js:102` | `normalizeRenderedText` | 换行、空白归一化 |
| `rich-text.js:392` | HTML 转义、清理辅助函数 | Telegram 转换 |
| `rich-text.js:423` | `markdownToTelegramHtml` | Codex 原生 Markdown 转 Telegram HTML |
| `platform/common.js:64` | `editableIntermediateHeadText` | `... ` 前缀 |
| `platform/common.js:162` | `composeEditableMessageText` | working/content/todo 三段合成 |
| `platform/common.js:171` | `updateEditableMessageSections` | 各段替换与保留语义 |
| `platform/common.js:208` | `splitPlainText` | 旧分块语义 |

对应 TypeScript：`src/core/chat/rich-text.ts:90`（HTML 清理）、`:103`（Markdown 清理）、`:124`（归一化）、`:511`（Telegram 转换）；`src/core/chat/platform/common.ts:111`（前缀）、`:245`（合成）、`:255`（更新）、`:305`（分块）；`src/core/chat/delivery-policy.ts:40`（摘要归一化）。摘要只取最后一个非空段落，去除 Markdown 格式后压成单行。

Codex 输入直接是 Markdown。旧节点协议、节点标签解析、系统提示词注入均不移植。`prepareText` 是新版薄入口，将 Discord Markdown 或 Telegram HTML 分块并产生发送 payload。

## 精确可见行为

- 默认等待头为 `... Working...`，不是 Markdown 引用块、粗体标题、颜色或 embed。
- 有工作状态或摘要时，头部为 `... {状态或摘要}`；已有 `... ` 不重复加前缀。工作状态在旧 indicator 中优先于摘要。
- 工作区、正文区、可选 todo 区依次排列，非空区之间为 `\n\n────────\n\n`。更新其中一个区保留另外两个区；`exclusive` 只留正文。普通中途正文不加 `...` 前缀。
- Discord 用 `content` 原生 Markdown；Telegram 将 Markdown 转成 HTML，使用 `parse_mode=HTML`。代码、粗斜体、标题、链接、删除线和引用在 Telegram 转为相应标签。
- `EditableTextMessageGroup` 按槽串行编辑原消息。多块增长增加消息，缩短删除多余消息；消息已不存在或不可编辑时重新发送，清理剩余旧块。相同内容不重复编辑。
- 正式回复先清除进度消息，再新发最终回复。finalizing 状态避免迟到进度重新出现。
- Discord 首个文本或附件携带引用，其余通常不重复引用；Telegram 同样维护 `firstReply`。正文与媒体按原始节点顺序分组发送，不能简单视为所有文字后附所有媒体。
- 两个平台支持 typing。旧 Discord 注册过 `🤔` reaction indicator，但是否使用由 working-indicator policy 选择，不应仅因注册了接口就声称三种状态同时出现。

## 明确保留的旧限制

Telegram `telegram.js:704` 直接对 HTML 字符串调用 `splitPlainText(...,4096)`，并不是识别标签边界的 HTML 分块器；HTML 解析失败后回退普通文本。Discord 分块为 2000。旧分块器按 Unicode code point 和段落/换行/空格断点切分，不会补全跨块 Markdown 代码围栏。

旧 Markdown 链接中的查询参数 `&` 会被后续 HTML 清理再次转义成 `&amp;amp;`。此次纯函数剥离先保留该可观测行为，测试将其明确记录；纠正它应作为独立、有测试的兼容性修复。

旧 Telegram 的 HTML 异常回退对所有发送异常都可能重试。这部分不应机械复制网络错误后的重发：只有确认是格式拒绝且消息未送达时才允许普通文本回退，避免超时后重复发送。

## 验证

`tests/chat-presentation.test.mjs` 用固定样例核对等待前缀、三段分隔及替换、Discord 原生 Markdown、Telegram HTML、代码保护、纯文本回退、空白和分块。它们是源码行为的定向测试，不代表平台账号端到端验收。

另用本机旧 release 直接导出的纯函数与新模块，对八组 Markdown/空白/Unicode 样例执行 72 次同输入比较，结果一致。该一次性核对没有写入生产依赖或常规测试路径。

## Codex 原生附件顺序

`src/chat/files.mjs` 的 `outputParts` 将实际可发送的本地 Markdown 图片/附件链接替换为媒体 part，前后的文字保持原顺序。`outputFiles` 仍提供兼容的去重文件列表。使用旧 `collectMarkdownProtectedRanges` 系列函数及相同版本 marked 的 token 信息；代码围栏、缩进代码、行内代码中的示例链接保留为文字。新版额外识别原生普通 artifact link，并处理 Markdown 自带的空格路径、标题和配对括号，不恢复旧富文本标签。

仅允许配置输出根下的真实普通文件，realpath 后再次检查根边界，拒绝符号链接越界及超过 20 MiB 的文件；没有远程下载能力。`tests/chat-files.test.mjs` 四项验证顺序、代码保护、文件边界和媒体 MIME。

## 其余平台修正（2026-09-05）

另外读取旧扩展仓库 `rinchan-hoshino/rin-extensions` 的 `extensions/lark-platform.ts` 和 `extensions/onebot-platform.ts`（本机 HEAD `3c3b14b`），并核对私人旧开发原文。飞书此前虽实现 edit API，却被共享进度逻辑的平台名白名单排除；QQ/OneBot则把没有 `done` 标记的完整公开快照误作增量缓冲。

- 编辑布局现按适配器 `capabilities.edit` 选择。飞书共享静态 Working、最新纯文本摘要、分隔符、quote 分槽、错误保留进度与 final 清理，不再只覆盖 Discord/Telegram。
- 飞书旧实现发送 `post`，新版此前错误地发送普通 `text`。已将旧纯 Markdown→post 函数直接剥离到 `src/chat/feishu-presentation.mjs`，保留行内样式、链接、代码块、列表 Markdown 和空行，send/edit 使用同一转换；媒体首条也能回复原消息。
- QQ/OneBot 不支持 edit。完整公开快照立即发送，非 final 以 `... ` 开头，Markdown 用旧纯文本规则降级。相同 item+内容跨重启去重，快照改写用独立新消息，不拿远端消息 ID 调不存在的 edit；真正 delta 仍等完整边界。正文、媒体、正文保持顺序，引用归属冻结至本轮。
- OneBot 媒体恢复旧扩展的 `image`/`record`/`video` 类型和 `base64://` 上传，避免把 Rin 本机路径交给另一台网关。普通文件使用旧 `upload_private_file`/`upload_group_file` 扩展；这不是所有 v11 实现保证支持的接口，且无法携带 reply segment。失败不会盲目另发回退消息。

定向行为矩阵与适配器测试 29 项通过，全部聊天桥测试 63 项通过。新增覆盖包括飞书进度/重启/错误保留、QQ与OneBot完整中途快照及时交付和去重、纯文本与媒体顺序、飞书真实 SDK 请求格式、OneBot 音视频/普通文件请求。它们是替身测试；本轮未启用飞书或 OneBot 实际账号，不代表平台端到端验证。
