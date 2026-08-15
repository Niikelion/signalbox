import { createApp, definePlugin, createWorkflowDefiner } from "@signalbox/core"

const log = []

const fakePlugin = () =>
    definePlugin({
        name: "fake",
        init: (ctx) => {
            ctx.onStart(() => {
                ctx.channel.emit("ping", { n: 1 })
            })
            ctx.onStop(() => {
                log.push("plugin-stopped")
            })
            return { events: ctx.channel }
        },
    })

const defineW = createWorkflowDefiner()

const app = createApp({
    name: "smoke",
    logging: false,
    plugins: { fake: fakePlugin() },
    workflows: [
        defineW("bridge", (ctx) => {
            ctx.plugins.fake.events.on("ping", ({ n }) => {
                ctx.app.emit("app-event", { n })
            })
        }),
        defineW("listen", (ctx) => {
            ctx.app.on("app-event", ({ n }) => {
                log.push("app-event:" + n)
            })
            ctx.onStart(() => {
                log.push("started")
            })
        }),
    ],
})

await app.start()
await new Promise((r) => setTimeout(r, 30))
await app.stop()
console.log("RESULT " + JSON.stringify(log))
