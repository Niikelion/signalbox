# @signalbox/config

Zod-based config schema and store for signalbox apps: a fluent `field()` builder, secret marking, and a file-backed store with sensible path resolution.

Part of [signalbox](https://github.com/Niikelion/signalbox).

## Install

```bash
npm install @signalbox/config
```

## Usage

```ts
import { config, field, createConfigStore, type Infer } from "@signalbox/config"

const schema = config({
    apiToken: field().string().min(1).secret().describe("API token"),
    zoneId: field().string().min(1).describe("Target zone id"),
    records: field().list().nonempty().describe("Comma-separated hostnames"),
    ttl: field().int().positive().default(60).describe("Record TTL"),
    proxied: field().bool().default(false),
})

export type AppConfig = Infer<typeof schema>

const store = createConfigStore({ appName: "my-app", schema })
const cfg = store.load() // validated AppConfig, throws with a hint if invalid
```

`field()` builds string/int/bool/list fields; chain `.secret()` to redact a value and `.describe()` to document it. Secret fields are written `0640`. The store resolves to `/etc/<appName>/config.json` as root, otherwise `$XDG_CONFIG_HOME/<appName>/config.json`; pass `path` to override.

Re-exports `z` (Zod) for raw fields, plus `introspect` helpers (`baseKind`, `isSecret`, `isRequired`, `describeOf`) for building CLIs and forms.

## License

MIT
