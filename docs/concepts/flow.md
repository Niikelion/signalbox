# Flow

`Flow<T>` is a lazy push stream — a small pipeline you build on top of an event. It's the tool for anything past a single `on` handler: transforming, filtering, combining, and de-duplicating events.

Two properties define it:

- **Lazy** — nothing runs until `run()`. Building a flow just describes the pipeline.
- **Unicast** — each `run()` re-subscribes to the source. A flow is a recipe, not a shared subscription.

## Operators

```ts
channel
    .flow("message") // Flow<{ from, text }>
    .map(m => m.text) // Flow<string>
    .filter(text => text.length > 0) // Flow<string>
    .run(text => console.log(text)) // terminal — starts everything
```

- **`map(fn)`** — transform each value.
- **`filter(predicate)`** — keep values that pass. With a type guard it narrows the type: `filter((x): x is Y => …)` turns a `Flow<X>` into a `Flow<Y>`.
- **`apply(operator)`** — run a stateful operator (see below).
- **`run(sink)`** — start the flow, calling `sink` for each value. Terminal; returns nothing.

The `sink` (and `map`/`filter` callbacks) may be async — a returned promise is awaited, and a rejection is reported, not swallowed.

## Combining and de-duplicating

`merge` interleaves several flows of the same type into one:

```ts
import { merge } from "@signalbox/core"

merge(pushed, polled).run(ip => update(ip))
```

Stateful transforms are **operators** — `(emit) => (value) => …`, with state in the closure — applied with `.apply()`. `@signalbox/commons` ships the common ones:

```ts
import { poll, dedupe, publicIPv4 } from "@signalbox/commons"

const pushed = ctx.plugins.upnp.events.flow("external-ip").map(({ ip }) => ip)
const polled = poll({ ctx, every: 15 * 60 * 1000, probe: publicIPv4 }).map(({ value }) => value)

merge(pushed, polled)
    .apply(dedupe()) // forward only when the value changes
    .run(async ip => {
        if (await ctx.plugins.cloudflare.update(ip)) ctx.log(`updated records to ${ip}`)
    })
```

- **`poll(options)`** produces a flow that probes on startup, on an interval, and on any `retryOn` trigger.
- **`dedupe(key?)`** is an operator that drops consecutive values with the same key (identity by default).
- **`publicIPv4()`** resolves the current public IPv4 over HTTP.

## Writing an operator

An operator receives the downstream `emit` and returns a per-value step; keep state between values in the closure:

```ts
import type { Operator } from "@signalbox/core"

const takeEvery =
    <T>(n: number): Operator<T, T> =>
    emit => {
        let i = 0
        return value => {
            if (i++ % n === 0) emit(value)
        }
    }

flow.apply(takeEvery(3)).run(handle)
```

## Next

[Events](events.md) · [Workflows](workflows.md)
