---
"@flowkit/graph": minor
"@flowkit/upnp": minor
"@flowkit/cloudflare": minor
---

Graph nodes for the DDNS workflow, plus config vars and secrets.

`@flowkit/graph` gains config/secret template scopes (`{{ $config.x }}`,
`{{ $secret.x }}`, with secrets masked in logs), a `map` node that builds an
object from a template, and a stateful `dedupe` node. Nodes are now factories
(`create()`) called once per graph node, so per-node state lives in a plain
closure — no state is threaded through `run`.

`@flowkit/upnp` adds a `upnp.source` trigger node and extracts the shared
`createUpnpWatcher`. `@flowkit/cloudflare` adds a `cloudflare.update` action
node. Together they express the whole DDNS workflow as data:
`upnp.source → dedupe → cloudflare.update`.
