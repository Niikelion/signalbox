# @signalbox/upnp

## 0.2.2

### Patch Changes

- Updated dependencies [c332137]
    - @signalbox/core@0.4.0
    - @signalbox/graph@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/core@0.3.0
    - @signalbox/graph@0.3.0

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

- a7877e4: Initial release.

    `@signalbox/core` provides the event-based framework: a typed event bus, plugins that
    produce events, workflows that react to them, ordered teardown, and a schema-driven
    config store.

    `@signalbox/upnp` subscribes to the router's UPnP `ExternalIPAddress` event so address
    changes arrive as a push instead of being polled for. `@signalbox/cloudflare` applies an
    address to Cloudflare DNS A records, re-reading each record so out-of-band edits are
    corrected.

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

### Patch Changes

- 766ebaa: Harden the UPnP NOTIFY path so only genuine WAN address changes reach the DNS
  updater, and so a router that drops offline and returns on a new address is
  handled cleanly.

    - Validate every ExternalIPAddress before emitting it. A router mid-reconnect
      advertises placeholders (`0.0.0.0`, empty, or its private LAN address) for a
      moment before the WAN link settles; these no longer propagate to a DNS update.
      Exposed as `isPublicIPv4`.
    - Reject spoofed and stale callbacks. The NOTIFY server binds `0.0.0.0`, so it
      now accepts a notification only when its `SID` matches the live subscription,
      and drops any `SEQ` at or below the last one handled for that subscription.
    - Fix a subscription/emit leak on shutdown. `stop()` during an in-flight
      `connect()` (discovery takes several seconds) could still subscribe and emit
      on a stopping bus; `connect()` now re-checks after each step and tears down a
      subscription it created past the stop.

    `createNotifyServer` now takes an options object (`{ port, isCurrentSid,
onExternalIp, log }`) instead of positional args.

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [31f8059]
- Updated dependencies [ef60606]
- Updated dependencies [a7877e4]
- Updated dependencies [e0073bb]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
    - @signalbox/graph@0.2.0
