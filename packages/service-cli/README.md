# @signalbox/service-cli

A config-driven command line and systemd lifecycle manager for a long-running signalbox app — with no domain logic baked in.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

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
    createStore: path => createConfigStore({ appName: "my-service", schema, ...(path ? { path } : {}) }),
    createApp: config => createMyApp(config), // returns something with run()
})
```

That gives you:

| command                                               | does                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `config init \| interactive \| list \| get \| reveal` | safely inspect and edit config                                |
| `config set \| unset \| rekey \| keys \| path`        | mutate config and manage key lifecycle                        |
| `config export \| import`                              | transfer config securely between instances                    |
| `setup` / `teardown [--purge]`                        | install or remove the systemd service                         |
| `start \| stop \| restart \| status`                  | control it                                                    |
| `run`                                                 | run in the foreground (what systemd calls)                    |
| `once`                                                | apply state a single time and exit (if `runOnce` is provided) |

Secret values never belong in argv: `config set <secret>` opens a cursor-aware masked editor, while `--stdin` and `--file` support automation. `config get` remains masked; only `config reveal <secret>` prints plaintext.

## Transfer between instances

Config transfer uses the standard [age](https://github.com/FiloSottile/age) executable and format. Install `age`, then encrypt an export to the destination operator's Age or SSH public key:

```bash
my-service config export --recipient 'ssh-ed25519 AAAA...' --output config.age
```

On the destination, import with the matching private identity:

```bash
my-service config import --identity ~/.ssh/id_ed25519 --file config.age
```

Age prompts securely when the SSH private key is passphrase-protected. `ssh-rsa`, `ssh-ed25519`, and native `age1...` recipients are supported; use `--recipients-file <path>` to encrypt for multiple recipients. Import checks the bundle version and app name, validates the complete config schema, then encrypts every secret under the destination instance's local at-rest key. Plaintext is passed in memory and is not written to an intermediate file. Existing destination config requires confirmation or `--yes`. Export refuses to overwrite its output file.

Set `SIGNALBOX_AGE_EXECUTABLE` when `age` is not on `PATH`.

The service runs as a dedicated system user under systemd hardening, not as root. `ServiceApp.systemService` can select the user/group, supplementary groups, a runtime directory, and narrow writable paths without accepting raw unit directives. Setup seals active and retired keys with `systemd-creds`, verifies every round trip, loads them through unit credentials, then removes verified file-fallback copies. Config lives at `/etc/<appName>/config.json` as root, otherwise `~/.config/<appName>/config.json`, written `0640` when it holds secrets. Use `createServiceManager` directly for programmatic control.

## License

MIT
