# @signalbox/service-cli

## 0.9.0

### Minor Changes

- 8023d01: Make `@signalbox/service-cli` independent of any service manager and move the systemd implementation into the new `@signalbox/service-systemd` package.

    Service management is now an externally supplied adapter. `runCli`/`runCliMain` accept a `{ service }` option; when it is present the lifecycle commands (`setup`, `teardown`, `start`, `stop`, `restart`, `status`) are enabled, and when it is absent they are hidden and rejected. Adapters declare named scopes, selected with `--scope <name>`.

    BREAKING (`@signalbox/service-cli`, pre-v1):

    - `createServiceManager` and the systemd types are removed — use `createSystemdServiceAdapter` from `@signalbox/service-systemd`.
    - `systemService` and `firewallPort` are removed from `ServiceApp`; pass them to `createSystemdServiceAdapter({ profile, firewallPort })` instead.
    - The `--user` flag is removed; the systemd adapter declares `system` (default) and `user` scopes, so use `--scope user`.

    `@signalbox/service-systemd` is new: `createSystemdServiceAdapter` retains the existing unit rendering, hardening, service-account and credential handling, and firewall integration. Purge no longer removes an empty owned config directory after `store.purge()`; the config file and managed keys are still removed.

## 0.8.0

### Minor Changes

- 288eead: Rebuild the interactive prompts on `@clack/prompts` with `picocolors`, replacing the hand-rolled raw-keypress terminal code. `config init` and `config interactive` now show a styled intro/outro, a proper highlighted select list, and native masked and confirm prompts.

    This fixes two bugs in the previous implementation: the interactive config editor no longer hangs after Save/Discard (stdin is released), and the field picker renders the whole list with the active row highlighted instead of a single row that swapped in place.

## 0.7.0

### Minor Changes

- c69e9a7: Replace the hand-rolled argument parser with commander and let apps register custom commands.

    `ServiceApp` gains a `commands` map of app-supplied subcommands (`{ summary, run }`), each handler receiving `{ config, store, args }`. Command names that collide with a built-in are rejected, and custom commands appear in `--help`.

    BREAKING: the built-in `once` command and the `ServiceApp.runOnce` hook are removed — express a one-shot as a custom command instead. The whole CLI (including the `config` subcommands) now runs on commander, so `commander` is a new runtime dependency.

## 0.6.0

### Minor Changes

- 46687ff: Add typed Unix-socket RPC with kernel peer credentials and structured systemd service profiles.

## 0.5.0

### Minor Changes

- 66737bf: Compose durable permission systems with registry-backed identities and unified auditing, protect OVH DynHost updates with hostname-scoped claims, wire durable permissions into the DDNS OVH application, and allow service applications to initialize asynchronously.

### Patch Changes

- @signalbox/core@0.5.1

## 0.4.2

### Patch Changes

- Updated dependencies [49dd5e2]
    - @signalbox/core@0.5.0
    - @signalbox/config@0.3.2

## 0.4.1

### Patch Changes

- Updated dependencies [c332137]
    - @signalbox/core@0.4.0
    - @signalbox/config@0.3.1

## 0.4.0

### Minor Changes

- c69b3bb: Add portable encrypted config export and import through the standard Age format. Exports support native Age and SSH recipients, imports support passphrase-protected SSH identities, and destination instances validate the bundle before re-encrypting secrets under their own local key.

## 0.3.0

### Minor Changes

- 669a2b7: Encrypt secret configuration values at rest and contain decrypted values in explicit `Secret<T>` wrappers. Add automatic key discovery and provisioning, atomic plaintext migration, process-wide output redaction, and secret-aware graph handling.

    Add secure CLI entry and lifecycle commands for inspecting, revealing, rotating, pruning, sealing, and purging configuration keys. Support masked interactive input, stdin and file input, systemd credentials, resumable two-key rotation, and retained retired keys for backup recovery.

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/secrets@0.2.0
    - @signalbox/config@0.3.0
    - @signalbox/core@0.3.0

## 0.2.0

### Minor Changes

- 361a337: Add an OVH DynHost DDNS target and extract the generic service scaffolding apps share.

    - `@signalbox/service-cli` (new): the provider-agnostic command-line and systemd
      lifecycle — argument parsing, the `config` subcommands, and setup/teardown/
      start/stop/status/run/once — driven by a small `ServiceApp` descriptor. No DNS
      or domain logic lives here; the one-shot command and the firewall port are
      optional hooks an app opts into.
    - `@signalbox/ovh` (new): a plugin that points OVH DynHost records at the current
      address over the dyndns2 protocol (HTTP Basic auth), plus an `ovh.update`
      graph node. DynHost reports `good`/`nochg`, so changed-vs-unchanged is exact;
      every other response is surfaced as an error.

- 41f64fd: Move config to a Zod-based schema in the new `@signalbox/config` package.

    - `@signalbox/config` (new): a `field()` builder (`field().string().secret()…`) that
      produces Zod schemas, `config({...})` to assemble them (mixing `field()` and raw
      `z.*`), a `secret()` helper backed by an isolated registry (no global side
      effects), and a `createConfigStore` that validates the file on load via `.parse()`,
      coerces CLI strings by introspecting each field, and redacts secrets. Re-exports `z`.
    - `service-cli`: `ServiceApp` is now generic over a `z.ZodObject`; the `config`
      command introspects the schema (required / secret / description) instead of the
      old `FieldSpec` shape.
    - `@signalbox/core`: the bespoke schema/config store is removed (`createConfigStore`,
      `ConfigSchema`, `ConfigOf`, `FieldSpec`, …); `isRoot` remains, exported from core.

    The DDNS apps now declare their config with `field()` and derive the type with
    `Infer<typeof configSchema>`.

### Patch Changes

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
    - @signalbox/config@0.2.0
