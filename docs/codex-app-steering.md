# Codex adapter

The Codex adapter connects to an existing app-server, resumes a bound task, submits input with `turn/start`, and observes public task history. Closing Rin disconnects the client without stopping the server or model turn.

The Rin daemon never starts, stops, restarts, or supervises app-server. Operators may explicitly run `rin codex start` `rin codex stop`, or `rin codex restart` from a separate terminal. Restart verifies the exact current-user local listener before sending a signal and never force-kills it.

Codex auto-bind is an adapter capability. It creates and names a task without starting a model turn. Other adapters do not inherit this behavior.

History observation emits public text, questions, final answers, failures, and completed generated images under the task's generated-image directory. Tool output and private reasoning are not chat output. Schema compatibility failures stop observation instead of guessing.

Reply observation uses the app-server `thread/turns/list` and `thread/items/list` APIs. Rin persists turn IDs and public-item fingerprints in its chat store, pages missed history after reconnecting, and reads active-turn items in canonical order to preserve steer boundaries. It does not open Codex databases or pin their schema version. An initial watch baselines existing output; a resumed watch delivers changes since its checkpoint. Old database checkpoints recover their recorded active turns through the API and rebaseline completed history.

These read-only history calls do not resume a thread or submit a model turn. The server must expose the paginated history APIs. A connection error pauses delivery and input admission until observation recovers.
