# signalbox

An event-based application framework for Node, plus the app it was extracted from:
Cloudflare dynamic DNS that reacts to your router instead of polling it.

```
packages/core         the framework: typed event bus, plugins, workflows, lifecycle, config
packages/upnp         plugin: push-based WAN address discovery over UPnP IGD
packages/cloudflare   plugin: keep Cloudflare A records pointed at an address
apps/ddns             the app: workflows + a CLI for config and lifecycle
```

## The framework

An app is two lists: **plugins** that produce events, and **workflows** that react to
them. Nothing else wires them together — they only ever meet on the bus.

```ts
const plugins = {
    upnp: upnpPlugin({ port: 5959 }),
    cloudflare: cloudflarePlugin({ apiToken, zoneId, records, ttl, proxied }),
}

export const defineWorkflow = createWorkflowDefiner<MyEvents, PluginApis<typeof plugins>>()

const updateDns = defineWorkflow("update-dns", (ctx) => {
    ctx.on("wan-ip:changed", async ({ current }) => {
        await ctx.plugins.cloudflare.update(current)
    })
})

await createApp({ name: "my-app", plugins, workflows: [updateDns] }).run()
```

**Plugins** run first, in declaration order, and whatever `setup` returns becomes
`ctx.plugins[name]`. **Workflows** run second and get those APIs plus the bus.
Everything registered via `onStop` or `interval` is torn down in reverse order, so a
workflow can never outlive the plugin it depends on. `run()` blocks until SIGINT or
SIGTERM, then stops cleanly.

Every app gets `log`, `error`, `app:started`, `app:stopping` and `app:stopped` for free.

> Event maps must be `type` aliases, not `interface`s. Interfaces have no implicit
> index signature, so they do not satisfy the `EventMap` constraint.

## The DDNS app

Home connections get a new public IP whenever the ISP feels like it. The usual fix is
to poll something every few minutes. This does not: a router's `WANIPConnection` /
`WANPPPConnection` service marks `ExternalIPAddress` as an **evented** variable, so the
app subscribes over GENA and the router POSTs a `NOTIFY` the moment the address moves.

Three workflows, and they are the whole behaviour:

| workflow        | does                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| `track-wan-ip`  | turns a stream of `wan-ip:observed` into `wan-ip:changed`, de-duplicating |
| `update-dns`    | on a confirmed change, patches Cloudflare                                 |
| `fallback-poll` | HTTP check on startup and every N minutes, as a safety net                |

The fallback emits the *same* `wan-ip:observed` event as the push path, so the tracker
de-duplicates it and a quiet connection costs nothing. If there is no UPnP gateway at
all — a VPS, or UPnP switched off — the plugin says so and the app keeps working on the
poll alone.

### Install and run

```bash
npm install -g @signalbox/ddns

flowkit-ddns config init          # prompts for token, zone id, records
sudo flowkit-ddns setup           # systemd unit, service user, ufw rule, enable + start
journalctl -u flowkit-ddns -f
```

| command                            | does                                                |
| ---------------------------------- | --------------------------------------------------- |
| `config init \| list \| get \| set \| unset \| path` | manage the config file            |
| `setup` / `teardown [--purge]`     | install or remove the systemd service               |
| `start \| stop \| restart \| status`| control it                                          |
| `run`                              | run in the foreground (what systemd calls)          |
| `once`                             | update the records a single time and exit           |

Config lives at `/etc/flowkit-ddns/config.json` when root, `~/.config/flowkit-ddns/config.json`
otherwise, and is written `0640` because it holds an API token. The service runs as a
dedicated `flowkit` system user under systemd hardening, not as root.

Set `proxied: false` (the default) unless you only serve HTTP/HTTPS — Cloudflare's
orange-cloud proxy does not tunnel arbitrary ports. You still need port forwarding on
the router for anything to be reachable.

## Development

```bash
yarn install
yarn build       # turbo: tsc --noEmit && tsdown, per package
yarn typecheck
yarn lint
yarn changeset   # then `yarn release` to publish
```

Yarn 4 with the `node-modules` linker, Turborepo for the task graph, tsdown for bundling,
changesets for versioning. Libraries ship ESM + CJS with `attw` checks; the CLI is ESM only.
