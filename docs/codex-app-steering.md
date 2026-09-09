# Codex adapter

The Codex adapter connects to an existing app-server, resumes a bound task, submits input with `turn/start`, and observes public task history. Closing Rin disconnects the client without stopping the server or model turn.

The Rin daemon never starts, stops, restarts, or supervises app-server. Operators may explicitly run `rin app-server start` or `rin app-server restart` from a separate terminal. Restart verifies the exact current-user local listener before sending a signal and never force-kills it.

Codex auto-bind is an adapter capability. It creates and names a task without starting a model turn. Other adapters do not inherit this behavior.

History observation emits public text, questions, final answers, failures, and completed generated images under the task's generated-image directory. Tool output and private reasoning are not chat output. Schema compatibility failures stop observation instead of guessing.
