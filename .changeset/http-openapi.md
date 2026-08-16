---
"@signalbox/http": minor
---

Add a typed route API and an OpenAPI toggle to `@signalbox/http`.

`http.route({ method, path, request?, response?, handle })` takes Zod schemas: the
request body is validated (400 with the Zod issues on failure) and the handler
receives the parsed, typed input. Passing `openapi: { path, info }` to `httpPlugin`
serves an OpenAPI 3.1 document at that path, with each route's request/response
schemas generated from Zod via `z.toJSONSchema` — no extra dependency.
