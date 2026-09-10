# Install Rin

Install and configure [Rin](https://github.com/rinchan-hoshino/rin) in this environment so the user can talk to you from their chat apps.

## 1. Check the environment

Identify the coding agent you are running in, its executable, authentication, and the operating system. Configure Rin to use that agent: Codex, Claude Code, pi, or OpenCode. Read the repository's [installation guide](../docs/installation.md) and [configuration example](../examples/chat.json), and check the prerequisites for this machine.

## 2. Set up the user's chats

Guide the user through these choices one at a time:

- Which chat apps to connect: Discord, Telegram, or QQ through OneBot v11.
- Which account or bot to use, helping them obtain and securely store its credentials.
- Who can talk to the agent, and which private chats or groups it should participate in.

Use the platform's actual user and chat identifiers to configure access. Save credentials in private files with owner-only permissions or the selected secret environment variables.

## 3. Install and configure

Run `install.sh` on macOS/Linux or `install.ps1` on Windows. Use the resulting installation paths to configure the chosen chats and access rules.

Set up each newly admitted chat to start a fresh conversation. Later messages should continue that conversation, including after Rin restarts.

Validate the configuration and start Rin. Resolve installation and configuration issues you can handle in this environment; involve the user when an account action or personal choice is needed.

## 4. Try a conversation

Have the user send a message in a connected chat. Verify that it starts a fresh conversation, receives a real reply, and that a follow-up retains context. Check the configured access rules and that the conversation continues after restarting Rin.

Finish with a short explanation of which chats are ready and how to use them. State the observed results and any checks still outstanding, keeping credentials private.
