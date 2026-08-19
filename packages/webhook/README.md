# @signalbox/webhook

signalbox plugin for HTTP webhooks in both directions: **receive** inbound requests as events (mounted on the shared `@signalbox/http` server), and **fire** requests at outbound targets from your workflows.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/webhook @signalbox/http
```

`http` is only needed for inbound `routes`; outbound `targets` work on their own.

## Receiving (inbound)

```ts
import { httpPlugin } from "@signalbox/http"
import { webhookPlugin } from "@signalbox/webhook"

const http = httpPlugin({ port: 8080 })
const plugins = {
    http,
    webhook: webhookPlugin({
        http,
        routes: {
            "gh-push": { path: "/hooks/github" },
        },
    }),
}

// in a workflow — subscribe by route name:
ctx.plugins.webhook.events.flow("gh-push").run(request => {
    ctx.log(`hook: ${JSON.stringify(request.body)}`)
})
```

Each configured route becomes an event stream you subscribe to with `events.flow("<route>")`. The plugin doesn't open its own port — it mounts routes on the shared HTTP server, so one server serves your API and your hooks together.

## Sending (outbound)

Declare named `targets` and fire requests at them with `send`:

```ts
import { webhookPlugin } from "@signalbox/webhook"

const plugins = {
    webhook: webhookPlugin({
        targets: {
            deploy: {
                url: "https://ci.example.com/hooks/deploy",
                headers: { authorization: "Bearer …" },
                secret: "shared-secret", // sent as x-webhook-secret
            },
        },
    }),
}

// in a workflow — fire a request at a target:
const res = await ctx.plugins.webhook.send("deploy", { ref: "main" })
if (!res.ok) ctx.log(`deploy hook failed: ${res.status}`, "warn")
```

`send(target, body?, options?)` resolves with `{ status, ok, headers, body }` (the response body is JSON-parsed when possible). An object body is JSON-encoded; a string is sent as-is. A non-2xx status does **not** throw — inspect `res.ok` — but a network failure does. Per-call `options` can override the method or add headers.

You can configure `routes` and `targets` together, or use either on its own.

## License

MIT
