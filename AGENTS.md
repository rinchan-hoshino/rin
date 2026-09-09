# Rin

本仓库是轻量、agent-neutral 的 Rin 公开核心。

开始运行、开发聊天桥或调整安装流程前先读 `docs/next-rin.md`。

- 核心依赖最小 `AgentBridge` 端口。Codex、Claude Code、pi 与 OpenCode 通过各自 adapter 接入。
- daemon 管理 Rin 自身资源；agent session 由对应 agent 管理。
- Nerve 提供 durable queue 与 command/HTTP receipt，不经 ChatBridge 执行，也不创建 agent 会话。
- Discord、Telegram 与 OneBot v11 分开配置与验收。QQ 通过 OneBot 接入。
- 用户身份、chat 黑白名单、人格、密钥与真实部署配置留在私有目录，不进入公开代码。
- 公开安装方式是 agent 已安装并认证后的分步提示词。
- 不把协议测试、fixture 或 mock 写成真实 agent/平台端到端验收；无法使用真实 CLI 时明确标记未验收。
- 源码改动、验证、提交、推送和实际部署是分开的动作。
