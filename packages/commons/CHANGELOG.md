# @signalbox/commons

## 0.3.0

### Minor Changes

- c332137: Redesign functional workflow composition around shared run-tracked Flow graphs.

    The public Flow API now uses `effect` as the terminal operator, `fork` for joined child runs, `detach` for orphaned continuations, and `combine` for shared downstream suffixes. Graph workflows now compile to the same Flow operator model instead of using graph-specific `STOP` and `fanOut` control values.

    Cloudflare and OVH graph nodes were updated to the new graph node-kind model.

### Patch Changes

- Updated dependencies [c332137]
    - @signalbox/core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/core@0.3.0

## 0.2.0

### Minor Changes

- d648254: Add `@signalbox/commons`, reusable workflow building blocks on top of core.

    - `createPoll` (new): a polling workflow — probe on an interval and at startup,
      emit the result as an event, and re-probe with backoff on a trigger event.
    - `createDedupe` (new): a workflow that forwards an event only when a selected
      key changes, mapping the input payload to the output event.
    - `publicIPv4` / `isIPv4` (new): resolve the host's public IPv4 over HTTP,
      racing several sources.

    Both are curried over the app's event and plugin maps, mirroring
    `createWorkflowDefiner`. The DDNS apps now build their WAN-IP tracking and
    fallback poll from these instead of hand-rolled copies.

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

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
