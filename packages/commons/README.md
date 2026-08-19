# @signalbox/commons

Reusable workflow building blocks for signalbox: polling, de-duplication, and public-IP discovery.

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/commons
```

## Usage

```ts
import { poll, dedupe, publicIPv4 } from "@signalbox/commons"

// A Flow that probes on startup and every interval, with optional retry triggers.
poll({
    ctx,
    every: 15 * 60 * 1000,
    probe: () => publicIPv4(),
})
    .apply(dedupe(({ value }) => value)) // drop repeats
    .run(({ value, phase }) => {
        ctx.log(`ip ${value} (${phase})`)
    })
```

- **`poll(options)`** — a `Flow<{ value, phase }>` that emits on startup, on an interval, and on any `retryOn` trigger.
- **`dedupe(keyFn)`** — a `Flow` operator that suppresses consecutive values with the same key.
- **`publicIPv4()`** — resolve the current public IPv4 over HTTP; **`isIPv4(value)`** validates a string.

## License

MIT
