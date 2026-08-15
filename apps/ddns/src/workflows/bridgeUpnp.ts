import { defineWorkflow } from "../defineWorkflow.js"

export const bridgeUpnp = defineWorkflow("bridge-upnp", (ctx) => {
    ctx.plugins.upnp.events.on("external-ip", ({ ip }) => {
        ctx.app.emit("wan-ip:observed", { ip, source: "upnp" })
    })

    ctx.plugins.upnp.events.on("reconnected", ({ downSeconds }) => {
        ctx.app.emit("wan-ip:recheck", { downSeconds })
    })

    ctx.plugins.upnp.events.on("unavailable", ({ reason }) => {
        ctx.log(`UPnP unavailable: ${reason}`, "warn")
    })
})
