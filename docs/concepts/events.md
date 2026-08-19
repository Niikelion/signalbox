# Events

signalbox is event-based, but you never touch a global event bus. Events travel on typed **channels**: each plugin has its own, and the app has one. A channel's shape is an **event map**.

## Event maps

An event map is a record of event name → payload type:

```ts
type ChatEvents = {
    message: { from: string; text: string }
    typing: { from: string }
}
```

> **Event maps must be `type` aliases, not `interface`s.** An interface has no implicit index signature, so it doesn't satisfy the `EventMap` (`Record<string, unknown>`) constraint. This is the single most common signalbox type error.

Use **`NoEvents`** for a channel that carries nothing — an app with no app-level events, or a plugin that only exposes an API.

## Channels

A channel is the read side plus `emit`:

```ts
channel.emit("message", { from: "a", text: "hi" }) // publish
channel.on("message", ({ from, text }) => { ... }) // subscribe (returns unsubscribe)
channel.once("message", handler) // next occurrence only
channel.off("message", handler) // remove a listener
channel.flow("message") // start a Flow from the event
```

Everything is keyed by event name and fully typed: `emit`'s payload and each listener's argument are inferred from the map.

## Two channels a workflow sees

- **Plugin channels** — a plugin emits on its own channel and exposes it as `events`. Workflows read it via `ctx.plugins.<name>.events`:

  ```ts
  ctx.plugins.chat.events.on("message", m => ctx.plugins.discord.send({ content: m.text }))
  ```

- **The app channel** — `ctx.app`, typed by the app-event parameter of `createWorkflowDefiner`. Workflows both emit and subscribe here to talk to each other.

Plugins reach their own channel as `ctx.channel`; they don't see the app channel.

## Framework events

The framework keeps its own internal channel for `log` and `error`. You produce those through `ctx.log(...)` and `ctx.fail(...)` rather than emitting them directly; the built-in console logger consumes them. You rarely interact with the framework channel by hand.

## From events to pipelines

`channel.flow(event)` turns a stream of one event into a [Flow](flow.md), where you compose with `map`, `filter`, `merge`, and stateful operators — the tool for anything past a single `on` handler.

## Next

[Flow](flow.md) · [Workflows](workflows.md) · [Plugins](plugins.md)
