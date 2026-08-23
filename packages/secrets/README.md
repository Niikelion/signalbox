# `@signalbox/secrets`

Encrypted configuration values, key-source abstractions, and process-wide output redaction for Signalbox.

The package provides:

- strict AES-256-GCM `enc:1` envelopes bound to an application and top-level field;
- `Secret<T>` wrappers whose long-lived process representation is encrypted;
- exact-match recursive redaction shared by compatible installed package copies;
- systemd runtime/sealed-archive and environment key sources;
- a file-fallback backend with staged key lifecycle operations.

The file backend stores keys beside the config and emits `SIGNALBOX_INSECURE_KEY_STORAGE`; use it only when a secure backend is unavailable.
