# @signalbox/cloudflare

signalbox plugin: keep Cloudflare DNS A records pointed at a changing address.

Part of [signalbox](https://github.com/Niikelion/signalbox).

## Install

```bash
npm install @signalbox/cloudflare
```

## Usage

```ts
import { cloudflarePlugin } from "@signalbox/cloudflare"

const plugins = {
    cloudflare: cloudflarePlugin({
        apiToken, // scoped to Zone:DNS:Edit on the target zone
        zoneId,
        records: ["home.example.com"],
        ttl: 60,
        proxied: false,
    }),
}

// in a workflow:
await ctx.plugins.cloudflare.update("203.0.113.7")
ctx.plugins.cloudflare.events.flow("dns:updated").run(({ record, previous, current }) => {
    ctx.log(`${record}: ${previous ?? "(created)"} -> ${current}`)
})
```

`update(ip)` patches every configured record (creating missing ones) and resolves to whether anything changed. The plugin emits `dns:updated` and `dns:unchanged`. The lower-level `api` helpers (`verifyZone`, `findARecord`, `patchARecord`, `createARecord`) and graph nodes (`registerCloudflareNodes`) are also exported.

## License

MIT
