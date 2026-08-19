# Plugins

A **plugin** is an integration. It wraps an external capability — an HTTP server, a Discord connection, a database — and exposes it to your app two ways: things that happen outside arrive as **events**, and the plugin returns an **API** your workflows call. You build one with `definePlugin`.

## Anatomy

```ts
import { definePlugin, type ReadChannel } from "@signalbox/core"
import { connect } from "some-chat-sdk"

type ChatEvents = { message: { from: string; text: string } }

interface ChatApi {
    events: ReadChannel<ChatEvents>
    say: (text: string) => Promise<void>
}

export const chatPlugin = (options: { url: string }) => {
    const client = connect(options.url)

    return definePlugin<ChatApi, ChatEvents>({
        name: "chat",
        init: ctx => {
            client.on("message", ({ from, text }) => ctx.channel.emit("message", { from, text }))
            ctx.onStop(() => client.close())
            return {
                events: ctx.channel,
                say: text => client.send(text),
            }
        },
        setup: () => client.open(), // start receiving only after workflows subscribe
    })
}
```

A plugin is usually a **factory** — a function taking options and returning `definePlugin(...)` — so callers configure it (`chatPlugin({ url })`). Shared state like `client` lives in the factory closure, where both `init` and `setup` can reach it.

## The context

`init` and `setup` receive a `ctx`:

- **`channel`** — the plugin's own typed channel. Emit with `ctx.channel.emit("message", payload)`; expose it to workflows by returning it as `events`, so they subscribe via `ctx.plugins.chat.events`.
- **`log(message, level?)`** / **`fail(error)`** — report under the plugin's scope.
- **`onStart(fn)`** — run once the app has started.
- **`onStop(cleanup)`** — teardown, run in reverse order on stop.
- **`interval(ms, handler)`** — a repeating timer, cleared on stop.

## `init` vs `setup`

- **`init(ctx) => API`** runs first, before workflows are wired. Build and return the API, register handlers and teardown — but don't emit yet: nothing is listening.
- **`setup(ctx)`** is optional and runs after every workflow is wired. This is where you open connections and start emitting, so no event fires before its subscribers exist.

Plugins with no events set their event type to [`NoEvents`](events.md) and never touch `channel`.

## Next

[Workflows](workflows.md) · [Events](events.md) · [Writing a plugin](../guides/writing-a-plugin.md)
