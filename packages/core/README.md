# @signalbox/core

Event-based application framework for Node: a typed event bus, plugins, workflows, lifecycle, and config wiring.

Part of [signalbox](https://github.com/Niikelion/signalbox).

## Install

```bash
npm install @signalbox/core
```

## Usage

An app is two lists: **plugins** that produce events and expose APIs, and **workflows** that react to them. They only ever meet on the bus.

```ts
import { createApp, createWorkflowDefiner, type PluginApis } from "@signalbox/core"

// Event maps must be `type` aliases (see below).
type MyEvents = { "job:done": { id: string } }

const plugins = {
    // each plugin's init return becomes ctx.plugins[name]
}

const defineWorkflow = createWorkflowDefiner<MyEvents, PluginApis<typeof plugins>>()

const worker = defineWorkflow("worker", (ctx) => {
    ctx.onStart(() => {
        ctx.log("up")
        ctx.app.emit("job:done", { id: "1" })
    })

    // react to app events off the workflow's own channel
    ctx.app.flow("job:done").run(({ id }) => {
        ctx.log(`done ${id}`)
    })
})

await createApp({ name: "my-app", plugins, workflows: [worker] }).run()
```

Plugins run first, in declaration order; workflows run second with `ctx.plugins`, the app channel `ctx.app`, and lifecycle hooks (`onStart`, `onStop`, `interval`). Everything registered via `onStop`/`interval` is torn down in reverse order, so a workflow never outlives a plugin it depends on. `run()` blocks until `SIGINT`/`SIGTERM`, then stops cleanly.

Subscribe to a channel with `on`/`once`/`off` or start a `Flow` from it with `flow(event)`. Plugin events arrive on `ctx.plugins.<name>.events`.

> Event maps must be `type` aliases, not `interface`s — an interface has no implicit index signature and won't satisfy the `EventMap` constraint.

Also exports the `Flow` push-stream primitive (`makeFlow`, `merge`), the `SignalboxError` error type, and the `isRoot` platform helper.

## License

MIT
