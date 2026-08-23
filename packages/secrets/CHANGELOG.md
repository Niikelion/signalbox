# @signalbox/secrets

## 0.2.0

### Minor Changes

- 669a2b7: Encrypt secret configuration values at rest and contain decrypted values in explicit `Secret<T>` wrappers. Add automatic key discovery and provisioning, atomic plaintext migration, process-wide output redaction, and secret-aware graph handling.

    Add secure CLI entry and lifecycle commands for inspecting, revealing, rotating, pruning, sealing, and purging configuration keys. Support masked interactive input, stdin and file input, systemd credentials, resumable two-key rotation, and retained retired keys for backup recovery.
