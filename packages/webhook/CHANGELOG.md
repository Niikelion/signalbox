# @signalbox/webhook

## 0.2.0

### Minor Changes

- 82deac2: Add `@signalbox/http`, one shared HTTP server (Hono) other plugins mount on.

    `httpPlugin({ port })` owns a single server and exposes `handle(method, path, handler)`
    plus the underlying `hono` app. It exposes that mount point at construction, so other
    plugins compose onto the same port without core plugin-to-plugin machinery.

    `@signalbox/webhook` now mounts on it: `webhookPlugin({ http, routes })` instead of
    running its own server — so webhooks and future HTTP endpoints share one port. Routes
    are registered during init and served when the http plugin binds in setup.

- 7cc42fb: Add `@signalbox/webhook`, a plugin that receives inbound HTTP webhooks.

    `webhookPlugin({ port, routes })` runs an HTTP server and emits each matching
    request on its channel, keyed by route name, so workflows subscribe with
    `ctx.plugins.webhook.events.flow("<route>")`. Each route maps a `path` (and
    optional `method`, default POST, and a `secret` checked against the
    `x-webhook-secret` header); JSON bodies are parsed, and the emitted
    `WebhookRequest` carries `body`, `headers`, `query`, `method`, and `path`. The
    server binds during `setup` (so `start()` waits for it to listen) and closes on
    stop.

### Patch Changes

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [06e34f5]
- Updated dependencies [82deac2]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
    - @signalbox/http@0.2.0
