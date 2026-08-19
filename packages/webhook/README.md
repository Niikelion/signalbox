# @signalbox/webhook

signalbox plugin: receive inbound HTTP webhooks and emit them as events. Mounts on the shared `@signalbox/http` server.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/webhook @signalbox/http
```

## Usage

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

## License

MIT
