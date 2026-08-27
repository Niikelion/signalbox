# @signalbox/http

## 0.2.3

### Patch Changes

- Updated dependencies [49dd5e2]
    - @signalbox/core@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [c332137]
    - @signalbox/core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [669a2b7]
    - @signalbox/core@0.3.0

## 0.2.0

### Minor Changes

- 06e34f5: Add a typed route API and an OpenAPI toggle to `@signalbox/http`.

    `http.route({ method, path, request?, response?, handle })` takes Zod schemas: the
    request body is validated (400 with the Zod issues on failure) and the handler
    receives the parsed, typed input. Passing `openapi: { path, info }` to `httpPlugin`
    serves an OpenAPI 3.1 document at that path, with each route's request/response
    schemas generated from Zod via `z.toJSONSchema` — no extra dependency.

- 82deac2: Add `@signalbox/http`, one shared HTTP server (Hono) other plugins mount on.

    `httpPlugin({ port })` owns a single server and exposes `handle(method, path, handler)`
    plus the underlying `hono` app. It exposes that mount point at construction, so other
    plugins compose onto the same port without core plugin-to-plugin machinery.

    `@signalbox/webhook` now mounts on it: `webhookPlugin({ http, routes })` instead of
    running its own server — so webhooks and future HTTP endpoints share one port. Routes
    are registered during init and served when the http plugin binds in setup.

### Patch Changes

- Updated dependencies [fc7f053]
- Updated dependencies [a52570e]
- Updated dependencies [a7877e4]
- Updated dependencies [ad7aba3]
- Updated dependencies [41f64fd]
    - @signalbox/core@0.2.0
