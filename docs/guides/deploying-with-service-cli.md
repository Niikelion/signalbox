# Deploying with service-cli

`@signalbox/service-cli` turns an app into a long-running service with a full command line and systemd lifecycle — config management, install/uninstall, start/stop/status — without any domain logic of its own. You describe your app once; the CLI is generated from it.

## The descriptor

You provide a `ServiceApp`: a name, a [config schema](../concepts/config.md), and how to build the store and the runnable app.

```ts
import { runCliMain } from "@signalbox/service-cli"
import { createConfigStore } from "@signalbox/config"
import { schema } from "./config.js"
import { createMyApp } from "./app.js"

await runCliMain({
    appName: "my-service",
    tagline: "keeps things in sync",
    schema,
    createStore: path => createConfigStore({ appName: "my-service", schema, ...(path ? { path } : {}) }),
    createApp: config => createMyApp(config), // returns an App (something with run())
    runOnce: async config => createMyApp(config), // optional: back the `once` command
    firewallPort: config => config.watchPort, // optional: port to open at setup
    systemService: { // optional, structured systemd customizations
        user: "my-service",
        group: "my-service",
        supplementaryGroups: ["allowed-local-users"],
        runtimeDirectory: { name: "my-service", mode: 0o750 },
        readWritePaths: ["/var/lib/my-service"],
    },
})
```

`runCliMain` parses `process.argv`, runs the matching command, and reports errors (with hints) and exit codes. `appName` drives the config path, the systemd unit name, and the `--help` header.

## The commands

| command | does |
| --- | --- |
| `config init \| list \| get \| set \| unset \| path` | manage the config file |
| `setup` / `teardown [--purge]` | install or remove the systemd service |
| `start \| stop \| restart \| status` | control the running unit |
| `run` | run in the foreground (what systemd invokes) |
| `once` | apply state a single time and exit (needs `runOnce`) |

## What `setup` does

`setup` installs a hardened systemd unit that runs `my-service run` as a dedicated, unprivileged system user — not root. It points the unit at the config file, opens the inbound firewall port if `firewallPort` returns one, then enables and starts the service. `teardown` reverses it; `--purge` also deletes the config.

Config lives at `/etc/<appName>/config.json` under the system service, written `0640` when it holds [secrets](../concepts/config.md). `config init` prompts for each field using the schema's descriptions.

`systemService` adds only the corresponding `User`, `Group`, `SupplementaryGroups`, `RuntimeDirectory`, `RuntimeDirectoryMode`, and `ReadWritePaths` directives. It does not accept raw systemd unit text. Existing hardening remains active, and writable paths are narrow exceptions to `ProtectSystem=strict`.

Missing primary users and groups are created by default. Supplementary groups must already exist. Teardown does not delete accounts or groups because they may be shared or operator-owned.

## Programmatic control

`runCliMain` is the batteries-included entry point. For finer control, `createServiceManager` exposes the pieces directly:

```ts
import { createServiceManager } from "@signalbox/service-cli"

const svc = createServiceManager("my-service")
svc.setupService({ scope: "system", configPath, watchPort })
svc.controlService("system", "restart")
svc.serviceStatus("system")
svc.teardownService({ scope: "system", purge: false, configPath })
```

The systemd commands are Linux-only; the `config` subcommands work anywhere.

## Next

[Config](../concepts/config.md) · [Apps](../concepts/apps.md)
