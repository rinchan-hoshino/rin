# Memory Provider Extension API

Rin Memory Provider API v1 lets a trusted background extension contribute memory reads and writes or replace selected default-memory capabilities. The default local transcript memory remains a native Rin core implementation; it is not registered or presented as an extension.

Both paths use the same internal memory coordinator for capability selection, result ordering, limits, failure handling, and append/replace composition. The public extension ABI is a stable, reduced adapter over that coordinator and does not expose Rin's storage layout.

## Registration and composition

```js
rin.registerMemoryProvider(provider, {
  apiVersion: 1,
  mode: "append",
  key: "example-memory",
  name: "Example Memory",
});
```

`apiVersion: 1` selects the documented public contract. Registrations without `apiVersion` use the pre-v1 compatibility shape and are not covered by the public stability guarantee. Unsupported versions or modes are rejected and logged.

`mode` controls composition with native local memory:

- `append` (default): native local memory and extension providers both participate;
- `replace`: native local memory is omitted for capabilities implemented by a replacing extension.

Capabilities are independent:

- `search(request, context)` handles query retrieval;
- `listRecent(request, context)` handles retrieval without a query;
- `write(record, context)` receives newly archived transcript text.

A replacement that implements only `search` replaces native query search while native recent retrieval and native writes continue. Implement all three methods with `mode: "replace"` to replace all default-memory capabilities.

When several extensions implement one capability, all participate. If any uses `replace`, the coordinator omits only native local memory for that capability; other extension providers remain active. Replacement is deliberate: if a replacing extension fails, Rin does not silently execute the omitted native operation afterward.

## Internal ownership boundary

The internal coordinator owns:

- deciding whether native local memory participates;
- invoking native and extension backends;
- globally ordering and limiting selected results;
- preserving best-effort transcript writes;
- preventing a submitted daemon operation from being retried locally and duplicated.

Native local memory continues to call Rin's existing transcript archive writer, archive search, and recent-session loader directly. It does not implement the public extension callback context and does not receive extension registration metadata.

If Rin confirms that the daemon is unavailable before submitting a coordinated command, it runs the native local coordinator path directly. Once a command has been submitted to a reachable daemon, a transport or command timeout does not trigger another local execution because the daemon may already have completed it and its replacement policy cannot be safely reconstructed.

## Minimal provider

This in-memory example demonstrates the complete public contract without binding the extension to an external service:

```js
const rows = [];

export default function extension(rin) {
  rin.registerMemoryProvider(
    {
      async search(request, context) {
        if (context.signal.aborted) return [];
        const query = request.query.toLowerCase();
        return rows
          .filter((row) => row.text.toLowerCase().includes(query))
          .slice(0, request.limit)
          .map((row, index) => ({
            id: row.id,
            name: `Archived ${row.role} message`,
            summary: row.text,
            timestamp: row.timestamp,
            score: request.limit - index,
            reference: `example-memory:${row.id}`,
          }));
      },

      async listRecent(request, context) {
        if (context.signal.aborted) return [];
        return rows
          .slice(-request.limit)
          .reverse()
          .map((row) => ({
            id: row.id,
            summary: row.text,
            timestamp: row.timestamp,
            reference: `example-memory:${row.id}`,
          }));
      },

      async write(record, context) {
        if (context.signal.aborted) return;
        rows.push({
          id: record.id,
          timestamp: record.timestamp,
          sessionId: record.scope.sessionId,
          role: record.role,
          text: record.text,
        });
      },
    },
    {
      apiVersion: 1,
      mode: "append",
      key: "example-memory",
      name: "Example Memory",
    },
  );
}
```

The array is only a contract example. A real extension owns its client, persistence, credentials, retries, and provider-specific namespace.

## Read requests

`search` receives:

```ts
{
  apiVersion: 1;
  mode: "search";
  query: string;
  limit: number;
  order: "relevance" | "newest";
}
```

`listRecent` receives:

```ts
{
  apiVersion: 1;
  mode: "recent";
  query: "";
  limit: number;
  order: "newest";
}
```

Rin does not pass the raw `recall` parameter object. New internal parameters therefore cannot silently become part of the provider contract.

Read methods return result arrays. `id` is required; other fields are optional:

