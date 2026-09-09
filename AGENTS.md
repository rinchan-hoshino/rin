# Rin

本仓库是轻量、agent-neutral 的 Rin 公开核心。

开始运行时、聊天桥或安装工作前先读 `docs/next-rin.md`。

- 核心只依赖最小 AgentBridge 端口。Codex、Claude Code、pi 与 OpenCode 通过各自 adapter 接入。
- daemon 只管理 Rin 自身资源，不启动、停止、重启或监督 agent server。
- Nerve 只提供 durable queue 与 command/HTTP receipt，不经 ChatBridge 执行，也不创建 agent 会话。
- Discord、Telegram 与 OneBot v11 分开配置与验收。QQ 只保留 OneBot，不绑定特定网关软件；不恢复 QQ 官方 Bot API。
- 用户身份、chat 黑白名单、人格、密钥与真实部署配置留在忽略的 private 目录，不进入公开代码。
- 公开安装方式是 agent 安装完成后的分步提示词；不要恢复标准安装器、产品下载、全局配置优化或旧 Rin 切换逻辑。
- 不把协议测试、fixture 或 mock 写成真实 agent/平台端到端验收。无法使用真实 CLI 时明确标记未验收。
- 不读取旧 `~/.rin` 作为运行配置；只有明确迁移任务可把指定内容当只读证据。
- 源码改动不等于部署。验证、提交、推送和 `rin update` 是分开的动作。
