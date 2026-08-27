# @signalbox/core

## 0.5.0

### Minor Changes

- 49dd5e2: Add durable owned-resource authority with atomic registration, blocking, recovery, owner suspension/removal, explicit enablement, and target-scoped ownership transfer. Protect Discord sends, expose authenticated webhook source policies, and add validated permission-aware manual triggers to core.

### Patch Changes

- Updated dependencies [49dd5e2]
    - @signalbox/permissions@0.3.0

## 0.4.0

### Minor Changes

- c332137: Redesign functional workflow composition around shared run-tracked Flow graphs.

    The public Flow API now uses `effect` as the terminal operator, `fork` for joined child runs, `detach` for orphaned continuations, and `combine` for shared downstream suffixes. Graph workflows now compile to the same Flow operator model instead of using graph-specific `STOP` and `fanOut` control values.

    Cloudflare and OVH graph nodes were updated to the new graph node-kind model.

## 0.3.0

### Minor Changes

- 669a2b7: Encrypt secret configuration values at rest and contain decrypted values in explicit `Secret<T>` wrappers. Add automatic key discovery and provisioning, atomic plaintext migration, process-wide output redaction, and secret-aware graph handling.

    Add secure CLI entry and lifecycle commands for inspecting, revealing, rotating, pruning, sealing, and purging configuration keys. Support masked interactive input, stdin and file input, systemd credentials, resumable two-key rotation, and retained retired keys for backup recovery.

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/secrets@0.2.0

## 0.2.0

### Minor Changes

- fc7f053: Add a lazy Flow API for composing event pipelines, and rebuild poll/dedupe on it.

    - core: `Flow<T>` with `map` / `filter` / `apply(operator)` / `run(sink)`, the
      `merge(...flows)` combiner, and `channel.flow(event)` to start a flow from a
      channel. Flows are lazy (nothing runs until `run`) and unicast (each `run`
      re-subscribes).
    - commons: `poll({ ctx, every, probe, retryOn?, backoff? })` is now a Flow
      producer emitting `{ value, phase }`; `dedupe(key?)` is now an `Operator` used
      via `.apply(dedupe(...))`. The old object-config `createPoll`/`createDedupe`
      workflow builders are removed.

    The DDNS apps collapse their four wiring workflows (bridge, track, poll, update)
    into a single flow pipeline:
    `merge(upnp.flow("external-ip"), poll(...)).apply(dedupe(...)).run(cloudflare.update)`.

- a52570e: `Flow.filter` now narrows: a type-guard predicate (`(v): v is S`) yields a `Flow<S>`.
  The plain boolean predicate still returns `Flow<T>`. Runtime behavior is unchanged.
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

- 41f64fd: Move config to a Zod-based schema in the new `@signalbox/config` package.

    - `@signalbox/config` (new): a `field()` builder (`field().string().secret()…`) that
      produces Zod schemas, `config({...})` to assemble them (mixing `field()` and raw
      `z.*`), a `secret()` helper backed by an isolated registry (no global side
      effects), and a `createConfigStore` that validates the file on load via `.parse()`,
      coerces CLI strings by introspecting each field, and redacts secrets. Re-exports `z`.
    - `service-cli`: `ServiceApp` is now generic over a `z.ZodObject`; the `config`
      command introspects the schema (required / secret / description) instead of the
      old `FieldSpec` shape.
    - `@signalbox/core`: the bespoke schema/config store is removed (`createConfigStore`,
      `ConfigSchema`, `ConfigOf`, `FieldSpec`, …); `isRoot` remains, exported from core.

    The DDNS apps now declare their config with `field()` and derive the type with
    `Infer<typeof configSchema>`.
