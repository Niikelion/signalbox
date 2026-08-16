---
"@signalbox/core": minor
"@signalbox/commons": minor
---

Add a lazy Flow API for composing event pipelines, and rebuild poll/dedupe on it.

- core: `Flow<T>` with `map` / `filter` / `apply(operator)` / `run(sink)`, the
  `merge(...flows)` combiner, and `channel.flow(event)` to start a flow from a
  channel. Flows are lazy (nothing runs until `run`) and unicast (each `run`
  re-subscribes).
- commons: `poll({ ctx, every, probe, retryOn?, backoff? })` is now a Flow
  producer emitting `{ value, phase }`; `dedupe(key?)` is now an `Operator` used
  via `.apply(dedupe(...))`. The old object-config `createPoll`/`createDedupe`
  workflow builders are removed.

The DDNS apps collapse their four wiring workflows (bridge, track, poll, update)
into a single flow pipeline:
`merge(upnp.flow("external-ip"), poll(...)).apply(dedupe(...)).run(cloudflare.update)`.
