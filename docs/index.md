# signalbox

## The mental model

- **Plugins** are integrations. Each wraps an external capability — an HTTP server, a Discord connection, a database — and exposes it to your app two ways: activity from outside arrives as **events**, and the plugin hands you an **API** to act back.
- **Workflows** are your logic. Each is a function that reacts to events and operates over the plugins.

Events travel between them on a typed bus, and a strict lifecycle starts everything in order and tears it down in reverse — but you rarely think about either; you write plugins and workflows.

## 60-second start

```bash
npm install @signalbox/core @signalbox/schedule @signalbox/discord
```

```ts
import { createApp, createWorkflowDefiner, type NoEvents, type PluginApis } from "@signalbox/core"
import { schedulePlugin } from "@signalbox/schedule"
import { discordPlugin } from "@signalbox/discord"

const plugins = {
    schedule: schedulePlugin(),
    discord: discordPlugin({ webhookUrl }),
}

const defineWorkflow = createWorkflowDefiner<NoEvents, PluginApis<typeof plugins>>()

const standup = defineWorkflow("standup", ctx => {
    ctx.plugins.schedule.cron("0 9 * * 1-5", {}, () =>
        ctx.plugins.discord.send({ content: "Standup in 15 minutes" }),
    )
})

await createApp({ name: "standup-bot", plugins, workflows: [standup] }).run()
```

A plugin gives you a capability (`schedule`), another delivers output (`discord`), and the workflow wires them together.

## Next

**Concepts** — [Apps](concepts/apps.md) · [Plugins](concepts/plugins.md) · [Workflows](concepts/workflows.md) · [Events](concepts/events.md) · [Flow](concepts/flow.md) · [Config](concepts/config.md)

**Guides** — [Writing a plugin](guides/writing-a-plugin.md) · [Deploying with service-cli](guides/deploying-with-service-cli.md) · [Workflows as data](guides/workflows-as-data.md)
