# Minecraft Nerve integration

Minecraft can feed canonical player messages into the existing persona task and receive explicit chat replies or bounded maid scripts. The transport is disabled until configured. Ordinary assistant output is never relayed to the game.

## Behavior

- A dedicated loopback bearer token and configured server/player/maid identities bind the source. Canonical records are checked again against the current source lock when read or handed off, including after a configuration change.
- Other player or maid messages from the same server are skipped without canonical storage or persona handoff, so they cannot block the bound player. A mismatched server identity still stops synchronization.
- Inbox pages are persisted before persona handoff and acknowledged afterward. Stable IDs deduplicate events. Uncertain outgoing requests remain recorded and are not replayed automatically.
- The combined daemon initializes the transport, resolves relative state paths from its configuration directory, and closes its durable state lock during shutdown.
- Game polling runs independently. A slow or unavailable game server cannot delay Discord attention scanning or scheduled work.
- MCP supports canonical read, explicit chat/task send, job status, and live world/inventory inspection. The game remains responsible for action semantics, permissions, physical execution, and script budgets.

## Validation

The full Node suite passed 286 tests, including transport source locking, persistence, stable outbound replay, MCP routes, combined-daemon initialization, state-lock cleanup, and isolation from an unavailable game server.

An isolated headless NeoForge fixture exercised the actual Java HTTP server through Nerve and its MCP handler: prefixed game-chat ingestion, canonical read, inspection, explicit chat, a physical withdraw/place/deposit script, completed-job polling, inventory and block-state conservation, stable outbound replay, and duplicate inbox acknowledgement polling all passed. The fixture used an explicitly named test FakePlayer and did not execute a real persona task or touch a production game world.

Client rendering and interaction acceptance is separate from the headless transport check. Game-specific protection mods also require acceptance with the intended server's mod combination.
