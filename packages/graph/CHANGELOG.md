# @signalbox/graph

## 0.3.0

### Minor Changes

- 669a2b7: Encrypt secret configuration values at rest and contain decrypted values in explicit `Secret<T>` wrappers. Add automatic key discovery and provisioning, atomic plaintext migration, process-wide output redaction, and secret-aware graph handling.

    Add secure CLI entry and lifecycle commands for inspecting, revealing, rotating, pruning, sealing, and purging configuration keys. Support masked interactive input, stdin and file input, systemd credentials, resumable two-key rotation, and retained retired keys for backup recovery.

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/secrets@0.2.0
    - @signalbox/core@0.3.0

## 0.2.0

### Minor Changes

- 31f8059: Graph nodes for the DDNS workflow, plus config vars and secrets.

    `@signalbox/graph` gains config/secret template scopes (`{{ $config.x }}`,
    `{{ $secret.x }}`, with secrets masked in logs), a `map` node that builds an
    object from a template, and a stateful `dedupe` node. Nodes are now factories
    (`create()`) called once per graph node, so per-node state lives in a plain
    closure — no state is threaded through `run`.

    `@signalbox/upnp` adds a `upnp.source` trigger node and extracts the shared
    `createUpnpWatcher`. `@signalbox/cloudflare` adds a `cloudflare.update` action
    node. Together they express the whole DDNS workflow as data:
    `upnp.source → dedupe → cloudflare.update`.

- ef60606: Add `@signalbox/graph`: workflows expressed as data.

    A node registry (`registerNode` / `createNodeRegistry`) and a compiler
    (`compileGraph`) that turns a JSON graph of registered nodes into an ordinary
    `WorkflowDefinition`. The compiled workflow makes the same bus calls a
    hand-written one would, so it runs on the existing runtime unchanged; the trade
    is that a graph is validated when it loads rather than by the type checker.

    Ships four built-in nodes — `event.on`, `plugin.call`, `event.emit`, `log` —
    and a `{{ field }}` data-mapping resolver.

- e0073bb: Add a `repeat` fan-out node, so a graph can act on a list.

    `repeat` resolves `over` to a list and sends one flow down its edge per item,
    merging each item into the value under `as`. This lets one WAN-IP observation
    update several DNS records — `upnp.source → dedupe → repeat → cloudflare.update`
    — without an internal bus: fan-out stays edge-routed, so the graph is still a
    plain DAG. Backed by a `fanOut()` value wrapper the compiler expands.

### Patch Changes

- ad7aba3: Replace the app-wide typed bus with per-channel typing over one runtime bus.

    Plugins and workflows are no longer templated on an app-wide event union. The
    runtime is a single ordered `Bus`; each participant gets a `Channel<TEvents>`
    typed only to its own events:

    - Plugins emit on their own channel (`ctx.channel`) and opt into exposing a
      read-only `events` facade on their API for others to subscribe to.
    - Workflows get `ctx.app` (the app's own events) plus typed `ctx.plugins.*`;
      no union type, no `FrameworkEvents` casts.
    - Lifecycle is delivered through `ctx.onStart` / `ctx.onStop` hooks instead of
      `app:started` / `app:stopping` / `app:stopped` events.

    Breaking: `createEventBus`/`EventBus`/`AppBus` are replaced by `createBus`/`Bus`/
    `Channel`/`ReadChannel`; `App` is no longer generic; `PluginContext.bus` and
    `WorkflowContext.bus`/`on`/`emit` are gone. upnp now emits `external-ip` (the app
    bridges it to `wan-ip:observed`).

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
