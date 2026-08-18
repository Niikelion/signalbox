# @signalbox/ovh

## 0.2.0

### Minor Changes

- 361a337: Add an OVH DynHost DDNS target and extract the generic service scaffolding apps share.

    - `@signalbox/service-cli` (new): the provider-agnostic command-line and systemd
      lifecycle — argument parsing, the `config` subcommands, and setup/teardown/
      start/stop/status/run/once — driven by a small `ServiceApp` descriptor. No DNS
      or domain logic lives here; the one-shot command and the firewall port are
      optional hooks an app opts into.
    - `@signalbox/ovh` (new): a plugin that points OVH DynHost records at the current
      address over the dyndns2 protocol (HTTP Basic auth), plus an `ovh.update`
      graph node. DynHost reports `good`/`nochg`, so changed-vs-unchanged is exact;
      every other response is surfaced as an error.

- 0f9fcad: Export `applyRecords`, the per-record update loop each provider plugin runs.

    The plugin's `update(ip)` and the DDNS apps' one-shot `once` command had separate
    copies of the same find/create/patch loop. Both now call `applyRecords`, which
    reports each record's outcome through a callback so callers choose whether to emit
    bus events or log directly.

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
- Updated dependencies [31f8059]
- Updated dependencies [ef60606]
- Updated dependencies [a7877e4]
- Updated dependencies [e0073bb]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
    - @signalbox/graph@0.2.0
