# Example: Cloudflare dynamic DNS

A complete [signalbox](https://github.com/Niikelion/signalbox) app: it keeps Cloudflare A records pointed at your home connection's public IP, with a **config-driven CLI** and **systemd lifecycle** — no domain logic in the CLI, all of it from the framework.

It watches for address changes two ways — the router's UPnP `ExternalIPAddress` **push** and a periodic **poll** — merges them into one stream, de-duplicates, and writes to Cloudflare only when the address actually changes.

This is the port of signalbox's own DDNS app, without the Discord chat-bridge.

## Build

```bash
npm install
npm run build      # → dist/cli.js
```

Run the CLI with `node dist/cli.js <command>` (or `npm link` to get a `cloudflare-ddns` binary on your PATH).

## Configure

```bash
node dist/cli.js config init     # prompts for each field, using the schema descriptions
node dist/cli.js config set ttl 120
node dist/cli.js config list     # secrets are redacted
node dist/cli.js config path     # where the file lives
```

Config resolves to `/etc/cloudflare-ddns/config.json` as root, otherwise
`~/.config/cloudflare-ddns/config.json`, written `0640` because it holds the API token.

| key | required | default | what |
| --- | --- | --- | --- |
| `apiToken` | ✓ (secret) | — | Cloudflare token, scoped `Zone:DNS:Edit` |
| `zoneId` | ✓ | — | zone id from the domain's Overview page |
| `records` | ✓ | — | comma-separated hostnames to keep updated |
| `ttl` | | `60` | TTL for records this tool creates |
| `proxied` | | `false` | route through Cloudflare's proxy (HTTP/HTTPS only) |
| `watchPort` | | `5959` | TCP port the UPnP NOTIFY callback listens on |
| `fallbackMinutes` | | `15` | safety-net re-check interval |

## Run

```bash
node dist/cli.js run     # foreground — reacts to changes until Ctrl-C
node dist/cli.js once    # apply the records a single time and exit
```

## Install as a service (Linux)

```bash
sudo node dist/cli.js setup      # hardened systemd unit, dedicated user, firewall port, enable + start
node dist/cli.js status
sudo node dist/cli.js teardown   # add --purge to also delete the config
```

`setup` runs the app as `cloudflare-ddns run` under a dedicated unprivileged system user and opens `watchPort` from the gateway. `start | stop | restart | status` control the unit.

## How it works

| piece | role |
| --- | --- |
| [`@signalbox/config`](../../packages/config) | the schema (`field()` builder, secrets) and the config store |
| [`@signalbox/service-cli`](../../packages/service-cli) | the whole CLI + systemd lifecycle, from a small `ServiceApp` descriptor |
| [`@signalbox/upnp`](../../packages/upnp) | emits `external-ip` when the router reports a new WAN address |
| [`@signalbox/commons`](../../packages/commons) | `poll` (fallback re-check) + `dedupe` (drop repeats) |
| [`@signalbox/cloudflare`](../../packages/cloudflare) | `update(ip)` patches the records, returning whether anything changed |
| [`@signalbox/core`](../../packages/core) | ties the plugins and the workflow together |

The pipeline is one workflow:

```ts
merge<Observation>(observed, polled)
    .filter(dedupeBy(o => o.ip))
    .effect(async ({ ip }) => ctx.plugins.cloudflare.update(ip))
```

See the [signalbox documentation](https://github.com/Niikelion/signalbox/tree/master/docs) for the concepts.
