# @signalbox/config

Zod-based config schema and encrypted async store for signalbox apps.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/config
```

## Usage

```ts
import { config, field, createConfigStore, type ConfigOf, type InputOf } from "@signalbox/config"

const schema = config({
    apiToken: field().string().min(1).secret().describe("API token"),
    zoneId: field().string().min(1).describe("Target zone id"),
    records: field().list().nonempty().describe("Comma-separated hostnames"),
    ttl: field().int().positive().default(60).describe("Record TTL"),
    proxied: field().bool().default(false),
})

export type AppConfigInput = InputOf<typeof schema> // plaintext values accepted by save()
export type AppConfig = ConfigOf<typeof schema> // secret fields are Secret<T>

const store = createConfigStore({ appName: "my-app", schema })
const cfg = await store.load()
const token = cfg.apiToken.reveal() // explicit plaintext access
```

`field()` builds string/int/bool/list fields; chain `.secret()` to encrypt a top-level value and `.describe()` to document it. Secret defaults and nested secret markers are rejected. All store I/O is asynchronous.

Secret fields are persisted as authenticated `enc:1` envelopes. Keys are read from systemd credentials or `<APP>_CONFIG_KEY`, with provisioning through a loudly-warned file fallback beside the config. Existing plaintext secrets are validated and atomically migrated on their first read. `inspect()` reports masked values and encryption metadata without resolving keys.

The lifecycle API provides `keyInventory()`, resumable `rekey()`, guarded `pruneKeys()`, and `purge()`. Rekey journals contain IDs and phases only; no key bytes or plaintext values are written to them.

The store resolves to `/etc/<appName>/config.json` as root, otherwise `$XDG_CONFIG_HOME/<appName>/config.json`; pass `path` to override. Config files use mode `0640`, and writes use flushed temporary files followed by atomic replacement.

Re-exports `z` (Zod) for raw fields, plus `introspect` helpers (`baseKind`, `isSecret`, `isRequired`, `describeOf`) for building CLIs and forms.

## License

MIT
