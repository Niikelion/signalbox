# @signalbox/service-cli

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
