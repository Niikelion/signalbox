# @signalbox/upnp

signalbox plugin: push-based WAN address discovery via UPnP IGD event subscriptions.

Part of [signalbox](https://github.com/Niikelion/signalbox).

## Install

```bash
npm install @signalbox/upnp
```

## Usage

A router's `WANIPConnection` / `WANPPPConnection` service marks `ExternalIPAddress` as an **evented** variable, so instead of polling, this plugin subscribes over GENA and the router POSTs a `NOTIFY` the moment the address changes.

```ts
import { upnpPlugin } from "@signalbox/upnp"

const plugins = {
    upnp: upnpPlugin({ port: 5959 }), // TCP port the NOTIFY callback listens on
}

// in a workflow:
ctx.plugins.upnp.events.flow("external-ip").run(({ ip }) => {
    ctx.log(`WAN IP is ${ip}`)
})
ctx.plugins.upnp.events.flow("unavailable").run(({ reason }) => {
    ctx.log(`no UPnP gateway: ${reason}`, "warn")
})
```

Emits `external-ip`, `reconnected`, and `unavailable`. When there's no gateway (a VPS, or UPnP switched off) the plugin says so and stays quiet — pair it with `@signalbox/commons` `poll` as a fallback. Lower-level pieces (`createUpnpWatcher`, `discoverGateway`, `gena`) and graph nodes (`registerUpnpNodes`) are also exported.

## License

MIT
