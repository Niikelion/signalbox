# Config

`@signalbox/config` gives an app a typed, validated configuration schema and a file-backed store. Schemas are Zod under the hood, with a fluent `field()` builder for the common cases and first-class handling of secrets.

## Defining a schema

```ts
import { config, field, type Infer } from "@signalbox/config"

export const schema = config({
    apiToken: field().string().min(1).secret().describe("Cloudflare API token"),
    zoneId: field().string().min(1).describe("Zone ID"),
    records: field().list().nonempty().describe("Comma-separated hostnames"),
    ttl: field().int().positive().default(60),
    proxied: field().bool().default(false),
})

export type AppConfig = Infer<typeof schema>
```

`field()` builds the primitives:

- **`.string()`** — with `.min` / `.max` / `.regex`.
- **`.int()`** — with `.positive` / `.min` / `.max`.
- **`.bool()`**.
- **`.list()`** — a comma-separated string list, with `.nonempty`.

Chain **`.default(value)`**, **`.describe(text)`**, and **`.secret()`** on any field. `Infer<typeof schema>` is the resulting config type. For anything the builder doesn't cover, drop in a raw Zod schema — `config` accepts both, and `z` is re-exported.

## Secrets

`.secret()` marks a value as sensitive. Secrets are redacted from anything the store prints (`list`, errors) and the config file is written `0640` when it contains any. Mark a raw Zod field with the `secret(...)` wrapper instead of the builder method.

## The store

```ts
import { createConfigStore } from "@signalbox/config"

const store = createConfigStore({ appName: "my-app", schema })

const cfg = store.load() // validated AppConfig; throws with a hint if invalid or missing
store.set("ttl", "120") // coerce + validate a single key from a string
store.save({ proxied: true }) // merge a partial and persist
store.exists() // is there a config file?
store.path // where it resolves to
```

Path resolution: `/etc/<appName>/config.json` when running as root, otherwise `$XDG_CONFIG_HOME/<appName>/config.json` (default `~/.config/...`). Pass `path` to `createConfigStore` to override.

## Introspection

The schema can be walked at runtime — `baseKind`, `isRequired`, `isSecret`, `describeOf` — which is how [`@signalbox/service-cli`](../guides/deploying-with-service-cli.md) turns a schema into `config` subcommands and prompts without knowing your app.

## Next

[Deploying with service-cli](../guides/deploying-with-service-cli.md) · [Apps](apps.md)
