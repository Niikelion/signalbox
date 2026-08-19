# Apps

An **app** is the top-level unit: a name, a set of plugins, and a set of workflows. You build one with `createApp` and start it with `run()`.

```ts
import { createApp } from "@signalbox/core"

const app = createApp({
    name: "my-app",
    plugins, // integrations, keyed by the name workflows reach them by
    workflows, // your logic
})

await app.run()
```

## The two lists

- **`plugins`** — a record of plugins, keyed by the name workflows use to reach them (`ctx.plugins.<key>`). Whatever a plugin's `init` returns becomes that API.
- **`workflows`** — the functions that react to events and drive the plugins. Build them with a [workflow definer](workflows.md).

`name` labels the app (it shows up in logs and cleanup messages). Pass `logging: false` to skip attaching the built-in console logger.

## Lifecycle

`run()` is the whole lifecycle in one call: it starts the app, blocks until `SIGINT` or `SIGTERM`, then stops cleanly. Underneath:

1. **Start** — plugins initialize in declaration order; each plugin's `init` result is exposed on `ctx.plugins`. Workflows are then wired, and their `onStart` hooks fire.
2. **Run** — the app stays up, handling events, until it receives `SIGINT`/`SIGTERM`.
3. **Stop** — teardown callbacks (`onStop`, `interval`) run in reverse order, the logger detaches, and the bus clears.

Reverse-order teardown is the guarantee that matters: a workflow can never outlive a plugin it depends on.

## Manual control

When you don't want signal handling — tests, or embedding signalbox in a larger process — drive the phases yourself:

```ts
const app = createApp({ name, plugins, workflows })

await app.start()
// ... do work, run assertions ...
await app.stop("done")
```

`start()` and `stop(reason?)` are the two halves that `run()` composes.

## Next

[Plugins](plugins.md) · [Workflows](workflows.md) · [Events](events.md)
