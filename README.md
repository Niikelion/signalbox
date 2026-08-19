<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="signalbox" src="assets/logo-light.svg" width="96" height="96">
  </picture>
</p>

An event-based application framework for Node. It lets you easily build workflows — from
one-liners to complex pipelines — and all of that on top of handy plugins. Ideal for
bolting missing features onto a pre-built system, wiring one API to another, or surfacing
your alerts and configuration in Slack or Discord.

```ts
import { createApp, createWorkflowDefiner, merge, type NoEvents, type PluginApis } from "@signalbox/core"
import { poll, dedupe, publicIPv4 } from "@signalbox/commons"
import { upnpPlugin } from "@signalbox/upnp"
import { cloudflarePlugin } from "@signalbox/cloudflare"

const plugins = {
    upnp: upnpPlugin({ port: 5959 }),
    cloudflare: cloudflarePlugin({ apiToken, zoneId, records: ["home.example.com"] }),
}

const defineWorkflow = createWorkflowDefiner<NoEvents, PluginApis<typeof plugins>>()

const ddns = defineWorkflow("ddns", ctx => {
    const pushed = ctx.plugins.upnp.events.flow("external-ip").map(({ ip }) => ip)
    const polled = poll({ ctx, every: 15 * 60 * 1000, probe: publicIPv4 }).map(({ value }) => value)

    merge(pushed, polled)
        .apply(dedupe())
        .run(async ip => {
            if (await ctx.plugins.cloudflare.update(ip)) ctx.log(`updated records to ${ip}`)
        })
})

await createApp({ name: "ddns", plugins, workflows: [ddns] }).run()
```

## Packages

The framework and its supporting libraries.

| package | what it does |
| --- | --- |
| [`@signalbox/core`](packages/core) | the framework: typed event bus, plugins, workflows, lifecycle, `Flow` streams |
| [`@signalbox/config`](packages/config) | Zod-based config schema (`field()` builder, secrets) and a file-backed store |
| [`@signalbox/commons`](packages/commons) | reusable workflow blocks: polling, de-duplication, public-IP discovery |
| [`@signalbox/graph`](packages/graph) | workflows as data: a node registry and a JSON-graph compiler |
| [`@signalbox/service-cli`](packages/service-cli) | a config-driven CLI and systemd lifecycle manager for a long-running app |

## Integrations

Plugins that wrap an external capability, exposing it as events and an API.

| plugin | what it does |
| --- | --- |
| [`@signalbox/http`](packages/http) | one shared HTTP server (Hono) that other plugins mount routes on |
| [`@signalbox/webhook`](packages/webhook) | receive inbound HTTP webhooks and emit them as events |
| [`@signalbox/discord`](packages/discord) | send messages to Discord via a channel webhook |
| [`@signalbox/discord-bot`](packages/discord-bot) | a Discord gateway bot (slash commands, send, DM) via discord.js |
| [`@signalbox/cloudflare`](packages/cloudflare) | keep Cloudflare DNS A records pointed at a changing address |
| [`@signalbox/ovh`](packages/ovh) | keep an OVH DynHost record pointed at a changing address |
| [`@signalbox/upnp`](packages/upnp) | push-based WAN address discovery via UPnP IGD event subscriptions |
| [`@signalbox/schedule`](packages/schedule) | one-shot and cron jobs, timezone-aware, via Croner |
| [`@signalbox/store`](packages/store) | a small persistent typed document store backed by `node:sqlite` |

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
