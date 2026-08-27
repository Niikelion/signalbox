# @signalbox/permissions-store

Durable `@signalbox/store` backend for `@signalbox/permissions`.

The complete registry snapshot is stored as one document, so each registry mutation is published atomically. Use one backend instance per store in a process.
