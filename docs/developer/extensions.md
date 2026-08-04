# Rin extension API

Rin extensions reuse Pi's extension runtime. Rin adds metadata only where a
multi-frontend runtime needs semantics that Pi's local TUI does not own.

## Session extensions

Use the same default export and handlers as a Pi extension. Importing Rin's
helper is optional; it provides the typed `chat` command option.

```ts
import { defineRinExtension } from "@hoshinorin/rin/extension";

export default defineRinExtension((rin) => {
  rin.registerCommand("hello", {
    description: "Say hello",
    chat: true,
    async handler(args, ctx) {
      ctx.ui.notify(`Hello ${args || "world"}`);
    },
  });
});
```

`RinExtensionAPI` is a structural superset of Pi's `ExtensionAPI`. Tools,
events, providers, renderers, flags, shortcuts, command handlers, argument
completion, and handler contexts remain Pi-owned. Rin does not keep a second
command registry or execute a command factory twice.

Existing Pi extensions continue to use `pi.registerCommand()` unchanged. A
command is exposed to Rin Chat only when its registration includes
`chat: true`; omission and `false` keep the command on ordinary Pi/Rin TUI and
RPC surfaces.

`chat: true` controls exposure, not caller authorization. Chat's existing
trusted-caller checks still apply. Discord and Telegram command menus are
projections of the runtime catalog; platform naming and count limits can omit a
menu item without changing runtime registration.

Chat executes extension handlers with Pi's RPC context. Notifications are
rendered as Chat output. Interactive dialog requests that Chat does not yet
support are cancelled explicitly instead of leaving a handler waiting. A
Chat-enabled command should therefore avoid TUI-only components and guard such
behavior with Pi's `ctx.mode` contract.

## Daemon extensions

Long-running services, Chat adapters, and external memory providers have a
different lifetime from Pi session extensions. Declare them through the named
`rinDaemonExtension` export, never through the default Pi factory:

```ts
import {
  defineRinDaemonExtension,
  defineRinExtension,
} from "@hoshinorin/rin/extension";

export default defineRinExtension((rin) => {
  // Session-scoped Pi/Rin registrations.
});

export const rinDaemonExtension = defineRinDaemonExtension((rin) => {
  rin.registerBackgroundService({
    async start(ctx) {
      ctx.logger.info?.(`starting ${ctx.name}`);
      return { async stop() {} };
    },
  });
});
```

The daemon API is registration-only. Runtime work belongs in a background
service's `start(ctx)` callback, where cancellation, logging, and tracked async
work are real capabilities. Pi registration methods are intentionally absent
from the daemon API, and daemon registration methods are absent from the
session API. Unsupported methods are never installed as silent no-ops.

Trusted entries come from `settings.json -> rinExtensions.daemon`
or a trusted Pi extension package that exports `rinDaemonExtension`:

```json
{
  "rinExtensions": {
    "daemon": [{ "packageName": "@example/rin-extension", "version": "1.0.0" }]
  }
}
```

## Command ownership

One catalog combines Pi builtins, extension commands, prompt/skill commands,
and the small Rin builtin contribution. Builtins are never registered through
`rin.registerCommand()` and remain fully functional when no ExtensionRunner is
present. One dispatcher routes each invocation to its semantic owner: Pi's
session runtime, daemon control, a frontend-local adapter, or a Rin service.
Frontends do not maintain independent command allowlists.
