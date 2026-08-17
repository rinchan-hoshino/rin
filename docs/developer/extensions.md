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

## External Chat platforms

Chat platforms outside Rin core are ordinary Pi extensions. Export the usual
default `ExtensionFactory` and contribute the platform through Pi's public
EventBus while the extension is loaded:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RIN_CHAT_PLATFORM_EVENT,
  type RinChatPlatformContribution,
} from "@hoshinorin/rin/extension";

const platform: RinChatPlatformContribution = {
  apiVersion: 1,
  platform: "example",
  create(input) {
    return {
      bot: {
        platform: "example",
        selfId: "example-bot",
        status: 0,
        async sendMessage(chatId, content) {
          return sendToExample(chatId, content);
        },
      },
      async start() {},
      async stop() {},
    };
  },
};

export default function example(pi: ExtensionAPI) {
  pi.events.emit(RIN_CHAT_PLATFORM_EVENT, platform);
}
```

Install and enable the package through Pi's native package system. Chat uses
Pi's `DefaultResourceLoader`; there is no Rin-specific package list, named
daemon export, background-service registry, or second extension loader.
Platform configuration remains under `settings.chat.<platform>`, and Chat owns
lifecycle, storage, inbound recovery, session binding, and outbox semantics.
The extension implements only its platform transport through the supplied
`RinChatPlatformInput` capabilities.

## Command ownership

The `rin` CLI delegates Pi package/config/auth commands to Pi's own command implementations and appends Rin-only commands. It does not maintain a copied Pi command table. At runtime, one catalog projects Pi builtins, extension commands, prompt/skill commands, and the small Rin builtin contribution through frontend/backend adapters; frontends do not maintain independent command allowlists.
