# Example: Cloudflare dynamic DNS

A minimal [signalbox](https://github.com/Niikelion/signalbox) app that keeps Cloudflare A records pointed at your home connection's public IP.

It watches for address changes two ways — the router's UPnP `ExternalIPAddress` **push** and a periodic **poll** — merges them into one stream, de-duplicates, and writes to Cloudflare only when the address actually changes.

```ts
merge(pushed, polled)
    .apply(dedupe())
    .run(async ip => {
        if (await ctx.plugins.cloudflare.update(ip)) ctx.log(`updated records to ${ip}`)
    })
```

## Prerequisites

- A Cloudflare **API token** scoped to `Zone:DNS:Edit` on the target zone.
- The **zone id** (domain Overview page).
- A router that supports UPnP IGD (optional — without it, the poll alone keeps things working).

## Run

Set the environment and start it:

```bash
export CF_API_TOKEN=…            # required
export CF_ZONE_ID=…              # required
export CF_RECORDS=home.example.com,vpn.example.com   # required, comma-separated
export CF_TTL=60                 # optional (default 60)
export CF_PROXIED=false          # optional (default false)
export UPNP_PORT=5959            # optional (default 5959)

npm install
npm start
```

`npm start` runs `src/index.ts` with [`tsx`](https://github.com/privatenumber/tsx). The process stays up, reacting to address changes, until `Ctrl-C`.

## How it works

| piece | role |
| --- | --- |
| [`@signalbox/upnp`](../../packages/upnp) | emits `external-ip` when the router reports a new WAN address |
| [`@signalbox/commons`](../../packages/commons) | `poll` (fallback re-check) + `dedupe` (drop repeats) |
| [`@signalbox/cloudflare`](../../packages/cloudflare) | `update(ip)` patches the records, returning whether anything changed |
| [`@signalbox/core`](../../packages/core) | ties the plugins and the workflow together |

See the [signalbox documentation](https://github.com/Niikelion/signalbox/tree/master/docs) for the concepts.
