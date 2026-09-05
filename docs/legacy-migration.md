# Migrating from Pi-based Rin

This guide is for an agent helping a user replace a legacy Pi-based Rin with the current Codex-based Rin. Treat the old installation as reference material and retained evidence, not as part of the new runtime.

## Migration contract

There is no automatic import of legacy data, memories, sessions, identity records, workflows, extensions, schedules, or chat configuration. The installer may preserve recognized old data and disable recognized old launchers or services during an approved replacement, but preservation is not conversion. Optional original-session search covers Codex session text only; it is not an old-Rin archive importer.

An agent may independently inspect selected old memories, identity records, workflow definitions, and message history when they are needed to understand what the user wants to retain. Use them as evidence, distinguish historical facts from current state, and carry forward only the useful behavior. Rebuild weak or obsolete workflows instead of mechanically copying them. Never make the new service load the old Rin installation, Pi, its daemon, or its extension loader.

Keep all account identifiers, credentials, private identity mappings, persona material, real task IDs, deployment paths, and migration notes in ignored private files. Do not add them to public documentation, examples, tests, commits, or diagnostic output.

## 1. Inventory before changing runtime state

Record the exact legacy installation, launchers, service entries, active processes, chat receivers, data stores, and workflows that may matter. Identify which service owns each live bot connection and which Codex task owns the session performing the migration. Preserve the old data in place or make a recoverable private backup before any cutover.

Do not stop a service from a task whose own execution depends on that service. Run lifecycle changes from a separate terminal or independent task. Do not assume that killing a worker completes a cutover: a service manager may restart it and create a duplicate receiver.

Classify each legacy item explicitly:

- retain as read-only reference;
- redesign for the current Rin;
- reconfigure as private current state;
- retire without replacement.

Do not infer current account identity, permissions, or desired behavior only from an old record. Verify drift-prone state against the live platform or current user configuration when practical.

## 2. Install the current Rin independently

Follow [Git installation](installation.md). The current installation has its own source releases, runtime entrypoints, ignored `private/` state, and optional daemon. It must remain usable if the old Rin directory is unavailable.

Configure only the products and optional features the user selected. A CLI-only installation needs no daemon. Configure the daemon only when the user needs the chat bridge, Nerve, or both.

## 3. Rebuild private behavior deliberately

Create new private configuration from the current examples and documentation. Do not copy a legacy configuration wholesale.

For the [chat bridge](chat-bridge.md):

1. Create current credentials and adapter entries for each platform.
2. Re-establish `allowUsers` from the platform's current identity values.
3. Select existing Codex tasks and add only the intended chat bindings, with explicit mirroring where required.
4. Reimplement retained local commands as current private command modules.
5. Configure attachment roots, display behavior, and App steering only when required.

Platform identities are not interchangeable. QQ Official Bot uses its own OpenID model. OneBot v11 uses the identity values supplied by its gateway. QQ Official Bot and OneBot v11 are separate required adapters with separate configuration and acceptance tests; OneBot does not imply any particular gateway implementation.

For [Nerve](nerve.md), recreate only the selected triggers, destinations, exclusions, and attention rules. Do not restore old scheduled work merely because a definition exists. Choose one current Codex target mode and ensure it does not compete with another process for the same session. Keep remote administrative capabilities disabled unless they are specifically required and authorized.

## 4. Validate before cutover

Validate the new private configuration and start with non-destructive checks. Confirm that its state directories and task references are current. Test every configured adapter independently; one working platform says nothing about another.

Use distinct evidence levels:

- configuration or protocol validation;
- service startup and platform connection;
- inbound receipt and durable admission;
- delivery to the intended Codex task;
- observed model execution;
- final outbound delivery to the real platform;
- reconnect and restart recovery without duplicate execution.

A connected bot, successful API call, queued input, or passing substitute test is not proof of real App end-to-end delivery. Record exactly which level was observed. For chat paths, separately exercise inbound text, attachments, mention or attention routing, command handling, progress cleanup, final output, uncertain delivery, reconnect, and restart recovery as applicable.

## 5. Perform a single-receiver cutover

Resolve the exact old service entries and the exact new configuration before stopping anything. Then:

1. stop and disable the old receiver through its actual service manager;
2. verify that it did not restart and no old process still owns the bot connection;
3. start the current Rin service;
4. verify readiness and confirm there is exactly one active receiver per bot account;
5. run real inbound-to-App-to-outbound acceptance tests for each enabled platform;
6. test automatic startup and reconnection once the live path works.

Do not run an old transitional deployment and the current daemon against the same account as an informal comparison. Duplicate Gateway or polling consumers can steal events, reconnect repeatedly, or make delivery evidence ambiguous.

## 6. Preserve rollback evidence

Keep the old data and private migration record until the new workflows have enough real acceptance evidence. If the cutover fails, stop the new exact service before restoring the old exact service, then confirm single ownership again. Do not merge old and new databases to repair a failed cutover.

After acceptance, archive or remove obsolete launchers and service definitions deliberately. Retained legacy data may remain available for reference, but the current Rin must continue to operate without it.
