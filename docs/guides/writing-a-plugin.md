# Writing a plugin

A plugin wraps an external capability and exposes it as [events](../concepts/events.md) and an [API](../concepts/plugins.md). This guide builds one from scratch.

## 1. The smallest plugin

A plugin that emits a `tick` on an interval and exposes its events — nothing else:

```ts
import { definePlugin, type ReadChannel } from "@signalbox/core"

type ClockEvents = { tick: { at: Date } }

interface ClockApi {
    events: ReadChannel<ClockEvents>
}

export const clockPlugin = (options: { everyMs: number }) =>
    definePlugin<ClockApi, ClockEvents>({
        name: "clock",
        init: ctx => {
            ctx.interval(options.everyMs, () => ctx.channel.emit("tick", { at: new Date() }))
            return { events: ctx.channel }
        },
    })
```

Note the shape: a **factory** (`clockPlugin(options)`) returning `definePlugin({ name, init })`. `init` returns the API — here just `events: ctx.channel`, so workflows can subscribe with `ctx.plugins.clock.events.on("tick", …)`. The timer registered with `ctx.interval` is cleared automatically on stop.

## 2. Add an API

Plugins usually expose methods too. Keep shared state in the factory closure so `init` (and `setup`) can reach it:

```ts
type CounterEvents = { changed: { value: number } }

interface CounterApi {
    events: ReadChannel<CounterEvents>
    increment: () => void
}

export const counterPlugin = () => {
    let value = 0

    return definePlugin<CounterApi, CounterEvents>({
        name: "counter",
        init: ctx => ({
            events: ctx.channel,
            increment: () => {
                value += 1
                ctx.channel.emit("changed", { value })
            },
        }),
    })
}
```

## 3. Connections: `init` vs `setup`

When your plugin holds a live connection, split the work. `init` builds the API and registers handlers and teardown; `setup` opens the connection **after** every workflow is wired, so no event fires before its subscribers exist:

```ts
export const chatPlugin = (options: { url: string }) => {
    const client = connect(options.url)

    return definePlugin<ChatApi, ChatEvents>({
        name: "chat",
        init: ctx => {
            client.on("message", m => ctx.channel.emit("message", m))
            ctx.onStop(() => client.close())
            return { events: ctx.channel, say: text => client.send(text) }
        },
        setup: () => client.open(),
    })
}
```

Use `ctx.onStop` for teardown that isn't a timer, and `ctx.fail(error)` to surface connection errors under the plugin's scope.

## 4. Use it

Plugins are just entries in the app's `plugins` record:

```ts
const plugins = { clock: clockPlugin({ everyMs: 1000 }) }

const defineWorkflow = createWorkflowDefiner<NoEvents, PluginApis<typeof plugins>>()
const logger = defineWorkflow("logger", ctx => {
    ctx.plugins.clock.events.on("tick", ({ at }) => ctx.log(`tick ${at.toISOString()}`))
})

await createApp({ name: "clock-app", plugins, workflows: [logger] }).run()
```

## 5. Test it

Because a plugin is a plain factory, unit-test its API directly, or run a real app and drive the lifecycle by hand:

```ts
const app = createApp({ name: "test", plugins, workflows })
await app.start()
// ... assert on emitted events / side effects ...
await app.stop("test done")
```

`start()` / `stop()` are the halves [`run()`](../concepts/apps.md) composes — no signal handling, so they fit a test cleanly.

## Next

[Plugins](../concepts/plugins.md) · [Events](../concepts/events.md) · [Workflows](../concepts/workflows.md)
