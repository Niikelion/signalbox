# Workflows

A **workflow** is your application logic: a function that reacts to events and operates over the plugins. Workflows hold no long-lived state of their own — they wire plugin events to plugin APIs.

## Defining one

`createWorkflowDefiner` binds a `defineWorkflow(name, setup)` to your app's event and plugin types, so `ctx` is fully typed:

```ts
import { createWorkflowDefiner, type NoEvents, type PluginApis } from "@signalbox/core"

const defineWorkflow = createWorkflowDefiner<NoEvents, PluginApis<typeof plugins>>()

const announce = defineWorkflow("announce", ctx => {
    ctx.plugins.hooks.events.flow("deploy").effect(req => {
        ctx.plugins.discord.send({ content: `deploy: ${JSON.stringify(req.body)}` })
    })
})
```

The two type parameters are the app's own [events](events.md) (`NoEvents` if it has none) and its [plugin](plugins.md) APIs — `PluginApis<typeof plugins>` derives them from your plugins record.

## The context

`setup` receives a `ctx`:

- **`plugins`** — the plugin APIs, keyed as declared (`ctx.plugins.discord.send(...)`).
- **`app`** — the app's own [channel](events.md): emit and subscribe to app-level events with `ctx.app.emit` / `ctx.app.on` / `ctx.app.flow`.
- **`log(message, level?)`** / **`fail(error)`** — report under the workflow's scope.
- **`onStart(fn)`** — run once the app has started.
- **`onStop(cleanup)`** — teardown, run in reverse order on stop.
- **`interval(ms, handler)`** — a repeating timer, cleared on stop.

## Reacting and driving

A workflow subscribes to a plugin's events and calls plugin APIs in response:

```ts
const backup = defineWorkflow("backup", ctx => {
    // react to a plugin event...
    ctx.plugins.schedule.cron("0 3 * * *", {}, async () => {
        // ...and drive other plugins
        const rows = ctx.plugins.store.collection("events").all()
        await ctx.plugins.discord.send({ content: `nightly backup: ${rows.length} rows` })
    })
})
```

Subscribe with `on`/`once`/`off` for callbacks, or `flow(event)` to build a [Flow](flow.md) pipeline (`map` / `filter` / `combine` / …).

## App-level events

When two workflows need to talk without a plugin between them, declare app events and use `ctx.app`:

```ts
type AppEvents = { "user:seen": { id: string } }
const defineWorkflow = createWorkflowDefiner<AppEvents, PluginApis<typeof plugins>>()

const track = defineWorkflow("track", ctx => {
    ctx.plugins.hooks.events.flow("visit").effect(v => ctx.app.emit("user:seen", { id: v.body.id }))
})

const greet = defineWorkflow("greet", ctx => {
    ctx.app.flow("user:seen").effect(({ id }) => ctx.log(`seen ${id}`))
})
```

## Next

[Events](events.md) · [Flow](flow.md) · [Apps](apps.md)
