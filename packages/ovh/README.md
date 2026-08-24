# @signalbox/ovh

signalbox plugin: keep an OVH DynHost record pointed at a changing address.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/ovh
```

## Usage

```ts
import { ovhPlugin } from "@signalbox/ovh"

const plugins = {
    ovh: ovhPlugin({
        username, // DynHost username created in the OVH panel
        password,
        records: ["home.example.com"],
    }),
}

// in a workflow:
await ctx.plugins.ovh.update("203.0.113.7")
ctx.plugins.ovh.events.flow("dns:unchanged").effect(({ ip }) => {
    ctx.log(`already at ${ip}`)
})
```

`update(ip)` points the configured DynHost records at `ip` and resolves to whether anything changed. Emits `dns:updated` and `dns:unchanged`. The raw `updateDynHost` call and graph nodes (`registerOvhNodes`) are also exported.

## License

MIT
