---
"@signalbox/webhook": minor
---

Add `@signalbox/webhook`, a plugin that receives inbound HTTP webhooks.

`webhookPlugin({ port, routes })` runs an HTTP server and emits each matching
request on its channel, keyed by route name, so workflows subscribe with
`ctx.plugins.webhook.events.flow("<route>")`. Each route maps a `path` (and
optional `method`, default POST, and a `secret` checked against the
`x-webhook-secret` header); JSON bodies are parsed, and the emitted
`WebhookRequest` carries `body`, `headers`, `query`, `method`, and `path`. The
server binds during `setup` (so `start()` waits for it to listen) and closes on
stop.
