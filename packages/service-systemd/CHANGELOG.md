# @signalbox/service-systemd

## 0.1.0

### Minor Changes

- 8023d01: Make `@signalbox/service-cli` independent of any service manager and move the systemd implementation into the new `@signalbox/service-systemd` package.

    Service management is now an externally supplied adapter. `runCli`/`runCliMain` accept a `{ service }` option; when it is present the lifecycle commands (`setup`, `teardown`, `start`, `stop`, `restart`, `status`) are enabled, and when it is absent they are hidden and rejected. Adapters declare named scopes, selected with `--scope <name>`.

    BREAKING (`@signalbox/service-cli`, pre-v1):

    - `createServiceManager` and the systemd types are removed — use `createSystemdServiceAdapter` from `@signalbox/service-systemd`.
    - `systemService` and `firewallPort` are removed from `ServiceApp`; pass them to `createSystemdServiceAdapter({ profile, firewallPort })` instead.
    - The `--user` flag is removed; the systemd adapter declares `system` (default) and `user` scopes, so use `--scope user`.

    `@signalbox/service-systemd` is new: `createSystemdServiceAdapter` retains the existing unit rendering, hardening, service-account and credential handling, and firewall integration. Purge no longer removes an empty owned config directory after `store.purge()`; the config file and managed keys are still removed.

### Patch Changes

- Updated dependencies [8023d01]
    - @signalbox/service-cli@0.9.0
