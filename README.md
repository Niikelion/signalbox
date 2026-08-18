<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="signalbox" src="assets/logo-light.svg" width="96" height="96">
  </picture>
</p>

<h1 align="center">signalbox</h1>

<p align="center"><em>One typed bus. Everything reacts.</em></p>

An event-based application framework for Node. An app is two lists — **plugins** that
produce events and expose APIs, and **workflows** that react to them — wired together by a
single typed bus and a strict start/stop lifecycle.

```ts
import { createApp, createWorkflowDefiner, type PluginApis } from "@signalbox/core"

type MyEvents = { "job:done": { id: string } }

const plugins = {
    // each plugin's setup return becomes ctx.plugins[name]
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

**Plugins** run first, in declaration order, and whatever `init` returns becomes
`ctx.plugins[name]`. **Workflows** run second and get those APIs, the app channel
`ctx.app`, and lifecycle hooks. Everything registered via `onStop` or `interval` is torn
down in reverse order, so a workflow can never outlive a plugin it depends on. `run()`
blocks until `SIGINT`/`SIGTERM`, then stops cleanly.

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
