---
"@signalbox/http": minor
"@signalbox/webhook": minor
---

Add `@signalbox/http`, one shared HTTP server (Hono) other plugins mount on.

`httpPlugin({ port })` owns a single server and exposes `handle(method, path, handler)`
plus the underlying `hono` app. It exposes that mount point at construction, so other
plugins compose onto the same port without core plugin-to-plugin machinery.

`@signalbox/webhook` now mounts on it: `webhookPlugin({ http, routes })` instead of
running its own server — so webhooks and future HTTP endpoints share one port. Routes
are registered during init and served when the http plugin binds in setup.
