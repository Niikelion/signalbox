# Flow

`Flow<T>` is a lazy workflow graph you build on top of an event. It's the tool for anything past a single `on` handler: transforming, filtering, combining, forking, detaching, and de-duplicating events.

Two properties define it:

- **Lazy** — nothing runs until `effect()`. Building a flow just describes the graph.
- **Shared by handle** — branching from the same flow handle shares one root run per input. Calling `flow(...)` twice creates separate entrypoint pipelines.

## Operators

```ts
channel
    .flow("message") // Flow<{ from, text }>
    .map(m => m.text) // Flow<string>
    .filter(text => text.length > 0) // Flow<string>
    .effect(text => console.log(text)) // terminal — starts everything
```

- **`map(fn)`** — transform each value.
- **`filter(predicate)`** — keep values that pass. With a type guard it narrows the type: `filter((x): x is Y => …)` turns a `Flow<X>` into a `Flow<Y>`.
- **`fork(fn)`** — eagerly create joined child runs from the returned values.
- **`detach()`** — continue downstream work in a detached run.
- **`effect(sink)`** — start the flow, calling `sink` for each value. Terminal; returns nothing.

The `sink` (and `map`/`filter`/`fork` callbacks) may be async — a returned promise is awaited, and a rejection is reported, not swallowed.

Branching from a handle creates multiple outgoing graph edges:

```ts
const messages = channel.flow("message")

messages.map(a).effect(sendA)
messages.map(b).effect(sendB)
```

One incoming `message` creates one root run that waits for both branches.

## Combining and de-duplicating

`combine` attaches several flows of the same type to one shared downstream suffix:

```ts
import { combine } from "@signalbox/core"

combine(pushed, polled).effect(ip => update(ip))
```

Stateful predicates keep state in their closure. `@signalbox/commons` ships the common ones:

```ts
import { dedupeBy, poll, publicIPv4 } from "@signalbox/commons"

const pushed = ctx.plugins.upnp.events.flow("external-ip").map(({ ip }) => ip)
const polled = poll({ ctx, every: 15 * 60 * 1000, probe: publicIPv4 }).map(({ value }) => value)

combine(pushed, polled)
    .filter(dedupeBy(ip => ip)) // forward only when the value changes
    .effect(async ip => {
        if (await ctx.plugins.cloudflare.update(ip)) ctx.log(`updated records to ${ip}`)
    })
```

- **`poll(options)`** produces a flow that probes on startup, on an interval, and on any `retryOn` trigger.
- **`dedupeBy(key)`** is a stateful filter predicate that drops consecutive values with the same key.
- **`publicIPv4()`** resolves the current public IPv4 over HTTP.

## Writing a stateful predicate

Keep state between values in the closure:

```ts
const takeEvery =
    <T>(n: number) => {
        let i = 0
        return (_value: T) => i++ % n === 0
    }

flow.filter(takeEvery(3)).effect(handle)
```

## Next

[Events](events.md) · [Workflows](workflows.md)
