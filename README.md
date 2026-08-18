<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="signalbox" src="assets/logo-light.svg" width="96" height="96">
  </picture>
</p>

An event-based application framework for Node. You compose an app from **plugins** — which
bridge the outside world to the bus in both directions — and **workflows** — which react to
events and emit their own. One typed bus carries everything between them; a strict lifecycle
brings them up in order and tears them down in reverse.

```ts
import { createApp, createWorkflowDefiner, type PluginApis } from "@signalbox/core"

type MyEvents = { "job:done": { id: string } }

const plugins = {
    // each plugin's init return becomes ctx.plugins[name]
}

const defineWorkflow = createWorkflowDefiner<MyEvents, PluginApis<typeof plugins>>()

const worker = defineWorkflow("worker", (ctx) => {
    ctx.onStart(() => {
        ctx.app.emit("job:done", { id: "1" })
    })
    ctx.app.flow("job:done").run(({ id }) => {
        ctx.log(`done ${id}`)
    })
})

await createApp({ name: "my-app", plugins, workflows: [worker] }).run()
```

Plugins start first, in declaration order, and whatever a plugin's `init` returns becomes
`ctx.plugins[name]` for workflows to call. Workflows start next, reacting on the app channel
`ctx.app` and driving those plugin APIs. Anything a workflow registers with `onStop` or
`interval` is cleaned up in reverse order, so it can never outlive a plugin it depends on.
`run()` blocks until `SIGINT`/`SIGTERM`, then shuts everything down cleanly.

> Event maps must be `type` aliases, not `interface`s — an interface has no implicit index
> signature and won't satisfy the `EventMap` constraint.

## Packages

| package | what it does |
| --- | --- |
| [`@signalbox/core`](packages/core) | the framework: typed event bus, plugins, workflows, lifecycle, `Flow` streams |
| [`@signalbox/config`](packages/config) | Zod-based config schema (`field()` builder, secrets) and a file-backed store |
| [`@signalbox/store`](packages/store) | a small persistent typed document store backed by `node:sqlite` |
| [`@signalbox/schedule`](packages/schedule) | one-shot and cron jobs, timezone-aware, via Croner |
| [`@signalbox/http`](packages/http) | one shared HTTP server (Hono) that other plugins mount routes on |
| [`@signalbox/webhook`](packages/webhook) | receive inbound HTTP webhooks and emit them as events |
| [`@signalbox/discord`](packages/discord) | send messages to Discord via a channel webhook |
| [`@signalbox/discord-bot`](packages/discord-bot) | a Discord gateway bot (slash commands, send, DM) via discord.js |
| [`@signalbox/commons`](packages/commons) | reusable workflow blocks: polling, de-duplication, public-IP discovery |
| [`@signalbox/upnp`](packages/upnp) | push-based WAN address discovery via UPnP IGD event subscriptions |
| [`@signalbox/cloudflare`](packages/cloudflare) | keep Cloudflare DNS A records pointed at a changing address |
| [`@signalbox/ovh`](packages/ovh) | keep an OVH DynHost record pointed at a changing address |
| [`@signalbox/graph`](packages/graph) | workflows as data: a node registry and a JSON-graph compiler |
| [`@signalbox/service-cli`](packages/service-cli) | a config-driven CLI and systemd lifecycle manager for a long-running app |

Each package has its own README with a usage example. Libraries ship ESM + CJS with
`attw` checks; the CLI is ESM only.

## Development

```bash
yarn install
yarn build       # turbo: tsc --noEmit && tsdown, per package
yarn typecheck
yarn lint
yarn changeset   # then `yarn release` to publish
```

Yarn 4 with the `node-modules` linker, Turborepo for the task graph, tsdown for bundling,
and Changesets for versioning.

## License

MIT — see [LICENSE](LICENSE).
