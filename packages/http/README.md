# @signalbox/http

signalbox plugin: one shared HTTP server ([Hono](https://hono.dev) + `@hono/node-server`) that other plugins and workflows mount routes on.

Part of [signalbox](https://github.com/Niikelion/signalbox).

## Install

```bash
npm install @signalbox/http
```

## Usage

```ts
import { httpPlugin } from "@signalbox/http"
import { z } from "@signalbox/config"

const plugins = {
    http: httpPlugin({ port: 8080 }),
}

// in a workflow — typed, Zod-validated route:
ctx.plugins.http.route({
    method: "POST",
    path: "/echo",
    request: z.object({ msg: z.string() }),
    response: z.object({ echoed: z.string() }),
    handle: (input) => ({ echoed: input.msg }), // input is the validated body
})

// or a low-level handler:
ctx.plugins.http.handle("GET", "/health", () => ({ status: 200, body: "ok" }))
```

One server for the whole app: `@signalbox/webhook` and others mount onto it instead of opening their own port. `route()` feeds an optional OpenAPI spec (`z.toJSONSchema`). The raw Hono app is available as `ctx.plugins.http.hono` for advanced middleware.

## License

MIT