```ts
{
  id: string;
  name?: string;
  summary?: string;
  description?: string;
  preview?: string;
  score?: number;
  timestamp?: string;
  url?: string;
  reference?: string;
  externalId?: string;
  messages?: Array<{
    id?: string;
    role?: string;
    timestamp?: string;
    line?: number;
    text: string;
    toolName?: string;
  }>;
}
```

Rin labels normalized extension results with the registered provider key, then the internal coordinator orders them together with any selected native results. Providers should return finite scores where larger values mean a stronger match and should obey `limit`.

## Write records

`write` receives a stable logical record rather than native storage details:

```ts
{
  apiVersion: 1;
  id: string;
  timestamp: string;
  scope: { sessionId: string };
  role: string;
  text: string;
  metadata?: {
    toolName?: string;
    toolCallId?: string;
    customType?: string;
    provider?: string;
    model?: string;
  };
}
```

The public record intentionally excludes `agentDir`, transcript file paths, archive paths, runtime directories, and raw internal content arrays. Those fields belong to Rin's native storage implementation, not the extension ABI. A replacing extension is responsible for its own storage and reference model using the stable logical fields above.

Registering a write-capable provider is an explicit decision to send normalized transcript text to that extension. Document destination and retention behavior, and keep credentials outside source control and examples.

## Callback context and lifecycle

Every callback receives:

```ts
{
  apiVersion: 1;
  key: string;
  name: string;
  packageName: string;
  config: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  logger: {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
}
```

The callback context contains provider identity, configuration, cancellation, and logging only. It does not expose Rin installation, agent, session-file, or runtime paths.

Rin aborts `context.signal` when an extension operation times out or its background extension stops. Extension-provider limits are:

- read: 30 seconds;
- write: 5 seconds.

A timeout or rejected extension callback is isolated from normal chat operation. In append mode, native local memory still participates. In replace mode, the deliberately replaced native capability is not executed as fallback.

## Configuration

Configure the package as a trusted background service under `settings.json -> rinExtensions.backgroundServices`:

```json
{
  "rinExtensions": {
    "backgroundServices": [
      {
        "name": "example-memory",
        "packageName": "example-memory-extension",
        "version": "file:/absolute/path/to/example-memory-extension",
        "config": {
          "namespace": "private-agent"
        }
      }
    ]
  }
}
```

The loader supplies the service's `config` by default. Registration-level `config` may replace it for one provider. Restart or reload Rin after changing background extension settings.

## Types and compatibility

Rin release builds ship a self-contained declaration at:

```text
~/.rin/app/current/dist/core/rin-extension-api/memory-provider-v1.d.ts
```

Vendor it into the provider project so its build does not depend on Rin's moving `current` install link:

```bash
mkdir -p types
cp ~/.rin/app/current/dist/core/rin-extension-api/memory-provider-v1.d.ts \
  types/memory-provider-v1.d.ts
```

On Windows, copy the same file from `%USERPROFILE%\.rin\app\current\dist\core\rin-extension-api\`. Use a type-only local import, which is erased from emitted JavaScript:

```ts
import type { RinMemoryProviderExtensionApiV1 } from "./types/memory-provider-v1.js";

export default function extension(rin: RinMemoryProviderExtensionApiV1) {
  rin.registerMemoryProvider(
    {
      search(request) {
        return [{ id: request.query, summary: request.query }];
      },
    },
    { apiVersion: 1, mode: "append", key: "typed-example" },
  );
}
```

Compatibility policy:

- required v1 fields and append/replace semantics remain backward compatible within API v1;
- optional fields may be added to v1 requests, records, contexts, results, or registration options;
- a breaking contract uses a new integer `apiVersion`;
- an old version is removed only after deprecation is documented in release notes and this page;
- omitted `apiVersion` remains a legacy compatibility path, not a stability guarantee.

## Validation checklist

Before distributing a provider extension, verify:

1. it registers with `apiVersion: 1`, an intentional mode, and a stable key;
2. query and recent reads obey `limit` and return stable ids;
3. writes use only documented logical record fields;
4. aborting `context.signal` stops pending provider work;
5. append failures leave native local memory usable;
6. replacement failures have the deliberately documented no-native-fallback behavior;
7. documentation states data destination, retention behavior, required secrets, and replaced capabilities.
