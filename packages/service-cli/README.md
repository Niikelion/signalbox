# @signalbox/service-cli

A config-driven command line and systemd lifecycle manager for a long-running signalbox app — with no domain logic baked in.

Part of [signalbox](https://github.com/Niikelion/signalbox).

## Install

```bash
npm install @signalbox/service-cli
```

Linux-only for the systemd parts (`setup`/`start`/`status`); the config commands work anywhere.

## Usage

Describe your app once and get a full CLI for it:

```ts
import { runCliMain } from "@signalbox/service-cli"
import { createConfigStore } from "@signalbox/config"
import { schema } from "./config.js"

await runCliMain({
    appName: "my-service",
    tagline: "does the thing",
    schema,
    createStore: (path) => createConfigStore({ appName: "my-service", schema, ...(path ? { path } : {}) }),
    createApp: (config) => createMyApp(config), // returns something with run()
})
```

That gives you:

| command | does |
| --- | --- |
| `config init \| list \| get \| set \| unset \| path` | manage the config file |
| `setup` / `teardown [--purge]` | install or remove the systemd service |
| `start \| stop \| restart \| status` | control it |
| `run` | run in the foreground (what systemd calls) |
| `once` | apply state a single time and exit (if `runOnce` is provided) |

The service runs as a dedicated system user under systemd hardening, not as root. Config lives at `/etc/<appName>/config.json` as root, otherwise `~/.config/<appName>/config.json`, written `0640` when it holds secrets. Use `createServiceManager` directly for programmatic control.

## License

MIT
