---
"@signalbox/core": minor
"@signalbox/upnp": minor
"@signalbox/cloudflare": minor
"@signalbox/ovh": minor
"@signalbox/commons": minor
"@signalbox/graph": patch
---

Replace the app-wide typed bus with per-channel typing over one runtime bus.

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
